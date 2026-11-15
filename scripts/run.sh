#!/usr/bin/env bash
# Starts the Feynman study app so that it works on this Mac and, through Tailscale, on the phone.
#
#   scripts/run.sh            development server (hot reload), the usual way while you are working on the code
#   scripts/run.sh --prod     production build, the quiet way to just study (builds first, takes about a minute)
#   scripts/run.sh --serve    also point the phone address (tailscale serve, https 443) at the port chosen
#   scripts/run.sh --dry-run  show what would run and the addresses, start nothing
#
# Port: the first free port from 3000 upwards (FIRST_PORT=4000 to start the search elsewhere). PORT=3005 forces exactly that port and
# fails when it is busy. Something else on 3000 (another project, another app) is left alone.
# Phone: `tailscale serve` forwards the phone address to ONE port. When this app ends up on a different port than the one the phone
# address points at, the phone would show whatever runs on the old port. The script says so, and --serve (or the Phone access switch
# on /spaces) points it at this app. Without --serve the script never changes the Tailscale setup.
# It also finds this Mac's Tailscale address and passes it to the app as PHONE_ACCESS_HOST (the development server answers 403 to the
# phone's requests without it), and binds the app to 127.0.0.1 only. It does not read web/.env, only checks that it exists.
set -euo pipefail

MODE=dev
DRY_RUN=0
POINT_SERVE=0
for arg in "$@"; do
  case "$arg" in
    --prod) MODE=prod ;;
    --serve) POINT_SERVE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "$SCRIPT_DIR/../web" && pwd)"

valid_port() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }
PORT_FORCED=0
if [ -n "${PORT:-}" ]; then
  PORT_FORCED=1
  valid_port "$PORT" || { echo "PORT must be a number from 1 to 65535 (got: $PORT)" >&2; exit 2; }
  FIRST_PORT="$PORT"
else
  FIRST_PORT="${FIRST_PORT:-3000}"
  valid_port "$FIRST_PORT" || { echo "FIRST_PORT must be a number from 1 to 65535 (got: $FIRST_PORT)" >&2; exit 2; }
fi

FAILED=0
note() { printf '  %s\n' "$1"; }
problem() { printf '  [problem] %s\n' "$1"; FAILED=1; }

# --- Ports ----------------------------------------------------------------------------------------------------------------------
HAVE_LSOF=0; command -v lsof >/dev/null 2>&1 && HAVE_LSOF=1
# Each helper ends in `|| true`: lsof exits non-zero when nothing matches, which must not stop the script (set -e, pipefail)
listener_pid() { lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1 || true; }
listener_name() { ps -o comm= -p "$1" 2>/dev/null | awk -F/ '{print $NF}' || true; }
listener_cwd() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true; }
# True when the process on a port is this very app (its working directory is web/): a second copy cannot run next to it
is_this_app() { [ "$(listener_cwd "$1")" = "$WEB_DIR" ]; }

echo "Checks:"
[ -f "$WEB_DIR/package.json" ] || problem "web/package.json not found next to scripts/ (expected $WEB_DIR)"
[ -d "$WEB_DIR/node_modules" ] || problem "web/node_modules is missing: run 'npm install' in web/ first"
if [ -f "$WEB_DIR/.env" ]; then note "web/.env exists (contents not read)"; else problem "web/.env is missing: create it from web/.env.example (APP_PASSCODE and the Gemini key)"; fi
command -v node >/dev/null 2>&1 || problem "node not found on PATH"

CHOSEN=""
if [ "$HAVE_LSOF" -eq 0 ]; then
  CHOSEN="$FIRST_PORT"
  note "lsof not found, so ports cannot be checked: using $CHOSEN"
else
  p="$FIRST_PORT"
  last=$((FIRST_PORT + 99)); [ "$last" -gt 65535 ] && last=65535
  [ "$PORT_FORCED" -eq 1 ] && last="$FIRST_PORT"
  while [ "$p" -le "$last" ]; do
    pid="$(listener_pid "$p")"
    if [ -z "$pid" ]; then CHOSEN="$p"; break; fi
    if is_this_app "$pid"; then
      problem "this app is already running on port $p ($(listener_name "$pid"), pid $pid): open http://localhost:$p, or stop it (Ctrl+C in its terminal) before starting another copy"
      CHOSEN="$p"; break
    fi
    if [ "$PORT_FORCED" -eq 1 ]; then
      problem "PORT=$p is in use by $(listener_name "$pid") (pid $pid), not this app: pick another port, or leave PORT unset to use the first free one"
      CHOSEN="$p"; break
    fi
    note "port $p is in use by $(listener_name "$pid") (pid $pid), not this app: leaving it alone"
    p=$((p + 1))
  done
  if [ -z "$CHOSEN" ]; then
    problem "no free port found from $FIRST_PORT to $last"
    CHOSEN="$FIRST_PORT"
  elif [ "$FAILED" -eq 0 ]; then
    note "using port $CHOSEN"
  fi
