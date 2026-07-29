#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PLATFORM="${SUBSCRIPTION_PROXY_PLATFORM:-auto}"
ACTION="${1:-start}"
MODE="${2:-local}"

ENTRY_ROOT="$SCRIPT_DIR/service-entry"
RUNTIME_DIR="$ENTRY_ROOT/.subscription-proxy-runtime"
LOG_DIR="$ENTRY_ROOT/logs"
ENTRY_PORT="${SERVICE_ENTRY_PORT:-5176}"
PROXY_BASE_URL="${CLIPROXY_BASE_URL:-http://127.0.0.1:8317}"
PROXY_BASE_URL="${PROXY_BASE_URL%/}"
ENTRY_HOST="${SERVICE_ENTRY_HOST:-}"
NODE_EXE="${NODE_EXE:-}"

PROXY_PID_FILE="$RUNTIME_DIR/cliproxy.pid"
PROXY_START_FILE="$RUNTIME_DIR/cliproxy.start"
PROXY_EXE_FILE="$RUNTIME_DIR/cliproxy.executable"
PROXY_URL_FILE="$RUNTIME_DIR/cliproxy.url"
ENTRY_PID_FILE="$RUNTIME_DIR/service-entry.pid"
ENTRY_START_FILE="$RUNTIME_DIR/service-entry.start"
PROXY_LOG="$LOG_DIR/subscription-proxy.log"
ENTRY_LOG="$LOG_DIR/subscription-entry.log"

PROXY_HOST=""
PROXY_PORT=""
PROXY_CONFIG_PATH=""
PROXY_EXECUTABLE=""
PROXY_STARTED_THIS_RUN=0
START_COMPLETED=0

