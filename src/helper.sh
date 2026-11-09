#!/bin/sh
# Restart watchdog helper for macOS and Linux.
#
# The chain mirrors the Windows helper: show the watchdog window, stop the app,
# start it again and let the shared recovery script decide whether the boot is
# healthy. Placeholders (@NAME@) are filled in when the file is written.

LOG='@LOG@'
NODE='@NODE@'
RECOVERY='@RECOVERY@'
LAUNCHER='@LAUNCHER@'
EXE='@EXE@'
APP_PID=@APP_PID@
TIMEOUT=@TIMEOUT@
DELAY_SECONDS=@DELAY@
OVERLAY_PID=""

log() {
  echo "$(date +%Y-%m-%dT%H:%M:%S%z) $1" >> "$LOG"
}

start_app() {
  if [ "$(uname)" = "Darwin" ]; then
    open -a "$EXE"
  else
    "$EXE" >/dev/null 2>&1 &
  fi
  log started
}

kill_app() {
  kill -TERM "$APP_PID" 2>/dev/null
  sleep 2
}

finish() {
  log "verdict: $1"
  "$NODE" "$RECOVERY" done "$1" "$2"
  if [ -n "$OVERLAY_PID" ]; then
    kill "$OVERLAY_PID" 2>/dev/null
  fi
  exit 0
}

log "watchdog start"
"$NODE" "$RECOVERY" state restart
if [ -x "$LAUNCHER" ]; then
  "$LAUNCHER" >/dev/null 2>&1 &
  OVERLAY_PID=$!
fi
sleep "$DELAY_SECONDS"
kill_app
start_app
if "$NODE" "$RECOVERY" wait now "$TIMEOUT"; then
  log healthy
  finish ok ok
fi

log "boot is not healthy: rollback"
"$NODE" "$RECOVERY" state rollback
"$NODE" "$RECOVERY" rollback
kill_app
start_app
if "$NODE" "$RECOVERY" wait now "$TIMEOUT"; then
  log "healthy after rollback"
  "$NODE" "$RECOVERY" mark-good
  finish fail recovered
fi

log "still failing: safe mode"
"$NODE" "$RECOVERY" state safe-mode
"$NODE" "$RECOVERY" safe
kill_app
start_app
if "$NODE" "$RECOVERY" wait now "$TIMEOUT"; then
  log "booted in safe mode"
  finish fail failed
fi

log "safe mode did not boot either"
finish fail failed