fi
PORT="$CHOSEN"

# --- Tailscale address ----------------------------------------------------------------------------------------------------------
TS_BIN=""
for candidate in "${TAILSCALE_BIN:-}" /Applications/Tailscale.app/Contents/MacOS/Tailscale /usr/local/bin/tailscale /opt/homebrew/bin/tailscale; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then TS_BIN="$candidate"; break; fi
done

HOST=""
SERVE_PORT=""   # the local port the phone address currently forwards to, when known
if [ -z "$TS_BIN" ]; then
  note "Tailscale not found: the app will work on this Mac only"
elif ! command -v python3 >/dev/null 2>&1; then
  note "python3 not found, so the Tailscale address cannot be read: set PHONE_ACCESS_HOST yourself to use the phone"
else
  HOST="$("$TS_BIN" status --json 2>/dev/null | python3 -c '
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
    SERVE_PORT="$("$TS_BIN" serve status --json 2>/dev/null | grep -Eo '(localhost|127\.0\.0\.1|\[::1\]):[0-9]+' | head -1 | sed 's/.*://' || true)"
  fi
fi

# --- What will run --------------------------------------------------------------------------------------------------------------
echo
echo "Will run ($MODE, in web/, listening on 127.0.0.1:$PORT${HOST:+, PHONE_ACCESS_HOST=$HOST}):"
if [ "$MODE" = prod ]; then
  echo "  npm run build && NODE_ENV=production next start -H 127.0.0.1 -p $PORT"
else
  echo "  npm run dev -- -H 127.0.0.1 -p $PORT"
fi
echo
echo "Open on this Mac:  http://localhost:$PORT"
SERVE_CMD=""
if [ -n "$HOST" ]; then
  echo "Open on the phone: https://$HOST"
  SERVE_CMD="\"$TS_BIN\" serve --bg --https=443 --yes localhost:$PORT"
  if [ -z "$SERVE_PORT" ]; then
    echo "  Phone access is OFF right now."
  elif [ "$SERVE_PORT" != "$PORT" ]; then
    other="$([ "$HAVE_LSOF" -eq 1 ] && listener_pid "$SERVE_PORT" || true)"
    if [ -n "$other" ]; then
      echo "  The phone address currently points at port $SERVE_PORT, where $(listener_name "$other") (pid $other) is running: the phone would show that, not this app."
    else
      echo "  The phone address currently points at port $SERVE_PORT, where nothing is running."
    fi
  fi
  if [ "$SERVE_PORT" != "$PORT" ]; then
    if [ "$POINT_SERVE" -eq 1 ]; then
      echo "  --serve: the phone address will be pointed at port $PORT (replaces its current target)."
    else
      echo "  To point it at this app, turn on the Phone access switch on /spaces after it starts, run with --serve, or run once:"
      echo "  $SERVE_CMD"
    fi
  fi
fi
echo "This app opens the real database (web/dev.db); back it up before big changes."
echo

if [ "$DRY_RUN" -eq 1 ]; then echo "(dry run: nothing started or changed)"; exit "$FAILED"; fi
if [ "$FAILED" -ne 0 ]; then echo "Not starting: fix the problems above." >&2; exit 1; fi

if [ "$POINT_SERVE" -eq 1 ] && [ -n "$HOST" ] && [ "$SERVE_PORT" != "$PORT" ]; then
  if ! "$TS_BIN" serve --bg --https=443 --yes "localhost:$PORT"; then
    echo "Could not point the phone address at port $PORT (Tailscale may need a one-time approval: run the command above in Terminal). Starting the app anyway." >&2
  fi
fi

cd "$WEB_DIR"
[ -n "$HOST" ] && export PHONE_ACCESS_HOST="$HOST"
# The app's Phone access switch reads PORT, so it always points at the port this copy really uses
export PORT
if [ "$MODE" = prod ]; then
  # PHONE_ACCESS_HOST is read when next.config.ts loads, so it must be set for the build as well as for the start
  npm run build
  NODE_ENV=production exec node node_modules/next/dist/bin/next start -H 127.0.0.1 -p "$PORT"
else
  exec npm run dev -- -H 127.0.0.1 -p "$PORT"
fi
