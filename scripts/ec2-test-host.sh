#!/usr/bin/env bash
#
# Launch a disposable Linux host to test whether the browser meeting adapter
# behaves differently with a real camera.
#
# WHY THIS EXISTS
# ---------------
# On Docker Desktop / WSL2 the bot has a microphone but NO camera: v4l2loopback
# needs a kernel module the WSL2 kernel does not carry, and Chrome's
# `--use-file-for-fake-video-capture` does nothing without its companion flag.
# Zoom and Google Meet both refused to admit her in that state — Zoom explicitly
# calling her a bot. Whether that refusal was about automation or about a
# participant with no camera at all is UNRESOLVED, and this host is how to find
# out. Ordinary Linux can load v4l2loopback; WSL2 cannot.
#
# COST
# ----
# t3.medium is roughly $0.05/hour. Cheap, but it bills until terminated.
# `./scripts/ec2-test-host.sh down` when you are done — and the script tags
# everything so you can find it if you forget.
#
# CREDENTIALS
# -----------
# Uses whatever the AWS CLI already has. Nothing is read, written or logged by
# this script: configure with `aws configure --profile lily` and pass
# AWS_PROFILE=lily.
#
# Usage:
#   ./scripts/ec2-test-host.sh up        launch + provision + upload the repo
#   ./scripts/ec2-test-host.sh status    what is running, and what it cost so far
#   ./scripts/ec2-test-host.sh ssh       shell in
#   ./scripts/ec2-test-host.sh tunnel    forward the meeting room to localhost:4100
#   ./scripts/ec2-test-host.sh down      TERMINATE and delete the security group
set -euo pipefail

# Git Bash / MSYS on Windows rewrites any argument that *looks* like a Unix path
# into a Windows path before the process sees it. That silently corrupts AWS
# arguments — `/dev/sda1` became `C:/Program Files/Git/dev/sda1`, and an SSM
# parameter name became a filesystem path — producing AWS validation errors that
# read as service problems and are not. Disabling it here fixes the whole class
# rather than one argument at a time. Both variables are ignored on Linux/macOS.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

