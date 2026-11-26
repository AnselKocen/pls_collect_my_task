#!/bin/bash
set -e
cd "$(dirname "$0")"
export PORT="${PORT:-3013}"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请安装 Node.js 22.16 或更新版本：https://nodejs.org"
  exit 1
fi
node storage/runtime.js

if [ ! -d node_modules ]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "缺少依赖且未找到 npm，请安装完整的 Node.js 后重试。"
    exit 1
  fi
  npm install --no-fund --no-audit
fi

node service-control.js start
if [ "${MEMO_NO_OPEN:-0}" != "1" ]; then
  if [ "$(uname)" = Darwin ]; then
    open "http://localhost:$PORT" || echo "请手动打开 http://localhost:$PORT"
  else
    xdg-open "http://localhost:$PORT" 2>/dev/null || echo "请手动打开 http://localhost:$PORT"
  fi
fi
