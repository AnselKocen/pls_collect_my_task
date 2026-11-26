#!/bin/bash
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，无法安全核验服务身份；请安装 Node.js 22.16 或更新版本后重试。"
  exit 1
fi
node service-control.js stop
