#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

case "$(uname -s)" in
  Darwin)
    exec bash "$SCRIPT_DIR/subscription-proxy-macos.sh" start local
    ;;
  Linux)
    exec bash "$SCRIPT_DIR/subscription-proxy-ubuntu.sh" start local
    ;;
  *)
    printf 'Error: this one-click launcher supports Ubuntu/Linux and macOS only.\n' >&2
    exit 1
    ;;
esac
