#!/usr/bin/env bash
# Brings up the audio server the browser adapter needs, then hands off.
#
# Xvfb is deliberately NOT started here — the adapter owns the display
# lifecycle (see xvfb.ts) so it can pick a free display number and tear it down
# with the meeting. Starting one here as well would leave an orphan.
set -euo pipefail

log() { printf '\033[1m[entrypoint]\033[0m %s\n' "$*"; }

if command -v pulseaudio >/dev/null 2>&1; then
  # --exit-idle-time=-1: PulseAudio quits after 20s idle by default, and there
  # is no client attached until the first meeting starts. Without this the
  # daemon is reliably gone by the time it is needed.
  pulseaudio --start --exit-idle-time=-1 --disallow-exit --log-target=stderr 2>/dev/null || true

  for _ in $(seq 1 20); do
    if pactl info >/dev/null 2>&1; then break; fi
    sleep 0.25
  done

  if pactl info >/dev/null 2>&1; then
    log "PulseAudio ready ($(pactl info | awk -F': ' '/Server Name/{print $2}'))"
  else
    # Not fatal: the simulated local room needs no audio at all, so failing
    # here would block the one mode that definitely works in this container.
    log "WARNING: PulseAudio did not come up — audio platforms will fail preflight"
  fi
else
  log "WARNING: pulseaudio not installed"
fi

exec "$@"