NAME="${LILY_EC2_NAME:-lily-browser-test}"
INSTANCE_TYPE="${LILY_EC2_TYPE:-t3.medium}"
KEY_NAME="${LILY_EC2_KEY:-$NAME-key}"
KEY_FILE="${LILY_EC2_KEY_FILE:-$HOME/.ssh/$KEY_NAME.pem}"
REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo eu-central-1)}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[31merror: %s\033[0m\n\n' "$*" >&2; exit 1; }

command -v aws >/dev/null || die "The AWS CLI is not installed."
aws sts get-caller-identity >/dev/null 2>&1 || die "AWS credentials are not configured. Run: aws configure"

find_instance() {
  aws ec2 describe-instances --region "$REGION" \
    --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[0].InstanceId' --output text 2>/dev/null | tr -d '\r' | head -1
}

public_ip() {
  aws ec2 describe-instances --region "$REGION" --instance-ids "$1" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' --output text 2>/dev/null | tr -d '\r'
}

# ---------------------------------------------------------------------------
# Provisioning, run on the instance at first boot.
#
# Deliberately does NOT run the bot. It prepares the host and stops, so the
# first meeting attempt is something you watch rather than something that
# already happened in a log.
# ---------------------------------------------------------------------------
user_data() {
  cat <<'CLOUDINIT'
#!/usr/bin/env bash
set -euxo pipefail
exec > >(tee -a /var/log/lily-setup.log) 2>&1

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg git ffmpeg \
  "linux-headers-$(uname -r)" v4l2loopback-dkms v4l2loopback-utils v4l-utils

# The whole point of this host. exclusive_caps=1 makes the device advertise
# itself as a capture device, which is what Chrome requires to enumerate it.
modprobe v4l2loopback devices=1 video_nr=0 card_label="Lily Camera" exclusive_caps=1

# Survive a reboot.
echo v4l2loopback > /etc/modules-load.d/lily.conf
echo 'options v4l2loopback devices=1 video_nr=0 card_label="Lily Camera" exclusive_caps=1' \
  > /etc/modprobe.d/lily-v4l2loopback.conf

curl -fsSL https://get.docker.com | sh
usermod -aG docker ubuntu
# `video` too, not just `docker`. /dev/video0 is root:video 0660, so without
# this every v4l2-ctl on the host is "Permission denied" — which reads as a
# broken device and is a group membership. The container needs the same thing
# spelled `--group-add`, since it runs as uid 1000.
usermod -aG video ubuntu

# A marker `up` polls for, so it waits for readiness rather than a fixed sleep.
if [ -e /dev/video0 ]; then
  echo "READY camera=/dev/video0" > /var/lib/lily-setup-status
else
  echo "READY camera=MISSING" > /var/lib/lily-setup-status
fi
CLOUDINIT
}

cmd_up() {
  local existing; existing="$(find_instance)"
  [ -n "$existing" ] && [ "$existing" != "None" ] && die "Already running: $existing. Use 'ssh', or 'down' first."

  say "Region $REGION, type $INSTANCE_TYPE"

  # Key pair
  if [ ! -f "$KEY_FILE" ]; then
    say "Creating key pair $KEY_NAME"
    aws ec2 delete-key-pair --region "$REGION" --key-name "$KEY_NAME" >/dev/null 2>&1 || true
    mkdir -p "$(dirname "$KEY_FILE")"
    aws ec2 create-key-pair --region "$REGION" --key-name "$KEY_NAME" \
      --query 'KeyMaterial' --output text > "$KEY_FILE"
    chmod 600 "$KEY_FILE"
    info "Private key: $KEY_FILE"
  else
    info "Reusing key $KEY_FILE"
  fi

  # Security group — SSH from THIS machine only. Never 0.0.0.0/0: this host runs
  # a browser and will hold meeting credentials.
  local my_ip sg
  my_ip="$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')"
  sg="$(aws ec2 describe-security-groups --region "$REGION" \
        --filters "Name=group-name,Values=$NAME-sg" \
        --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null | tr -d '\r')"

  if [ -z "$sg" ] || [ "$sg" = "None" ]; then
    say "Creating security group (SSH from $my_ip only)"
    sg="$(aws ec2 create-security-group --region "$REGION" --group-name "$NAME-sg" \
          --description "Lily browser adapter test host" --query 'GroupId' --output text | tr -d '\r')"
  fi
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$sg" \
    --protocol tcp --port 22 --cidr "$my_ip/32" >/dev/null 2>&1 || true

  # Newest Ubuntu 24.04 LTS published by Canonical (owner 099720109477), rather
  # than a hard-coded AMI id, which rots and differs per region.
  #
  # Queried with describe-images rather than the SSM parameter path. The SSM
  # route is tidier but its argument starts with `/aws/...`, and Git Bash on
  # Windows rewrites that into a filesystem path before the CLI ever sees it —
  # producing a ValidationException that reads as an AWS problem and is not one.
  # This has no leading-slash argument, so it behaves the same on every shell.
  local ami
  ami="$(aws ec2 describe-images --region "$REGION" --owners 099720109477 \
    --filters 'Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*' \
              'Name=state,Values=available' \
    --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text | tr -d '\r')"
  [ -n "$ami" ] && [ "$ami" != "None" ] || die "Could not resolve an Ubuntu 24.04 AMI in $REGION."
  info "AMI $ami"

  say "Launching"
  local id
  id="$(aws ec2 run-instances --region "$REGION" \
    --image-id "$ami" --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_NAME" --security-group-ids "$sg" \
    --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=20,VolumeType=gp3,DeleteOnTermination=true}' \
    --metadata-options 'HttpTokens=required' \
    --user-data "$(user_data)" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=lily:purpose,Value=browser-adapter-test},{Key=lily:ephemeral,Value=true}]" \
    --query 'Instances[0].InstanceId' --output text | tr -d '\r')"
  info "Instance $id"

  say "Waiting for the instance to run"
  aws ec2 wait instance-running --region "$REGION" --instance-ids "$id"
  local ip; ip="$(public_ip "$id")"
  info "Public IP $ip"

  say "Waiting for provisioning (installs a kernel module and Docker — a few minutes)"
  local ssh_opts=(-i "$KEY_FILE" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)
  local status=""
  for _ in $(seq 1 60); do
    status="$(ssh "${ssh_opts[@]}" "ubuntu@$ip" 'cat /var/lib/lily-setup-status 2>/dev/null' 2>/dev/null || true)"
    [ -n "$status" ] && break
    printf '.'
    sleep 15
  done
  printf '\n'
  [ -n "$status" ] || die "Provisioning did not finish. Check: ssh -i $KEY_FILE ubuntu@$ip 'tail -50 /var/log/lily-setup.log'"
  info "$status"

  case "$status" in
    *camera=/dev/video0*) info "v4l2loopback loaded — this is the thing WSL2 could not do." ;;
    *) info "WARNING: no /dev/video0. Check /var/log/lily-setup.log before trusting any result." ;;
  esac

  say "Uploading the repo"
  # node_modules and dist are excluded because they are rebuilt on the host, and
  # shipping them would send Windows-built native modules to a Linux box.
  #
  # The secret exclusions matter more. `tar` does not honour .gitignore, so
  # without these the local signing key, token pepper and Mongo URI in
  # .env.local would be copied to a cloud host that does not need them — this
  # instance only ever joins a test meeting. The build needs none of it.
  tar --exclude=node_modules --exclude=dist --exclude=.git --exclude=tmp \
      --exclude='*.tsbuildinfo' --exclude=.aws-sam \
      --exclude='.env' --exclude='.env.local' --exclude='.env.*.local' \
      --exclude='.lily-local' --exclude='*.pem' --exclude='*.key' --exclude='*.p12' \
      -czf /tmp/lily-src.tgz -C "$REPO_ROOT" .
  scp "${ssh_opts[@]}" /tmp/lily-src.tgz "ubuntu@$ip:~/" >/dev/null
  ssh "${ssh_opts[@]}" "ubuntu@$ip" 'mkdir -p ~/lily && tar -xzf ~/lily-src.tgz -C ~/lily && rm ~/lily-src.tgz'
  rm -f /tmp/lily-src.tgz
  info "Extracted to ~/lily"

  # The gid of `video` on the instance, for the --group-add in the hints below.
  # Read rather than hard-coded to 44: it is stable on Ubuntu but a wrong guess
  # here fails as "Chrome sees no camera", which is a long way from the cause.
  local VIDEO_GID
  VIDEO_GID="$(ssh "${ssh_opts[@]}" "ubuntu@$ip" 'getent group video | cut -d: -f3' | tr -d '\r')"

  say "Building the image (several minutes — it installs Chrome)"
  ssh "${ssh_opts[@]}" "ubuntu@$ip" 'cd ~/lily && docker compose --profile browser build orchestrator' \
    || die "Image build failed. Shell in and look: ./scripts/ec2-test-host.sh ssh"

  cat <<EOF

  Ready.

    ssh          ./scripts/ec2-test-host.sh ssh
    terminate    ./scripts/ec2-test-host.sh down          <-- it bills until you do

  The image is tagged \`lily-orchestrator:latest\` (docker-compose sets the name).

  --group-add $VIDEO_GID is not optional: the device is root:video 0660 and the
  container runs as uid 1000, so without it ffmpeg cannot open the camera and
  Chrome enumerates none.

  First test — Jitsi, which already works locally. If this fails, the host is
  the problem, not the platform:

    cd ~/lily && docker run --rm --shm-size=1g --cap-add=SYS_ADMIN \\
      --device=/dev/video0 --group-add $VIDEO_GID \\
      -e LILY_VIDEO_MODE=v4l2loopback \\
      -e LILY_MEETING_PLATFORM=jitsi \\
      -e LILY_MEETING_URL="https://meet.jit.si/lily-ec2-\$RANDOM" \\
      lily-orchestrator:latest node orchestrator/dist/main.js

  Then the question this host exists to answer — does she have a camera now:

    docker run --rm --device=/dev/video0 --group-add $VIDEO_GID \\
      lily-orchestrator:latest bash -lc 'v4l2-ctl --list-devices'

  Then retry Zoom and Meet. If either admits her now, the earlier refusals were
  about the missing camera, not about automation.

  If v4l2-ctl ever reports "VIDIOC_G_FMT: Invalid argument", the loopback device
  is wedged — it gets into that state if the writer is restarted while a reader
  still holds it. Reload it rather than debugging the symptom:

    sudo modprobe -r v4l2loopback && sudo modprobe v4l2loopback \\
      devices=1 video_nr=0 card_label="Lily Camera" exclusive_caps=1

EOF
}

cmd_status() {
  local id; id="$(find_instance)"
  if [ -z "$id" ] || [ "$id" = "None" ]; then info "Nothing running."; return; fi
  aws ec2 describe-instances --region "$REGION" --instance-ids "$id" \
    --query 'Reservations[0].Instances[0].[InstanceId,InstanceType,State.Name,PublicIpAddress,LaunchTime]' \
    --output text | awk '{printf "    id=%s type=%s state=%s ip=%s since=%s\n",$1,$2,$3,$4,$5}'
  info "Terminate with: ./scripts/ec2-test-host.sh down"
}

cmd_ssh() {
  local id ip; id="$(find_instance)"
  [ -n "$id" ] && [ "$id" != "None" ] || die "Nothing running. Start with: $0 up"
  ip="$(public_ip "$id")"
  exec ssh -i "$KEY_FILE" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "ubuntu@$ip"
}

cmd_tunnel() {
  local id ip; id="$(find_instance)"
  [ -n "$id" ] && [ "$id" != "None" ] || die "Nothing running. Start with: $0 up"
  ip="$(public_ip "$id")"
  say "Forwarding localhost:4100 -> instance:4100 (Ctrl-C to stop)"
  info "The meeting room will be at http://localhost:4100"
  # Tunnelled rather than opened in the security group: the room needs no
  # authentication, so it must never be reachable from the internet.
  exec ssh -i "$KEY_FILE" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
    -N -L 4100:127.0.0.1:4100 -L 4101:127.0.0.1:4101 "ubuntu@$ip"
}

cmd_down() {
  local id; id="$(find_instance)"
  if [ -z "$id" ] || [ "$id" = "None" ]; then
    info "No instance to terminate."
  else
    say "Terminating $id"
    aws ec2 terminate-instances --region "$REGION" --instance-ids "$id" >/dev/null
    aws ec2 wait instance-terminated --region "$REGION" --instance-ids "$id"
    info "Terminated."
  fi

  # The security group cannot be deleted until the instance is fully gone, which
  # is why this runs after the wait.
  aws ec2 delete-security-group --region "$REGION" --group-name "$NAME-sg" >/dev/null 2>&1 \
    && info "Security group deleted." || true

  info "Key pair kept ($KEY_NAME). Remove with: aws ec2 delete-key-pair --region $REGION --key-name $KEY_NAME"
}

case "${1:-}" in
  up)     cmd_up ;;
  status) cmd_status ;;
  ssh)    cmd_ssh ;;
  tunnel) cmd_tunnel ;;
  down)   cmd_down ;;
  *)
    cat <<EOF
Usage: $0 {up|status|ssh|tunnel|down}

  up       launch a t3.medium, load v4l2loopback, install Docker, upload and build
  status   what is running
  ssh      shell in
  tunnel   forward the meeting room to http://localhost:4100
  down     TERMINATE the instance and delete the security group

Environment:
  AWS_PROFILE          which credentials to use
  AWS_REGION           defaults to your configured region
  LILY_EC2_TYPE        defaults to t3.medium
EOF
    exit 1 ;;
esac
