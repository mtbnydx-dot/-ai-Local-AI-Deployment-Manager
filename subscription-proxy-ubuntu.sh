#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
export SUBSCRIPTION_PROXY_PLATFORM="ubuntu"
exec bash "$SCRIPT_DIR/subscription-proxy-stack.sh" "$@"
