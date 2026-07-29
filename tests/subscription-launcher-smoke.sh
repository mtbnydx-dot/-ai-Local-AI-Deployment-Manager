#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
LAUNCHER="${1:-$ROOT/subscription-proxy-stack.sh}"
if [[ "$LAUNCHER" != /* ]]; then
  LAUNCHER="$ROOT/${LAUNCHER#./}"
fi
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/subscription-launcher.XXXXXX")"
PROXY_PORT="${SUBSCRIPTION_TEST_PROXY_PORT:-18327}"
ENTRY_PORT="${SUBSCRIPTION_TEST_ENTRY_PORT:-15186}"
MOCK_PID=""

cleanup() {
  CLIPROXY_BASE_URL="http://127.0.0.1:$PROXY_PORT" \
  SERVICE_ENTRY_PORT="$ENTRY_PORT" \
  CLIPROXY_CONFIG="$TEMP_DIR/config.yaml" \
  SUBSCRIPTION_PROXY_NO_OPEN=1 \
    bash "$LAUNCHER" stop >/dev/null 2>&1 || true
  if [[ -n "$MOCK_PID" ]]; then
    kill "$MOCK_PID" >/dev/null 2>&1 || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

printf '%s\n' \
  'host: ""' \
  "port: $PROXY_PORT" \
  'auth-dir: "~/.cli-proxy-api"' \
  'api-keys:' \
  '  - "launcher-smoke-key-that-is-long-enough"' \
  >"$TEMP_DIR/config.yaml"

export CLIPROXY_BASE_URL="http://127.0.0.1:$PROXY_PORT"
export SERVICE_ENTRY_PORT="$ENTRY_PORT"
export CLIPROXY_CONFIG="$TEMP_DIR/config.yaml"
export CLIPROXY_EXE="$ROOT/tests/mock-cliproxy-api.cjs"
export SUBSCRIPTION_PROXY_NO_OPEN=1
unset SERVICE_ENTRY_HOST

node "$ROOT/tests/mock-cliproxy-api.cjs" &
MOCK_PID=$!

(
  cd "$TEMP_DIR"
  CLIPROXY_CONFIG="config.yaml" bash "$LAUNCHER" start local
)
grep -q '^host: "127.0.0.1"$' "$TEMP_DIR/config.yaml"
curl --fail --silent "http://127.0.0.1:$ENTRY_PORT/api/status" |
  node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const v=JSON.parse(d);if(v.entry.mode!=="subscription"||v.entry.host!=="127.0.0.1")process.exit(1)})'

bash "$LAUNCHER" start lan
curl --fail --silent "http://127.0.0.1:$ENTRY_PORT/api/status" |
  node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const v=JSON.parse(d);if(v.entry.host!=="0.0.0.0")process.exit(1)})'
status_output="$(bash "$LAUNCHER" status)"
grep -Eq 'Frontend \+ Gateway.*lan' <<<"$status_output"

bash "$LAUNCHER" start local
curl --fail --silent "http://127.0.0.1:$ENTRY_PORT/api/status" |
  node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const v=JSON.parse(d);if(v.entry.host!=="127.0.0.1")process.exit(1)})'
bash "$LAUNCHER" stop

kill "$MOCK_PID"
wait "$MOCK_PID" 2>/dev/null || true
MOCK_PID=""

CLIPROXY_IDENTITY_HEADERS=0 node "$ROOT/tests/mock-cliproxy-api.cjs" &
MOCK_PID=$!
if bash "$LAUNCHER" start local >"$TEMP_DIR/non-cliproxy.log" 2>&1; then
  printf 'Launcher accepted a service without CLIProxyAPI identity headers.\n' >&2
  exit 1
fi
grep -q 'did not present the CLIProxyAPI identity headers' "$TEMP_DIR/non-cliproxy.log"
kill "$MOCK_PID"
wait "$MOCK_PID" 2>/dev/null || true
MOCK_PID=""

CLIPROXY_LISTEN_HOST=0.0.0.0 node "$ROOT/tests/mock-cliproxy-api.cjs" &
MOCK_PID=$!
if bash "$LAUNCHER" start local >"$TEMP_DIR/wildcard.log" 2>&1; then
  printf 'Launcher accepted a wildcard CLIProxyAPI listener.\n' >&2
  exit 1
fi
grep -q 'must listen only on 127.0.0.1/::1' "$TEMP_DIR/wildcard.log"

printf 'Subscription launcher smoke checks passed.\n'
