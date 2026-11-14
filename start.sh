#!/bin/bash
# ============================================================
#  记忆手帐 — 启动脚本 (Mac / Linux)
# ============================================================

set -e
cd "$(dirname "$0")"

PORT=3013
PID_FILE=".server.pid"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo -e "${CYAN}☕ 记忆手帐 — 环境检查${NC}"
echo "────────────────────────────────"

FAIL=0

# --- 1. Check Node.js ---
if command -v node &>/dev/null; then
  if ! node storage/runtime.js; then
    echo -e "${RED}✗ Node.js 版本不受支持${NC}"
    exit 1
  fi
  NODE_VER=$(node -v)
  echo -e "${GREEN}✓${NC} Node.js ${NODE_VER}"
else
  echo -e "${RED}✗ 未找到 Node.js${NC}"
  echo ""
  echo -e "  请先安装 Node.js (v22.16+)："
  echo -e "  ${YELLOW}→ https://nodejs.org${NC}"
  echo -e "  下载 LTS 版本，安装后重新运行此脚本"
  echo ""
  FAIL=1
fi

# AI assistants are optional and selected in the app's settings.
if [ $FAIL -ne 0 ]; then
  echo -e "${RED}环境检查未通过，请安装 Node.js 后重新运行${NC}"
  exit 1
fi
echo -e "${CYAN}AI 助手可在设置中选择 cc / codex / codebuddy，请安装并登录所选 CLI。${NC}"

# --- 3. Check node_modules ---
if [ ! -d "node_modules" ]; then
  echo -e "${YELLOW}⟳${NC} 首次运行，正在安装依赖..."
  npm install --no-fund --no-audit
  echo -e "${GREEN}✓${NC} 依赖安装完成"
else
  echo -e "${GREEN}✓${NC} 依赖已就绪"
fi

echo "────────────────────────────────"

# --- 4. Check if already running ---
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo -e "${YELLOW}服务已在运行 (PID $OLD_PID)${NC}"
    echo -e "正在打开浏览器..."
    if [ "$(uname)" = "Darwin" ]; then
      open "http://localhost:$PORT"
    else
      xdg-open "http://localhost:$PORT" 2>/dev/null || echo "请手动打开 http://localhost:$PORT"
    fi
    exit 0
  else
    rm -f "$PID_FILE"
  fi
fi

# --- 5. Start server in background ---
echo -e "${CYAN}启动服务...${NC}"
nohup node server.js > .server.log 2>&1 &
SERVER_PID=$!
echo $SERVER_PID > "$PID_FILE"

# --- 6. Wait for server to be ready ---
echo -n "等待服务就绪"
for i in $(seq 1 30); do
  if curl -s "http://localhost:$PORT" > /dev/null 2>&1; then
    echo ""
    echo -e "${GREEN}✓${NC} 服务已启动 (PID $SERVER_PID)"
    break
  fi
  # Check if process died
  if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo ""
    echo -e "${RED}✗ 服务启动失败，查看日志：${NC}"
    tail -20 .server.log
    rm -f "$PID_FILE"
    exit 1
  fi
  echo -n "."
  sleep 1
done

# --- 7. Open browser ---
if [ "$(uname)" = "Darwin" ]; then
  open "http://localhost:$PORT"
else
  xdg-open "http://localhost:$PORT" 2>/dev/null || true
fi

echo ""
echo "────────────────────────────────"
echo -e "${GREEN}☕ 记忆手帐已在后台运行！${NC}"
echo -e "   地址: ${CYAN}http://localhost:$PORT${NC}"
echo -e "   日志: cat .server.log"
echo -e "   停止: ${YELLOW}./stop.sh${NC}"
echo "────────────────────────────────"
echo ""
