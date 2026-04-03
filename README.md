# 记忆手帐 Memo Journal

一个带有 AI 助手的个人便签手帐应用。支持便签管理、智能搜索、任务图谱、习惯养成等功能。

AI 功能由 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) 驱动。

## 功能

- 便签创建 / 编辑 / 删除 / 置顶，支持标签分类和看板展示
- AI 智能搜索、标签整理建议、任务关联图谱、每日/每周总结
- 习惯养成：上传书籍 ZIP 生成习惯卡池，每日抽取打卡
- 任务盲盒：随机抽取任务
- 24+ 主题配色 + 自定义主题

## 准备工作

### 1. 安装 Node.js

需要 Node.js v18+，下载地址：https://nodejs.org （选 LTS 版本）

### 2. 安装 Claude Code CLI（AI 功能需要）

```bash
npm install -g @anthropic-ai/claude-code
```

安装后在终端运行一次 `claude` 完成首次登录（需要 Anthropic Max 订阅或 API Key）。

> 如果不需要 AI 功能，可以跳过此步，基础的便签功能仍然可用。

## 快速开始

### 克隆项目

```bash
git clone https://github.com/Anselkocen/memo-journal.git
cd memo-journal
```

### Mac / Linux

```bash
chmod +x start.sh stop.sh
./start.sh
```

停止服务：

```bash
./stop.sh
```

### Windows

双击 `start.bat` 或在命令行运行：

```cmd
start.bat
```

停止服务：

```cmd
stop.bat
```

启动后浏览器会自动打开 http://localhost:3013

## 项目结构

```
server.js          # Express 后端服务
electron-main.js   # Electron 桌面端主进程
electron-preload.js
public/            # 前端页面
  index.html
  app.js
  style.css
  assets/
start.sh / stop.sh     # Mac/Linux 启动/停止脚本
start.bat / stop.bat   # Windows 启动/停止脚本
```

## 协议

GPL-3.0 + 非商用限制，详见 [LICENSE](LICENSE)。

未经作者书面许可，不得将本软件用于商业用途。

## 作者

Anselkocen
