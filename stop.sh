#!/bin/bash
# ============================================================
#  记忆手帐 — 停止脚本 (Mac / Linux)
# ============================================================

cd "$(dirname "$0")"

PID_FILE=".server.pid"
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

if [ ! -f "$PID_FILE" ]; then
  echo -e "${RED}服务未在运行${NC}"
  exit 0
fi

PID=$(cat "$PID_FILE")
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  rm -f "$PID_FILE"
  echo -e "${GREEN}✓ 服务已停止 (PID $PID)${NC}"
else
  rm -f "$PID_FILE"
  echo -e "服务已不在运行，已清理 PID 文件"
fi
