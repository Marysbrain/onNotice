#!/bin/bash
# Install the worker bee as a background launch agent on this Mac.
#
# What it does, in plain terms: it teaches the Mac to start the bee's watch
# loop on its own, keep it running, and start it again after a reboot. It is
# safe to run more than once. It never asks for a password and never uses sudo.
#
# Run it once:   bash install_bee_service.sh
# Turn it off:   bash install_bee_service.sh uninstall
#
# No em dashes anywhere in this file.

set -euo pipefail

LABEL="com.con.bee"
HERE="$(cd "$(dirname "$0")" && pwd)"
BEEPY="$HERE/bee.py"
TEMPLATE="$HERE/com.con.bee.plist"

LA_DIR="$HOME/Library/LaunchAgents"
PLIST="$LA_DIR/$LABEL.plist"
LOG_DIR="$HOME/bee/log"

# Find a python3. Prefer the one on PATH, fall back to the usual locations.
PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
    for cand in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
        if [ -x "$cand" ]; then PY="$cand"; break; fi
    done
fi
if [ -z "$PY" ]; then
    echo "Could not find python3 on this Mac. Install it, then run this again."
    exit 1
fi

# Uninstall path: unload and remove, then stop.
if [ "${1:-}" = "uninstall" ]; then
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "The bee background service is removed. It will not start on its own anymore."
    exit 0
fi

if [ ! -f "$BEEPY" ]; then
    echo "Cannot find bee.py next to this script. Expected at: $BEEPY"
    exit 1
fi

mkdir -p "$LA_DIR" "$LOG_DIR"

# Fill the placeholders in the template and write the real plist. Using a
# temp file plus mv so a half written plist never lands in LaunchAgents.
TMP="$(mktemp)"
sed \
    -e "s#__PYTHON__#$PY#g" \
    -e "s#__BEEPY__#$BEEPY#g" \
    -e "s#__WORKDIR__#$HERE#g" \
    -e "s#__LOGDIR__#$LOG_DIR#g" \
    "$TEMPLATE" > "$TMP"
mv "$TMP" "$PLIST"

# Idempotent load: unload any old copy first, then load the fresh one.
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"

echo "The bee is installed and running in the background."
echo "It will start again by itself whenever the Mac restarts."
echo "Logs are in: $LOG_DIR"
echo "To turn it off later, run: bash install_bee_service.sh uninstall"
