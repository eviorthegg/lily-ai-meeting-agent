#!/usr/bin/env bash
#
# Provision a Linux host for the browser meeting adapter.
#
# =============================================================================
# WHAT THIS BUILDS, AND WHY EACH PIECE IS HERE
# =============================================================================
# The adapter joins meetings by driving a real, headful Google Chrome. On a
# server that means supplying, by hand, the four things a laptop has for free:
#
#   Xvfb                a screen for Chrome to render into. Headless Chrome is
#                       detected — by Google Meet especially — so it is not an
#                       option, and a browser with nowhere to draw will not start.
#   PulseAudio          a sound card. Two null sinks per meeting: one Chrome
#                       renders the room into (captured through its .monitor),
#                       one Lily's speech is played into and remapped to a
#                       source Chrome selects as its microphone.
#   Google Chrome       the *branded* build, from Google's own repository.
#                       Chromium works for Jitsi and mostly works elsewhere, but
#                       Meet gates behaviour on the branded build and its user
#                       agent. playwright-core downloads no browsers precisely
#                       so this one is the one that gets used.
#   ffmpeg              turns rendered avatar frames into a video device, so
#                       Lily has a camera tile that shows live status. Optional:
#                       without it the adapter falls back to a static y4m card.
#
# v4l2loopback is installed when the kernel headers allow it. It is the
# difference between a live avatar and a static one, and nothing else.
#
# =============================================================================
# RUNNING IT
# =============================================================================
#   sudo ./provision-browser-host.sh              # install everything
#   sudo ./provision-browser-host.sh --verify     # check an existing host
#   sudo LILY_USER=lily ./provision-browser-host.sh
#
# Written for Packer/AMI builds: root, non-interactive, idempotent, and it exits
# non-zero on any failure so a broken image never ships.
#
# Debian/Ubuntu. Amazon Linux and RHEL need different package names and a
# different Chrome repository; that is a fork of this file, not a flag on it.
#
# =============================================================================
# THIS DOES NOT RUN ON THE WINDOWS DEV MACHINE
# =============================================================================
# None of it exists there. On Windows, the simulated local room is the test
# path: LILY_MEETING_PLATFORM=local. See orchestrator/README.md.
# =============================================================================

set -euo pipefail

LILY_USER="${LILY_USER:-lily}"
VERIFY_ONLY=0
[ "${1:-}" = "--verify" ] && VERIFY_ONLY=1

log()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m    warning: %s\033[0m\n' "$*"; }
die()  { printf '\033[31m    error: %s\033[0m\n' "$*" >&2; exit 1; }

# -----------------------------------------------------------------------------
# Verification — also the last step of an install, so a green install means a
# host that actually works rather than one where every apt command succeeded.
# -----------------------------------------------------------------------------
verify() {
  local failed=0

  log "Verifying"

  for binary in Xvfb pactl parec pacat; do
    if command -v "$binary" >/dev/null 2>&1; then
      printf '    ok       %s\n' "$binary"
    else
      printf '    MISSING  %s\n' "$binary"; failed=1
    fi
  done

  if command -v ffmpeg >/dev/null 2>&1; then
    printf '    ok       ffmpeg\n'
  else
    warn 'ffmpeg absent — the avatar will be a static card rather than live status'
  fi

  local chrome=''
  for candidate in /usr/bin/google-chrome-stable /usr/bin/google-chrome /usr/bin/chromium; do
    [ -x "$candidate" ] && { chrome="$candidate"; break; }
  done
  if [ -n "$chrome" ]; then
    printf '    ok       %s (%s)\n' "$chrome" "$("$chrome" --version 2>/dev/null || echo 'version unknown')"
    case "$chrome" in
      *chromium*) warn 'this is Chromium, not Google Chrome. Meet may behave differently.' ;;
    esac
  else
    printf '    MISSING  google-chrome-stable\n'; failed=1
  fi

  if [ -e /dev/video0 ] || [ -e /dev/video10 ]; then
    printf '    ok       v4l2loopback device present\n'
  else
    warn 'no v4l2loopback device — static avatar card only'
  fi

  # A PulseAudio daemon the service user can actually reach. `pactl info`
  # failing here is the single most common cause of a bot that joins and is
  # then silent in both directions.
  if id -u "$LILY_USER" >/dev/null 2>&1; then
    local uid; uid="$(id -u "$LILY_USER")"
    if sudo -u "$LILY_USER" XDG_RUNTIME_DIR="/run/user/${uid}" pactl info >/dev/null 2>&1; then
      printf '    ok       PulseAudio reachable as %s\n' "$LILY_USER"
    else
      printf '    MISSING  PulseAudio is not reachable as %s\n' "$LILY_USER"
      printf '             the orchestrator must run as this user with XDG_RUNTIME_DIR=/run/user/%s\n' "$uid"
      failed=1
    fi
  else
    printf '    MISSING  user %s does not exist\n' "$LILY_USER"; failed=1
  fi

  [ "$failed" -eq 0 ] || die 'host is not ready — see MISSING above'
  log "Host is ready for the browser meeting adapter"
}

if [ "$VERIFY_ONLY" -eq 1 ]; then
  verify
  exit 0
fi

[ "$(id -u)" -eq 0 ] || die 'run as root (Packer provisioners already do)'

# -----------------------------------------------------------------------------
log "Installing packages"
# -----------------------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update -y

apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg \
  xvfb x11-xserver-utils \
  pulseaudio pulseaudio-utils \
  ffmpeg \
  dbus-user-session \
  fonts-liberation fonts-noto-color-emoji

# Fonts are not cosmetic here. A meeting client with no fonts renders boxes,
# and the participant names this adapter reads out of the DOM come back as
# boxes with them — which is an unidentified speaker, which denies everything.

# -----------------------------------------------------------------------------
log "Installing Google Chrome (branded, from Google's repository)"
# -----------------------------------------------------------------------------
if [ ! -x /usr/bin/google-chrome-stable ]; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg
  chmod 0644 /etc/apt/keyrings/google-chrome.gpg
  echo 'deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main' \
    > /etc/apt/sources.list.d/google-chrome.list
  apt-get update -y
  apt-get install -y google-chrome-stable
else
  printf '    already installed\n'
fi

# Chrome auto-updates itself through apt. That is a vendor pushing a new UI onto
# a fleet on their schedule, which is exactly the class of change that breaks
# selectors. Pin it and roll it forward deliberately.
apt-mark hold google-chrome-stable || warn 'could not hold google-chrome-stable'

# -----------------------------------------------------------------------------
log "Installing v4l2loopback (optional — live avatar video)"
# -----------------------------------------------------------------------------
if apt-get install -y --no-install-recommends v4l2loopback-dkms v4l2loopback-utils \
     "linux-headers-$(uname -r)" 2>/dev/null; then
  cat > /etc/modprobe.d/lily-v4l2loopback.conf <<'EOF'
# One virtual camera for Lily. exclusive_caps=1 makes Chrome accept it as a
# real webcam rather than ignoring it.
options v4l2loopback devices=1 video_nr=0 card_label="Lily Camera" exclusive_caps=1
EOF
  echo v4l2loopback > /etc/modules-load.d/lily-v4l2loopback.conf
  modprobe v4l2loopback devices=1 video_nr=0 card_label="Lily Camera" exclusive_caps=1 \
    || warn 'v4l2loopback did not load now; it will load on next boot'
else
  warn 'v4l2loopback unavailable (kernel headers missing?) — static avatar card only'
fi

# -----------------------------------------------------------------------------
log "Creating the service user"
# -----------------------------------------------------------------------------
if ! id -u "$LILY_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /usr/sbin/nologin "$LILY_USER"
fi
# The camera and the sound card are both group-owned devices.
usermod -aG audio,video "$LILY_USER" || true

LILY_UID="$(id -u "$LILY_USER")"

# -----------------------------------------------------------------------------
log "Configuring PulseAudio for a headless service user"
# -----------------------------------------------------------------------------
# Per-user daemon under systemd, with lingering enabled so it starts at boot
# without anyone logging in. The alternative — PulseAudio's system mode — is
# discouraged upstream and shares one sound server between everything on the
# box, which for a host that may run several meetings is exactly wrong.
#
# The orchestrator must run as this user with XDG_RUNTIME_DIR set, or `pactl`
# will not find the daemon and both audio directions will silently do nothing.
loginctl enable-linger "$LILY_USER" || warn 'could not enable linger; PulseAudio may not autostart'

install -d -o "$LILY_USER" -g "$LILY_USER" -m 0755 "/home/${LILY_USER}/.config/pulse"
cat > "/home/${LILY_USER}/.config/pulse/client.conf" <<'EOF'
# The daemon is started by systemd, not on demand by the first client: an
# autospawn race between parec and pacat produces two half-configured servers.
autospawn = no
EOF
cat > "/home/${LILY_USER}/.config/pulse/daemon.conf" <<'EOF'
# No hardware to detect on this host, and detection costs seconds at start.
exit-idle-time = -1
flat-volumes = no
default-sample-format = s16le
default-sample-rate = 24000
alternate-sample-rate = 48000
default-sample-channels = 1
EOF
chown -R "$LILY_USER:$LILY_USER" "/home/${LILY_USER}/.config/pulse"

systemctl --machine="${LILY_USER}@.host" --user enable --now pulseaudio.socket pulseaudio.service \
  2>/dev/null || warn 'could not enable the user PulseAudio units; check with --verify'

# -----------------------------------------------------------------------------
log "Writing the environment fragment"
# -----------------------------------------------------------------------------
# Source this from the orchestrator's systemd unit. Getting XDG_RUNTIME_DIR
# wrong is the most common way this host looks fine and produces a silent bot.
cat > /etc/lily-browser.env <<EOF
XDG_RUNTIME_DIR=/run/user/${LILY_UID}
PULSE_RUNTIME_PATH=/run/user/${LILY_UID}/pulse
LILY_CHROME_PATH=/usr/bin/google-chrome-stable
# Debug artefacts from a failed join land here: a screenshot and the page HTML.
# They are meeting content. Set a retention policy on this directory.
LILY_BROWSER_DEBUG_DIR=/var/log/lily/browser-debug
EOF
install -d -o "$LILY_USER" -g "$LILY_USER" -m 0750 /var/log/lily/browser-debug

cat > /etc/logrotate.d/lily-browser-debug <<'EOF'
# Join-failure screenshots and page HTML are meeting content. They exist to fix
# a selector, not to accumulate.
/var/log/lily/browser-debug/*.png /var/log/lily/browser-debug/*.html {
    daily
    rotate 3
    missingok
    notifempty
    nocompress
}
EOF

verify
