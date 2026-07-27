#!/usr/bin/env bash

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
status=0
bash "$SCRIPT_DIR/subscription-proxy-macos.sh" start local || status=$?

if (( status != 0 )); then
  printf '\n启动失败。请检查上面的提示；按回车键关闭窗口。\n' >&2
  if [[ -t 0 ]]; then
    read -r _
  fi
fi

exit "$status"
