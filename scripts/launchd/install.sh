#!/usr/bin/env bash
# Install the Feynman Study Hub web app (web/) as a launchd user agent.
# The agent starts at login and restarts on crash. It serves a production
# build bound to 127.0.0.1.
#
# Usage: scripts/launchd/install.sh [--dry-run] [--help]
set -euo pipefail

LABEL="com.feynman.studyhub"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/$LABEL.plist.template"
if ! WEB_DIR="$(cd "$SCRIPT_DIR/../../web" 2>/dev/null && pwd)"; then
  WEB_DIR=""
fi
LOG_DIR="$HOME/Library/Logs/feynman-studyhub"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

usage() {
  cat <<'EOF'
Usage: scripts/launchd/install.sh [--dry-run] [--help]

Installs the Feynman Study Hub web app as a launchd user agent that starts
at login and restarts on crash. Builds web/ for production and serves it on
127.0.0.1 at http://localhost:$PORT (default 3000).

Options:
  --dry-run  Run the read-only checks, print the rendered plist and the
             commands that would run. Builds nothing, writes nothing and
             does not call launchctl.
  --help     Show this message.

Environment:
  PORT       Port to serve on: an integer from 1 to 65535 (default 3000).
EOF
}

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

FAILURES=0
pass() { printf '  [ok]   %s\n' "$1"; }
fail() { printf '  [FAIL] %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

# XML-escape, then sed-escape, so that paths containing &, <, >, | or \ cannot
# break the plist or the sed expression.
xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
sed_escape() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }

render_plist() {
  local node web port log path
  node="$(sed_escape "$(xml_escape "$NODE")")"
  web="$(sed_escape "$(xml_escape "$WEB_DIR")")"
  port="$(sed_escape "$(xml_escape "$PORT")")"
  log="$(sed_escape "$(xml_escape "$LOG_DIR")")"
  path="$(sed_escape "$(xml_escape "$PATH_VALUE")")"
  sed \
    -e "s|__NODE__|$node|g" \
    -e "s|__WEB_DIR__|$web|g" \
    -e "s|__PORT__|$port|g" \
    -e "s|__LOG_DIR__|$log|g" \
    -e "s|__PATH__|$path|g" \
    "$TEMPLATE"
}

echo "Checks:"

NODE="$(command -v node || true)"
if [ -n "$NODE" ]; then
  pass "node found: $NODE"
else
  fail "node not found on PATH. Install Node.js (or load your shell profile) and retry."
  if [ "$DRY_RUN" -eq 0 ]; then
    echo "Aborting: node is required." >&2
    exit 1
  fi
fi

if [ -n "$WEB_DIR" ] && [ -f "$WEB_DIR/package.json" ]; then
  pass "web app found: $WEB_DIR"
else
  fail "web app not found next to scripts/launchd (expected web/package.json two levels up)."
fi

if [ -f "$TEMPLATE" ]; then
  pass "plist template found"
else
  fail "plist template missing: $TEMPLATE"
fi

if [ -n "$WEB_DIR" ] && [ -f "$WEB_DIR/.env" ]; then
  pass "web/.env exists (contents not read). The app needs APP_PASSCODE and the Gemini key GOOGLE_API_KEY set there."
else
  fail "web/.env is missing. Create it from web/.env.example and set APP_PASSCODE and GOOGLE_API_KEY."
fi

if [ -n "$WEB_DIR" ] && [ -d "$WEB_DIR/node_modules" ]; then
  pass "web/node_modules exists"
else
  fail "web/node_modules is missing. Run 'npm install' in web/ first."
fi

if [ -n "$WEB_DIR" ] && [ -f "$WEB_DIR/node_modules/next/dist/bin/next" ]; then
  pass "next binary found"
else
  fail "next binary missing at web/node_modules/next/dist/bin/next. Run 'npm install' in web/."
fi

PORT="${PORT:-3000}"
PORT_OK=0
if [[ "$PORT" =~ ^[0-9]+$ ]] && (( 10#$PORT >= 1 && 10#$PORT <= 65535 )); then
  PORT=$((10#$PORT))
  PORT_OK=1
  pass "port $PORT is a valid port number"
else
  fail "PORT must be an integer from 1 to 65535 (got: $PORT)."
fi

if [ "$PORT_OK" -eq 1 ]; then
  if ! command -v lsof >/dev/null 2>&1; then
    fail "lsof not found, so the port cannot be checked."
  elif lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "port $PORT is already in use. Stop the dev server (npm run dev) or uninstall the old service (scripts/launchd/uninstall.sh) first."
  else
    pass "port $PORT is free"
  fi
fi

PATH_VALUE="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
if [ -n "$NODE" ]; then
  PATH_VALUE="$(dirname "$NODE"):$PATH_VALUE"
fi

if [ "$FAILURES" -gt 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  echo "Aborting: $FAILURES check(s) failed. Nothing was built or installed." >&2
  exit 1
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo
  echo "----- BEGIN RENDERED PLIST (dry run, not written) -----"
  if [ -f "$TEMPLATE" ]; then
    render_plist
  fi
  echo "----- END RENDERED PLIST -----"
  echo
  UID_NUM="$(id -u)"
  echo "Commands that a real install would run (none were run):"
  echo "  (cd \"$WEB_DIR\" && npm run build)"
  echo "  mkdir -p \"$LOG_DIR\" \"$HOME/Library/LaunchAgents\""
  echo "  render the template above into \"$PLIST_DEST\""
  echo "  plutil -lint \"$PLIST_DEST\""
  echo "  launchctl bootout gui/$UID_NUM/$LABEL  (errors ignored)"
  echo "  launchctl bootstrap gui/$UID_NUM \"$PLIST_DEST\""
  echo "  launchctl print gui/$UID_NUM/$LABEL | head -20"
  echo
  if [ "$FAILURES" -gt 0 ]; then
    echo "Dry run: $FAILURES check(s) failed. A real install would stop before building."
    exit 1
  fi
  echo "Dry run: all checks passed. Nothing was built or installed."
  exit 0
fi

UID_NUM="$(id -u)"

echo
echo "Building the production app (npm run build in $WEB_DIR)..."
(cd "$WEB_DIR" && npm run build)

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
render_plist > "$PLIST_DEST"
plutil -lint "$PLIST_DEST"

launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST_DEST"

echo
launchctl print "gui/$UID_NUM/$LABEL" 2>/dev/null | head -20 || true
echo
echo "Service installed and started."
echo "  URL:       http://localhost:$PORT"
echo "  Logs:      $LOG_DIR/out.log and $LOG_DIR/err.log"
echo "  Uninstall: $SCRIPT_DIR/uninstall.sh"
