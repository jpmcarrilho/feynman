#!/usr/bin/env bash
# Stop and remove the Feynman Study Hub launchd user agent.
# Logs are kept in ~/Library/Logs/feynman-studyhub.
#
# Usage: scripts/launchd/uninstall.sh [--help]
set -euo pipefail

LABEL="com.feynman.studyhub"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/feynman-studyhub"

usage() {
  cat <<'EOF'
Usage: scripts/launchd/uninstall.sh [--help]

Stops the Feynman Study Hub launchd agent and removes its plist from
~/Library/LaunchAgents. Logs are kept.

Options:
  --help     Show this message.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

stopped=0
if launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null; then
  stopped=1
  echo "Stopped the running service ($LABEL)."
fi

removed=0
if [ -e "$PLIST_DEST" ]; then
  rm -f "$PLIST_DEST"
  removed=1
  echo "Removed $PLIST_DEST"
fi

if [ "$stopped" -eq 0 ] && [ "$removed" -eq 0 ]; then
  echo "Nothing to uninstall: $LABEL is not loaded and no plist exists at $PLIST_DEST."
fi

echo "Logs were kept in $LOG_DIR. Delete that folder yourself if you no longer need them."