usage() {
  cat <<'EOF'
Usage:
  subscription-proxy-{ubuntu|macos}.sh start [local|lan]
  subscription-proxy-{ubuntu|macos}.sh stop
  subscription-proxy-{ubuntu|macos}.sh status

Actions:
  start   Start only CLIProxyAPI, the frontend, and the unified gateway.
  stop    Stop the isolated frontend/gateway and a launcher-owned CLIProxyAPI.
  status  Show CLIProxyAPI and frontend/gateway reachability.

Modes:
  local   Bind the frontend/gateway to 127.0.0.1 (default).
  lan     Bind the frontend/gateway to 0.0.0.0 for LAN clients.

Environment:
  CLIPROXY_EXE        CLIProxyAPI executable path or command name.
  CLIPROXY_CONFIG     Optional CLIProxyAPI config path.
  CLIPROXY_BASE_URL   Upstream URL (default http://127.0.0.1:8317).
  NODE_EXE            Optional Node.js executable path.
  SERVICE_ENTRY_PORT  Frontend/gateway port (default 5176).
  SERVICE_ENTRY_HOST  Explicit bind host; overrides local/lan mode.
  SUBSCRIPTION_PROXY_NO_OPEN=1  Do not open a browser after startup.
  SUBSCRIPTION_PROXY_BROWSER_EXE  Optional browser/opener executable.

The launcher keeps CLIProxyAPI on 127.0.0.1 in both local and LAN modes.
When a writable CLIProxyAPI config is found, its top-level host is corrected
to 127.0.0.1 before a new proxy process starts.
EOF
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

warn() {
  printf 'Warning: %s\n' "$*" >&2
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command was not found: $1"
}

absolute_file() {
  local file="$1"
  local directory
  directory="$(cd "$(dirname "$file")" && pwd -P)"
  printf '%s/%s\n' "$directory" "$(basename "$file")"
}

resolve_executable() {
  local configured="$1"
  shift
  local candidate

  if [[ -n "$configured" ]]; then
    if [[ -f "$configured" && -x "$configured" ]]; then
      absolute_file "$configured"
      return 0
    fi
    if command -v "$configured" >/dev/null 2>&1; then
      command -v "$configured"
      return 0
    fi
    return 1
  fi

  for candidate in "$@"; do
    if [[ "$candidate" == */* ]]; then
      if [[ -f "$candidate" && -x "$candidate" ]]; then
        absolute_file "$candidate"
        return 0
      fi
    elif command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

validate_platform() {
  local kernel
  kernel="$(uname -s)"
  case "$PLATFORM" in
    ubuntu)
      [[ "$kernel" == "Linux" ]] || die "The Ubuntu launcher requires Linux; detected $kernel."
      if [[ -r /etc/os-release ]] && ! grep -Eiq '^(ID|ID_LIKE)=.*(ubuntu|debian)' /etc/os-release; then
        warn "This Linux distribution is not identified as Ubuntu/Debian; continuing with portable commands."
      fi
      ;;
    macos)
      [[ "$kernel" == "Darwin" ]] || die "The macOS launcher requires Darwin; detected $kernel."
      ;;
    auto)
      case "$kernel" in
        Linux) PLATFORM="ubuntu" ;;
        Darwin) PLATFORM="macos" ;;
        *) die "Unsupported operating system: $kernel" ;;
      esac
      ;;
    *)
      die "Unsupported platform selector: $PLATFORM"
      ;;
  esac
}

validate_arguments() {
  case "$ACTION" in
    -h|--help|help)
      usage
      exit 0
      ;;
    start|stop|status) ;;
    *) die "Unknown action '$ACTION'. Run with --help for usage." ;;
  esac

  case "$MODE" in
    local|lan) ;;
    *) die "Unknown mode '$MODE'. Expected local or lan." ;;
  esac
}

prepare_runtime() {
  mkdir -p "$RUNTIME_DIR" "$LOG_DIR"
}

validate_runtime() {
  [[ -d "$ENTRY_ROOT" && -f "$ENTRY_ROOT/server.js" ]] ||
    die "service-entry/server.js was not found next to this launcher."
  require_command curl
  require_command ps
  require_command nohup

  if [[ -z "$NODE_EXE" ]]; then
    NODE_EXE="$(command -v node || true)"
  elif [[ -x "$NODE_EXE" ]]; then
    NODE_EXE="$(absolute_file "$NODE_EXE")"
  else
    NODE_EXE="$(command -v "$NODE_EXE" 2>/dev/null || true)"
  fi
  [[ -n "$NODE_EXE" ]] || die "Node.js was not found. Install Node.js 20+ or set NODE_EXE."

  "$NODE_EXE" -e '
    const major = Number(process.versions.node.split(".")[0]);
    if (!Number.isInteger(major) || major < 20) process.exit(1);
  ' || die "Node.js 20 or newer is required."

  if [[ -n "${CLIPROXY_CONFIG:-}" ]]; then
    [[ -f "$CLIPROXY_CONFIG" ]] || die "CLIPROXY_CONFIG does not exist: $CLIPROXY_CONFIG"
    CLIPROXY_CONFIG="$(absolute_file "$CLIPROXY_CONFIG")"
    export CLIPROXY_CONFIG
  fi

  local parsed
  parsed="$("$NODE_EXE" -e '
    try {
      const value = new URL(process.argv[1]);
      if (!["http:", "https:"].includes(value.protocol)) process.exit(2);
      console.log(value.hostname);
      console.log(value.port || (value.protocol === "https:" ? "443" : "80"));
    } catch {
      process.exit(2);
    }
  ' "$PROXY_BASE_URL")" || die "CLIPROXY_BASE_URL must be a valid HTTP or HTTPS URL."
  PROXY_HOST="$(printf '%s\n' "$parsed" | sed -n '1p')"
  PROXY_PORT="$(printf '%s\n' "$parsed" | sed -n '2p')"
}

process_start_signature() {
  ps -p "$1" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

process_matches_record() {
  local pid="$1"
  local expected_start="$2"
  local expected_executable="$3"
  local actual_start
  local actual_command

  kill -0 "$pid" 2>/dev/null || return 1
  actual_start="$(process_start_signature "$pid")"
  [[ -n "$actual_start" && "$actual_start" == "$expected_start" ]] || return 1
  actual_command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ "$actual_command" == *"$(basename "$expected_executable")"* ]] || return 1
}

tcp_is_open() {
  "$NODE_EXE" -e '
    const net = require("node:net");
    const socket = net.createConnection({ host: process.argv[1], port: Number(process.argv[2]) });
    const done = (code) => { socket.destroy(); process.exit(code); };
    socket.setTimeout(800, () => done(1));
    socket.once("connect", () => done(0));
    socket.once("error", () => done(1));
  ' "$1" "$2" >/dev/null 2>&1
}

listener_addresses() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -Fn 2>/dev/null |
      sed -n 's/^n//p'
    return 0
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -H -ltn "sport = :$port" 2>/dev/null |
      awk '{print $4}'
    return 0
  fi
  return 2
}

listener_scope() {
  local port="$1"
  local addresses
  local address
  local found=0
  local non_loopback=0

  addresses="$(listener_addresses "$port")" || {
    printf 'unknown\n'
    return 0
  }
  while IFS= read -r address; do
    [[ -n "$address" ]] || continue
    found=1
    case "$address" in
      127.0.0.1:*|\[::1\]:*|::1:*) ;;
      *) non_loopback=1 ;;
    esac
  done <<<"$addresses"
  if (( found == 0 )); then
    printf 'offline\n'
  elif (( non_loopback == 1 )); then
    printf 'lan\n'
  else
    printf 'local\n'
  fi
}

listener_matches_host() {
  local port="$1"
  local desired_host="$2"
  local scope
  scope="$(listener_scope "$port")"
  if is_loopback_host "$desired_host"; then
    [[ "$scope" == "local" ]]
  else
    [[ "$scope" == "lan" ]]
  fi
}

assert_loopback_listener() {
  local port="$1"
  local scope
  local addresses
  scope="$(listener_scope "$port")"
  addresses="$(listener_addresses "$port" 2>/dev/null | tr '\n' ' ' || true)"
  [[ "$scope" == "local" ]] ||
    die "CLIProxyAPI must listen only on 127.0.0.1/::1, but port $port is '$scope' (${addresses:-address unavailable}). Restart CLIProxyAPI after correcting its config."
}

proxy_is_ready() {
  local response
  local status
  response="$(curl --silent --show-error --dump-header - --output /dev/null --write-out $'\n%{http_code}' \
    --connect-timeout 1 --max-time 3 "$PROXY_BASE_URL/v1/models" 2>/dev/null)" || return 1
  status="$(printf '%s\n' "$response" | tail -n 1 | tr -d '\r')"
  case "$status" in
    200|401|403) ;;
    *) return 1 ;;
  esac
  printf '%s\n' "$response" | tr '[:upper:]' '[:lower:]' | grep -q 'x-cpa-' || return 1
}

entry_status_field() {
  local field="$1"
  curl --silent --show-error --connect-timeout 1 --max-time 3 \
    "http://127.0.0.1:$ENTRY_PORT/api/status" 2>/dev/null |
    "$NODE_EXE" -e '
      let body = "";
      const field = process.argv[1];
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { body += chunk; });
      process.stdin.on("end", () => {
        try {
          const value = JSON.parse(body);
          process.stdout.write(String(value.entry && value.entry[field] || ""));
        } catch {
          process.exit(1);
        }
      });
    ' "$field"
}

entry_mode() {
  entry_status_field mode
}

wait_for_proxy() {
  local count=0
  while (( count < 60 )); do
    proxy_is_ready && return 0
    sleep 0.25
    count=$((count + 1))
  done
  return 1
}

wait_for_existing_proxy() {
  local count=0
  while (( count < 8 )); do
    proxy_is_ready && return 0
    sleep 0.25
    count=$((count + 1))
  done
  return 1
}

wait_for_entry_mode() {
  local expected="$1"
  local count=0
  local mode
  while (( count < 60 )); do
    mode="$(entry_mode 2>/dev/null || true)"
    [[ "$mode" == "$expected" ]] && return 0
    sleep 0.25
    count=$((count + 1))
  done
  return 1
}

wait_for_entry_offline() {
  local count=0
  while (( count < 32 )); do
    tcp_is_open 127.0.0.1 "$ENTRY_PORT" || return 0
    sleep 0.25
    count=$((count + 1))
  done
  return 1
}

stop_pid_gracefully() {
  local pid="$1"
  local count=0
  kill "$pid" 2>/dev/null || return 0
  while (( count < 32 )); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.25
    count=$((count + 1))
  done
  kill -KILL "$pid" 2>/dev/null || true
}

is_loopback_host() {
  case "$1" in
    127.0.0.1|localhost|::1) return 0 ;;
    *) return 1 ;;
  esac
}

resolve_clip_proxy_executable() {
  resolve_executable "${CLIPROXY_EXE:-}" \
    "$SCRIPT_DIR/cli-proxy-api" \
    "$SCRIPT_DIR/CLIProxyAPI/cli-proxy-api" \
    "$SCRIPT_DIR/cliproxyapi" \
    "/opt/homebrew/opt/cliproxyapi/bin/cliproxyapi" \
    "/usr/local/opt/cliproxyapi/bin/cliproxyapi" \
    cli-proxy-api cliproxyapi
}

resolve_clip_proxy_config() {
  local executable="$1"
  local candidate
  local executable_directory
  executable_directory="$(dirname "$executable")"

  if [[ -n "${CLIPROXY_CONFIG:-}" ]]; then
    printf '%s\n' "$CLIPROXY_CONFIG"
    return 0
  fi
  for candidate in \
    "/opt/homebrew/etc/cliproxyapi.conf" \
    "/usr/local/etc/cliproxyapi.conf" \
    "$SCRIPT_DIR/config.yaml" \
    "$SCRIPT_DIR/config.yml" \
    "$SCRIPT_DIR/cliproxyapi.conf" \
    "$executable_directory/config.yaml" \
    "$executable_directory/config.yml" \
    "${HOME}/.cli-proxy-api/config.yaml"; do
    if [[ -f "$candidate" ]]; then
      absolute_file "$candidate"
      return 0
    fi
  done
  return 1
}

prepare_proxy_config() {
  local result
  [[ -n "$PROXY_EXECUTABLE" ]] || return 0
  if [[ -z "$PROXY_CONFIG_PATH" ]]; then
    PROXY_CONFIG_PATH="$(resolve_clip_proxy_config "$PROXY_EXECUTABLE" || true)"
  fi
  [[ -n "$PROXY_CONFIG_PATH" ]] || return 0
  result="$("$NODE_EXE" "$ENTRY_ROOT/subscription-config-tool.js" ensure-loopback "$PROXY_CONFIG_PATH")" ||
    die "Could not enforce the CLIProxyAPI loopback setting in $PROXY_CONFIG_PATH"
  CLIPROXY_CONFIG="$PROXY_CONFIG_PATH"
  export CLIPROXY_CONFIG
  if printf '%s' "$result" | grep -q '"changed":true'; then
    printf 'Updated CLIProxyAPI config to bind 127.0.0.1: %s\n' "$PROXY_CONFIG_PATH"
  fi
}

offer_macos_homebrew_install() {
  local answer=""
  local brew_executable=""

  [[ "$PLATFORM" == "macos" ]] || return 1
  [[ -z "${CLIPROXY_EXE:-}" ]] || return 1
  brew_executable="$(resolve_executable "" \
    "/opt/homebrew/bin/brew" \
    "/usr/local/bin/brew" \
    brew || true)"
  [[ -n "$brew_executable" ]] || return 1
  [[ -t 0 ]] || return 1

  printf '\n未检测到 CLIProxyAPI。是否现在通过 Homebrew 安装？[Y/n] '
  if ! read -r answer; then
    return 1
  fi
  case "$answer" in
    n|N|no|NO|No)
      return 1
      ;;
  esac

  printf '正在运行 brew install cliproxyapi ...\n'
  if ! "$brew_executable" install cliproxyapi; then
    die "Homebrew could not install CLIProxyAPI."
  fi
  hash -r
}

start_proxy() {
  local proxy_pid
  local proxy_start
  local proxy_directory

  PROXY_EXECUTABLE="$(resolve_clip_proxy_executable || true)"
  is_loopback_host "$PROXY_HOST" && prepare_proxy_config

  if proxy_is_ready; then
    is_loopback_host "$PROXY_HOST" && assert_loopback_listener "$PROXY_PORT"
    printf 'CLIProxyAPI is already reachable at %s; reusing it without taking ownership.\n' "$PROXY_BASE_URL"
    return 0
  fi
  if wait_for_existing_proxy; then
    is_loopback_host "$PROXY_HOST" && assert_loopback_listener "$PROXY_PORT"
    printf 'CLIProxyAPI became reachable at %s; reusing it without taking ownership.\n' "$PROXY_BASE_URL"
    return 0
  fi
  if tcp_is_open "$PROXY_HOST" "$PROXY_PORT"; then
    die "Port $PROXY_PORT is occupied by a service that did not present the CLIProxyAPI identity headers."
  fi

  is_loopback_host "$PROXY_HOST" ||
    die "Configured remote CLIProxyAPI is unreachable: $PROXY_BASE_URL"

  if [[ -z "$PROXY_EXECUTABLE" ]]; then
    offer_macos_homebrew_install || true
    PROXY_EXECUTABLE="$(resolve_clip_proxy_executable || true)"
    is_loopback_host "$PROXY_HOST" && prepare_proxy_config
  fi
  if [[ -z "$PROXY_EXECUTABLE" ]]; then
    if [[ "$PLATFORM" == "macos" ]]; then
      die "CLIProxyAPI was not found. Install it with 'brew install cliproxyapi' or set CLIPROXY_EXE."
    fi
    die "CLIProxyAPI was not found. Install it with the official Linux installer or set CLIPROXY_EXE."
  fi

  proxy_directory="$(dirname "$PROXY_EXECUTABLE")"
  if [[ -n "$PROXY_CONFIG_PATH" ]]; then
    (
      cd "$proxy_directory"
      exec nohup "$PROXY_EXECUTABLE" --config "$PROXY_CONFIG_PATH"
    ) >>"$PROXY_LOG" 2>&1 &
  else
    (
      cd "$proxy_directory"
      exec nohup "$PROXY_EXECUTABLE"
    ) >>"$PROXY_LOG" 2>&1 &
  fi
  proxy_pid=$!
  PROXY_STARTED_THIS_RUN=1

  if ! wait_for_proxy; then
    stop_pid_gracefully "$proxy_pid"
    PROXY_STARTED_THIS_RUN=0
    die "CLIProxyAPI did not become ready at $PROXY_BASE_URL. Check $PROXY_LOG."
  fi
  assert_loopback_listener "$PROXY_PORT"

  proxy_start="$(process_start_signature "$proxy_pid")"
  [[ -n "$proxy_start" ]] || {
    stop_pid_gracefully "$proxy_pid"
    PROXY_STARTED_THIS_RUN=0
    die "Could not record CLIProxyAPI process identity."
  }
  printf '%s\n' "$proxy_pid" >"$PROXY_PID_FILE"
  printf '%s\n' "$proxy_start" >"$PROXY_START_FILE"
  printf '%s\n' "$PROXY_EXECUTABLE" >"$PROXY_EXE_FILE"
  printf '%s\n' "$PROXY_BASE_URL" >"$PROXY_URL_FILE"
  printf 'Started CLIProxyAPI PID %s at %s.\n' "$proxy_pid" "$PROXY_BASE_URL"
}

start_entry() {
  local current_mode
  local entry_pid
  local entry_start
  local desired_scope

  if [[ -n "$ENTRY_HOST" ]]; then
    :
  elif [[ "$MODE" == "lan" ]]; then
    ENTRY_HOST="0.0.0.0"
  else
    ENTRY_HOST="127.0.0.1"
  fi
  desired_scope="lan"
  is_loopback_host "$ENTRY_HOST" && desired_scope="local"

  current_mode="$(entry_mode 2>/dev/null || true)"
  if [[ "$current_mode" == "subscription" ]]; then
    if listener_matches_host "$ENTRY_PORT" "$ENTRY_HOST"; then
      printf 'Subscription frontend and gateway are already running on port %s in %s mode.\n' "$ENTRY_PORT" "$desired_scope"
      return 0
    fi
    if [[ -f "$ENTRY_PID_FILE" && -f "$ENTRY_START_FILE" ]] &&
      process_matches_record "$(cat "$ENTRY_PID_FILE")" "$(cat "$ENTRY_START_FILE")" "$NODE_EXE"; then
      printf 'Restarting the launcher-owned frontend/gateway to switch to %s mode.\n' "$desired_scope"
      stop_entry
      current_mode=""
    else
      die "Subscription service-entry is already running with a different network binding and is not owned by this launcher. Stop it explicitly before switching modes."
    fi
  fi
  if [[ -n "$current_mode" ]]; then
    die "Port $ENTRY_PORT is running service-entry in '$current_mode' mode. Stop it before starting the isolated stack."
  fi
  if tcp_is_open 127.0.0.1 "$ENTRY_PORT"; then
    die "Port $ENTRY_PORT is already in use and is not a verifiable subscription service-entry."
  fi

  SERVICE_ENTRY_HOST="$ENTRY_HOST" \
  SERVICE_ENTRY_PORT="$ENTRY_PORT" \
  SERVICE_ENTRY_MODE="subscription" \
  CLIPROXY_ENABLED="1" \
  CLIPROXY_BASE_URL="$PROXY_BASE_URL" \
    nohup "$NODE_EXE" "$ENTRY_ROOT/server.js" >>"$ENTRY_LOG" 2>&1 &
  entry_pid=$!

  if ! wait_for_entry_mode subscription; then
    stop_pid_gracefully "$entry_pid"
    die "Frontend and gateway did not enter subscription mode. Check $ENTRY_LOG."
  fi
  if ! listener_matches_host "$ENTRY_PORT" "$ENTRY_HOST"; then
    stop_pid_gracefully "$entry_pid"
    die "Frontend/gateway listener does not match requested $desired_scope mode."
  fi

  entry_start="$(process_start_signature "$entry_pid")"
  [[ -n "$entry_start" ]] || {
    stop_pid_gracefully "$entry_pid"
    die "Could not record service-entry process identity."
  }
  printf '%s\n' "$entry_pid" >"$ENTRY_PID_FILE"
  printf '%s\n' "$entry_start" >"$ENTRY_START_FILE"
  printf 'Started subscription frontend and gateway PID %s on %s:%s.\n' "$entry_pid" "$ENTRY_HOST" "$ENTRY_PORT"
}

clear_proxy_record() {
  rm -f "$PROXY_PID_FILE" "$PROXY_START_FILE" "$PROXY_EXE_FILE" "$PROXY_URL_FILE"
}

clear_entry_record() {
  rm -f "$ENTRY_PID_FILE" "$ENTRY_START_FILE"
}

stop_owned_proxy() {
  local pid
  local expected_start
  local expected_executable
  local expected_url

  if [[ ! -f "$PROXY_PID_FILE" || ! -f "$PROXY_START_FILE" || ! -f "$PROXY_EXE_FILE" || ! -f "$PROXY_URL_FILE" ]]; then
    printf 'No launcher-owned CLIProxyAPI process is recorded; independently started services are left running.\n'
    return 0
  fi

  pid="$(cat "$PROXY_PID_FILE")"
  expected_start="$(cat "$PROXY_START_FILE")"
  expected_executable="$(cat "$PROXY_EXE_FILE")"
  expected_url="$(cat "$PROXY_URL_FILE")"
  if [[ "$expected_url" != "$PROXY_BASE_URL" ]]; then
    printf 'The launcher-owned CLIProxyAPI belongs to %s; the current %s stack will not stop it.\n' \
      "$expected_url" "$PROXY_BASE_URL"
    return 0
  fi
  if ! process_matches_record "$pid" "$expected_start" "$expected_executable"; then
    warn "The recorded CLIProxyAPI PID no longer matches the owned process; it will not be stopped."
    clear_proxy_record
    return 0
  fi

  stop_pid_gracefully "$pid"
  clear_proxy_record
  PROXY_STARTED_THIS_RUN=0
  printf 'Stopped launcher-owned CLIProxyAPI PID %s.\n' "$pid"
}

stop_entry() {
  local current_mode
  local pid=""
  local expected_start=""

  current_mode="$(entry_mode 2>/dev/null || true)"
  if [[ "$current_mode" == "subscription" ]]; then
    curl --silent --show-error --fail --max-time 3 -X POST \
      "http://127.0.0.1:$ENTRY_PORT/api/shutdown" >/dev/null || true
    if ! wait_for_entry_offline; then
      if [[ -f "$ENTRY_PID_FILE" && -f "$ENTRY_START_FILE" ]]; then
        pid="$(cat "$ENTRY_PID_FILE")"
        expected_start="$(cat "$ENTRY_START_FILE")"
        if process_matches_record "$pid" "$expected_start" "$NODE_EXE"; then
          stop_pid_gracefully "$pid"
        else
          warn "Frontend/gateway did not stop and its process identity cannot be verified."
          return 0
        fi
      else
        warn "Frontend/gateway did not stop and no launcher-owned process is recorded."
        return 0
      fi
    fi
    clear_entry_record
    printf 'Stopped subscription frontend and gateway on port %s.\n' "$ENTRY_PORT"
    return 0
  fi
  if [[ -n "$current_mode" ]]; then
    warn "Port $ENTRY_PORT is running '$current_mode' mode and will not be stopped."
    return 0
  fi

  if [[ -f "$ENTRY_PID_FILE" && -f "$ENTRY_START_FILE" ]]; then
    pid="$(cat "$ENTRY_PID_FILE")"
    expected_start="$(cat "$ENTRY_START_FILE")"
    if process_matches_record "$pid" "$expected_start" "$NODE_EXE"; then
      stop_pid_gracefully "$pid"
      printf 'Stopped the recorded subscription service-entry PID %s.\n' "$pid"
    fi
  fi
  clear_entry_record
  printf 'Subscription frontend and gateway are already stopped.\n'
}

lan_address() {
  if [[ "$PLATFORM" == "macos" ]]; then
    local interface
    interface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')"
    if [[ -n "$interface" ]]; then
      ipconfig getifaddr "$interface" 2>/dev/null || true
    fi
  else
    hostname -I 2>/dev/null | awk '{print $1}'
  fi
}

show_status() {
  local proxy_state="offline"
  local frontend_state="offline"
  local proxy_scope
  local frontend_scope
  local current_mode
  local address

  proxy_is_ready && proxy_state="reachable"
  current_mode="$(entry_mode 2>/dev/null || true)"
  [[ -n "$current_mode" ]] && frontend_state="$current_mode"
  proxy_scope="$(listener_scope "$PROXY_PORT")"
  frontend_scope="$(listener_scope "$ENTRY_PORT")"

  printf '%-20s %-10s %-18s %-8s %s\n' "MODULE" "PORT" "STATE" "BIND" "URL"
  printf '%-20s %-10s %-18s %-8s %s\n' "CLIProxyAPI" "$PROXY_PORT" "$proxy_state" "$proxy_scope" "$PROXY_BASE_URL"
  printf '%-20s %-10s %-18s %-8s %s\n' "Frontend + Gateway" "$ENTRY_PORT" "$frontend_state" "$frontend_scope" "http://127.0.0.1:$ENTRY_PORT/"

  if [[ "$frontend_scope" == "lan" ]]; then
    address="$(lan_address)"
    [[ -n "$address" ]] && printf 'LAN dashboard: http://%s:%s/\n' "$address" "$ENTRY_PORT"
  fi
}

open_dashboard() {
  local dashboard_url="http://127.0.0.1:$ENTRY_PORT/subscription-console.html"
  local browser_executable=""

  [[ "${SUBSCRIPTION_PROXY_NO_OPEN:-0}" == "1" ]] && return 0
  if [[ -n "${SUBSCRIPTION_PROXY_BROWSER_EXE:-}" ]]; then
    if ! browser_executable="$(resolve_executable "$SUBSCRIPTION_PROXY_BROWSER_EXE")"; then
      warn "Browser opener was not found. Open $dashboard_url manually."
      return 0
    fi
    if "$browser_executable" "$dashboard_url"; then
      printf 'Opened dashboard: %s\n' "$dashboard_url"
    else
      warn "Browser opener failed. Open $dashboard_url manually."
    fi
  elif [[ "$PLATFORM" == "macos" ]] && command -v open >/dev/null 2>&1; then
    if open "$dashboard_url" >/dev/null 2>&1; then
      printf 'Opened dashboard: %s\n' "$dashboard_url"
    else
      warn "Could not open the default browser. Open $dashboard_url manually."
    fi
  elif [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] && command -v xdg-open >/dev/null 2>&1; then
    if xdg-open "$dashboard_url" >/dev/null 2>&1; then
      printf 'Opened dashboard: %s\n' "$dashboard_url"
    else
      warn "Could not open the default browser. Open $dashboard_url manually."
    fi
  else
    warn "No desktop browser opener was detected. Open $dashboard_url manually."
  fi
}

start_stack() {
  prepare_runtime
  trap 'start_status=$?; if (( START_COMPLETED == 0 && PROXY_STARTED_THIS_RUN == 1 )); then stop_owned_proxy; fi; exit "$start_status"' EXIT
  start_proxy
  start_entry

  show_status
  printf '\nOpenAI:   http://127.0.0.1:%s/gateway/subscription/openai/v1\n' "$ENTRY_PORT"
  printf 'Claude:   http://127.0.0.1:%s/gateway/subscription/claude\n' "$ENTRY_PORT"
  printf 'Codex:    http://127.0.0.1:%s/gateway/subscription/codex/v1\n' "$ENTRY_PORT"
  printf 'OpenCode: http://127.0.0.1:%s/gateway/subscription/opencode/v1\n' "$ENTRY_PORT"
  open_dashboard
  START_COMPLETED=1
  trap - EXIT
}

stop_stack() {
  prepare_runtime
  stop_entry
  stop_owned_proxy
}

validate_arguments
validate_platform
validate_runtime

case "$ACTION" in
  start) start_stack ;;
  stop) stop_stack ;;
  status) show_status ;;
esac
