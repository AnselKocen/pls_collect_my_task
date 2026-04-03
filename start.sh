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
  NODE_VER=$(node -v)
  echo -e "${GREEN}✓${NC} Node.js ${NODE_VER}"
else
  echo -e "${RED}✗ 未找到 Node.js${NC}"
  echo ""
  echo -e "  请先安装 Node.js (v18+)："
  echo -e "  ${YELLOW}→ https://nodejs.org${NC}"
  echo -e "  下载 LTS 版本，安装后重新运行此脚本"
  echo ""
  FAIL=1
fi

# --- 2. Check Claude CLI ---
CLAUDE_PATH=""
if [ -n "$CLAUDE_CLI" ] && [ -f "$CLAUDE_CLI" ]; then
  CLAUDE_PATH="$CLAUDE_CLI"
elif command -v claude &>/dev/null; then
  CLAUDE_PATH=$(which claude)
else
  for p in /opt/homebrew/bin/claude /usr/local/bin/claude "$HOME/.claude/local/claude"; do
    if [ -f "$p" ]; then
      CLAUDE_PATH="$p"
      break
    fi
  done
fi

if [ -z "$CLAUDE_PATH" ]; then
  echo -e "${YELLOW}⚠ 未自动找到 Claude CLI${NC}"
  echo ""
  echo -e "  如果你已经安装了，请输入 claude 的完整路径"
  echo -e "  （例如 /usr/local/bin/claude），直接回车跳过："
  echo -n "  路径: "
  read -r USER_PATH
  if [ -n "$USER_PATH" ] && [ -f "$USER_PATH" ]; then
    CLAUDE_PATH="$USER_PATH"
    export CLAUDE_CLI="$CLAUDE_PATH"
  else
    if [ -n "$USER_PATH" ]; then
      echo -e "  ${RED}路径不存在: $USER_PATH${NC}"
    fi
    echo ""
    echo -e "${RED}✗ 未找到 Claude CLI${NC}"
    echo ""
    echo -e "  请先安装 Claude CLI："
    echo -e "  ${YELLOW}→ npm install -g @anthropic-ai/claude-code${NC}"
    echo ""
    echo -e "  安装后请在终端运行一次 ${YELLOW}claude${NC} 完成首次登录"
    echo -e "  （需要登录你的 Anthropic 账号，否则 AI 功能无法使用）"
    echo ""
    FAIL=1
  fi
fi

if [ -n "$CLAUDE_PATH" ]; then
  echo -e "${GREEN}✓${NC} Claude CLI ($CLAUDE_PATH)"
  # Verify it actually works
  CC_VER=$("$CLAUDE_PATH" --version 2>/dev/null || echo "")
  if [ -z "$CC_VER" ]; then
    echo -e "${YELLOW}  ⚠ Claude CLI 存在但无法执行，可能需要重新安装${NC}"
    FAIL=1
  else
    echo -e "  版本: $CC_VER"
    # Check if logged in (quick test)
    echo -n "  验证登录状态..."
    CC_TEST=$(timeout 15 "$CLAUDE_PATH" --output-format text -p "hi" 2>&1 || echo "CC_AUTH_FAIL")
    if echo "$CC_TEST" | grep -qi "auth\|login\|sign in\|unauthorized\|CC_AUTH_FAIL\|error" && [ -z "$(echo "$CC_TEST" | grep -vi "error\|auth\|login\|sign")" ]; then
      echo ""
      echo -e "${YELLOW}  ⚠ Claude CLI 似乎尚未登录${NC}"
      echo -e "  请先在终端运行 ${YELLOW}claude${NC} 完成登录（需要 Max 订阅或 API Key）"
      echo -e "  登录完成后重新运行此脚本"
      FAIL=1
    else
      echo -e " ${GREEN}OK${NC}"
    fi
  fi
fi

# --- Exit if checks failed ---
if [ $FAIL -ne 0 ]; then
  echo "────────────────────────────────"
  echo -e "${YELLOW}提示：本工具的 AI 功能依赖 Claude Code CLI${NC}"
  echo -e "  需要 Anthropic ${CYAN}Max 订阅${NC} 或 ${CYAN}API Key${NC} 才能使用"
  echo -e "  详情：${YELLOW}https://docs.anthropic.com/en/docs/claude-code${NC}"
  echo ""
  echo -e "${RED}环境检查未通过，请完成上述准备后再重新运行${NC}"
  echo ""
  exit 1
fi

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
