#!/bin/bash
# Install (or remove) the macOS LaunchAgent that runs scripts/sync-publish.sh every 6 hours
# (05:45, 11:45, 17:45, 23:45 local time). If the Mac is asleep at a slot, launchd runs the
# job once on wake.
#
#   bash scripts/install-sync-agent.sh             # install / update + run once now
#   bash scripts/install-sync-agent.sh --uninstall # remove
#   tail -f ~/Library/Logs/ap-gis-grid-sync.log    # watch
set -euo pipefail

LABEL="com.gsuryaias.ap-gis-grid.sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/ap-gis-grid-sync.log"
# Keep a stable copy of the publisher outside the repo working tree so editing/switching branches
# here never changes what the agent runs.
BIN_DIR="$HOME/.ap-gis-grid-sync-bin"
SRC="$(cd "$(dirname "$0")" && pwd)/sync-publish.sh"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL. (Sync clone ~/.ap-gis-grid-sync and $BIN_DIR left in place — delete if unwanted.)"
  exit 0
fi

mkdir -p "$BIN_DIR" "$(dirname "$PLIST")" "$(dirname "$LOG")"
cp "$SRC" "$BIN_DIR/sync-publish.sh"
chmod +x "$BIN_DIR/sync-publish.sh"

slots=""
for h in 5 11 17 23; do
  slots+="<dict><key>Hour</key><integer>$h</integer><key>Minute</key><integer>45</integer></dict>"
done

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$BIN_DIR/sync-publish.sh</string></array>
  <key>StartCalendarInterval</key><array>$slots</array>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $LABEL → runs 05:45 / 11:45 / 17:45 / 23:45. Log: $LOG"
if [ "${1:-}" != "--no-run" ]; then
  launchctl kickstart "gui/$(id -u)/$LABEL"
  echo "Started a first run now (see the log)."
fi
