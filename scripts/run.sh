#!/usr/bin/env bash
# Starts the Feynman study app so that it works on this Mac and, through Tailscale, on the phone.
#
#   scripts/run.sh            development server (hot reload), the usual way while you are working on the code
#   scripts/run.sh --prod     production build, the quiet way to just study (builds first, takes about a minute)
#   scripts/run.sh --dry-run  show what would run and the addresses, start nothing
#
# What it does for you:
#   - finds this Mac's Tailscale address (https://<name>.ts.net) and passes it to the app as PHONE_ACCESS_HOST. Without it the
#     development server refuses the phone's requests (403 on /_next/*) and the login page does nothing.
#   - binds the app to 127.0.0.1 only; the phone reaches it through `tailscale serve`, never directly.
#   - refuses to start when something else already listens on the port, and tells you what.
# What it does not do: it never changes the Tailscale setup. Switch phone access on with the card on /spaces (or the command printed
# below when it is off). It does not read web/.env, only checks that it exists.
set -euo pipefail

MODE=dev
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --prod) MODE=prod ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "$SCRIPT_DIR/../web" && pwd)"
PORT="${PORT:-3000}"
case "$PORT" in ''|*[!0-9]*) echo "PORT must be a number (got: $PORT)" >&2; exit 2 ;; esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then echo "PORT must be between 1 and 65535 (got: $PORT)" >&2; exit 2; fi

FAILED=0
note() { printf '  %s\n' "$1"; }
problem() { printf '  [problem] %s\n' "$1"; FAILED=1; }

echo "Checks:"
[ -f "$WEB_DIR/package.json" ] || problem "web/package.json not found next to scripts/ (expected $WEB_DIR)"
[ -d "$WEB_DIR/node_modules" ] || problem "web/node_modules is missing: run 'npm install' in web/ first"
[ -f "$WEB_DIR/.env" ] && note "web/.env exists (contents not read)" || problem "web/.env is missing: create it from web/.env.example (APP_PASSCODE and the Gemini key)"
command -v node >/dev/null 2>&1 || problem "node not found on PATH"

# --- Tailscale address ---------------------------------------------------------------------------------------------------
TS_BIN=""
for candidate in "${TAILSCALE_BIN:-}" /Applications/Tailscale.app/Contents/MacOS/Tailscale /usr/local/bin/tailscale /opt/homebrew/bin/tailscale; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then TS_BIN="$candidate"; break; fi
done

HOST=""
SERVE_ON=unknown
if [ -z "$TS_BIN" ]; then
  note "Tailscale not found: the app will work on this Mac only"
elif ! command -v python3 >/dev/null 2>&1; then
  note "python3 not found, so the Tailscale address cannot be read: set PHONE_ACCESS_HOST yourself to use the phone"
else
  STATUS_JSON="$("$TS_BIN" status --json 2>/dev/null || true)"
  HOST="$(printf '%s' "$STATUS_JSON" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    if d.get("BackendState") == "Running":
        print(d["Self"]["DNSName"].rstrip("."))
except Exception:
    pass
' 2>/dev/null || true)"
  # Only a plain Tailscale DNS name is passed on
  if ! printf '%s' "$HOST" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.ts\.net$'; then HOST=""; fi
  if [ -z "$HOST" ]; then
    note "Tailscale is installed but not running (or signed out): the app will work on this Mac only. Open Tailscale and run this again for the phone."
  else
    note "Tailscale address: https://$HOST"
    if "$TS_BIN" serve status --json 2>/dev/null | grep -Eq "(localhost|127\.0\.0\.1|\[::1\]):$PORT"; then SERVE_ON=yes; else SERVE_ON=no; fi
  fi
fi

# --- Port ----------------------------------------------------------------------------------------------------------------
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  OWNER="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | awk 'NR==2 {print $1 " (pid " $2 ")"}')"
  problem "port $PORT is already in use by $OWNER. Stop it first (Ctrl+C in its terminal, or scripts/launchd/uninstall.sh if it is the installed service)"
else
  note "port $PORT is free"
fi

# --- What will run -------------------------------------------------------------------------------------------------------
echo
echo "Will run ($MODE, in web/, listening on 127.0.0.1:$PORT${HOST:+, PHONE_ACCESS_HOST=$HOST}):"
if [ "$MODE" = prod ]; then
  echo "  npm run build && NODE_ENV=production next start -H 127.0.0.1 -p $PORT"
else
  echo "  npm run dev -- -H 127.0.0.1 -p $PORT"
fi
echo
echo "Open on this Mac:  http://localhost:$PORT"
if [ -n "$HOST" ]; then
  echo "Open on the phone: https://$HOST"
  if [ "$SERVE_ON" = no ]; then
    echo "  Phone access is OFF right now. Turn it on with the Phone access switch on /spaces, or run once:"
    echo "  \"$TS_BIN\" serve --bg --https=443 --yes localhost:$PORT"
  fi
fi
echo "This app opens the real database (web/dev.db); back it up before big changes."
echo

if [ "$DRY_RUN" -eq 1 ]; then echo "(dry run: nothing started)"; exit "$FAILED"; fi
if [ "$FAILED" -ne 0 ]; then echo "Not starting: fix the problems above." >&2; exit 1; fi

cd "$WEB_DIR"
[ -n "$HOST" ] && export PHONE_ACCESS_HOST="$HOST"
export PORT
if [ "$MODE" = prod ]; then
  # PHONE_ACCESS_HOST is read when next.config.ts loads, so it must be set for the build as well as for the start
  npm run build
  NODE_ENV=production exec node node_modules/next/dist/bin/next start -H 127.0.0.1 -p "$PORT"
else
  exec npm run dev -- -H 127.0.0.1 -p "$PORT"
fi
