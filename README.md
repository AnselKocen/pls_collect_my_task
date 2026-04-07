# 记忆手帐 Memo Journal

> 一个带 AI 助理的个人便签手帐应用。用 Claude Code CLI 作为后端大脑，帮你整理碎碎念、追踪习惯、生成日周摘要、绘制任务关联图谱。

## ✨ 它能帮你做什么

- **随手记录** —— 写下碎碎念、待办、灵感，打标签分类
- **AI 整理思路** —— 让 CC 帮你智能查找、整理标签、生成日/周摘要、绘制任务图谱
- **习惯养成** —— 上传任何书籍 ZIP（饮食、运动、观鸟手册…），每天抽一张习惯卡打卡
- **任务盲盒** —— 迷茫时随机抽一条待办，让 AI 帮你做决定
- **定时提醒** —— 设置未来时间点，到点系统通知
- **25 款主题** —— 焦糖布丁、慵懒晨光、薄荷生巧… 还支持自定义配色

---

## 🚀 使用方法

有两种使用方式，选一个喜欢的。

### 方式一：下载 Mac 桌面 App（推荐 Mac 用户）

最简单，不需要装 Node.js，双击就能用。

#### 下载

历史版本都放在 GitHub Releases 页，每个版本附带更新说明。

👉 **[前往 Releases 下载最新版](https://github.com/AnselKocen/pls_collect_my_task/releases)**

#### 安装

1. 下载最新版的 `.dmg` 文件
2. 双击打开，把「记忆手帐」图标拖到「应用程序」文件夹
3. 首次打开时，macOS 可能提示"来自身份不明开发者"，需要到「系统设置 → 隐私与安全性」里点「仍要打开」
4. 之后从启动台或 Spotlight 搜「记忆手帐」就能启动

#### 配置 Claude CLI（AI 功能需要）

桌面版首次启动时：
- 如果你已经在终端装过 `claude`，app 会自动检测，无需操作
- 如果没检测到，会弹窗让你手动选 `claude` 可执行文件路径（通常在 `/opt/homebrew/bin/claude`）
- 如果还没登录，在终端运行一次 `claude` 完成登录即可，**不需要重启 app**

> ⚠️ 目前只提供 **Mac ARM64（Apple Silicon）** 版本。Intel Mac 和 Windows 用户请走方式二。

---

### 方式二：Git Clone 运行源码（Mac / Windows / Linux 都支持）

适合开发者、Intel Mac 用户、Windows 用户、想折腾的用户。

#### 1. 准备环境

**Node.js v18+**

检查是否已装，终端/命令行运行：

```bash
node -v
```

有版本号输出（比如 `v20.11.0`）即可。没装的话：

- **Mac**：`brew install node` 或从 https://nodejs.org 下载 LTS 版
- **Windows**：从 https://nodejs.org 下载 LTS 版，或 `winget install OpenJS.NodeJS.LTS`
- **Linux**：`sudo apt install nodejs npm` 或对应发行版的包管理器

**Claude Code CLI**（可选，AI 功能需要）

```bash
npm install -g @anthropic-ai/claude-code
```

装完在终端运行一次 `claude` 完成首次登录（需要 Anthropic Max 订阅或 API Key）。

> 不需要 AI 功能可以跳过这步，基础便签功能仍然可用。

#### 2. 克隆项目

```bash
git clone https://github.com/AnselKocen/pls_collect_my_task.git
cd pls_collect_my_task
```

#### 3. 启动

**Mac / Linux：**

```bash
chmod +x start.sh stop.sh
./start.sh       # 启动
./stop.sh        # 停止
```

**Windows：**

双击 `start.bat`，或在命令行运行：

```cmd
start.bat        REM 启动
stop.bat         REM 停止
```

启动后浏览器会自动打开 http://localhost:3013

#### 关于终端窗口

启动脚本会把服务放到后台运行，**可以关闭启动时的终端窗口**，服务会继续运行。想停止时运行 `./stop.sh`（Mac/Linux）或 `stop.bat`（Windows）。

> ⚠️ Windows 小注意：直接点窗口右上角 × 关闭命令行有小概率连带停止后台服务，推荐用 `stop.bat` 正常停止。

---

## 📚 功能介绍

### 📝 便签管理
- 快速记录、编辑、删除、置顶
- 自定义标签 + emoji + 胶带样式
- 标签筛选、关键词搜索
- 看板视图按标签分组展示

### 🤖 智能助手（需要 Claude Code CLI）
- **智能查找** —— 输入你想找的东西，AI 从所有便签里找出最相关的
- **整理标签** —— AI 分析便签，建议合并或新增标签
- **任务图谱** —— 可视化展示便签之间的关联关系
- **今日摘要** —— 每天 23:00 自动汇总最近两天的手帐（也可手动触发）
- **本周总结** —— 每周日 23:59 自动生成一周深度总结与标签趋势（也可手动触发）

### 🌻 特色玩法
- **习惯养成** —— 上传书籍 ZIP（饮食、运动、观鸟手册等），AI 从书里生成习惯卡池，每天抽一张打卡，填满打卡日历
- **任务盲盒** —— 选几个标签，随机抽一条待办，让 AI 帮你做决定
- **定时提醒** —— 设置未来日期+时间，到点系统通知

### 🎨 主题配色
- 25 款预设主题（焦糖布丁、慵懒晨光、柔雾马卡龙、莓莓粉荔、湖光暖岸、晴川浅夏、糖果马卡龙、薄荷生巧…）
- 自定义配色
- 每个标签可单独设置 emoji 和胶带样式

---

## ❓ 常见问题

### Q：点 AI 按钮没反应，按钮闪一下就恢复了，也没弹窗

**大概率是 Claude Code CLI 没登录，或登录态过期了。**

解决：

1. 打开终端
2. 运行 `claude`（或 `/opt/homebrew/bin/claude`）
3. 按提示完成登录
4. 回到 app 重试，**不需要重启 app**

怎么确认是这个问题？按 `Cmd+Option+I` 打开 DevTools → Console，再点一次 AI 按钮，如果看到 `CC 调用失败` 或 `Claude exited with code ...` 之类，基本就是登录问题。

### Q：今日摘要/本周总结没有自动生成

**自动生成需要 app 在对应时间点处于运行状态。**

- 今日摘要：每天 23:00 触发
- 本周总结：每周日 23:59 触发

如果那一刻 app 没开，就会错过那次自动触发。你可以随时手动点「重新生成」补上。

### Q：AI 操作要多久才出结果？

取决于 Claude 模型的响应速度和你的便签数量，通常 **5-30 秒**。期间 CC 会显示"正在思考"状态。

⚠️ **CC 一次只能做一件事**，正在跑一个 AI 任务时其他 AI 按钮会提示"CC 正在忙，等它忙完吧~"

### Q：升级新版 app 后，之前的数据还在吗？

**在。** Mac 桌面版数据存在 `~/Library/Application Support/记忆手帐/data/`，覆盖安装不会动这个目录。源码运行版数据存在项目根目录的 `data/`。

### Q：我想改每日摘要的时间

在设置面板里可以改「每日整理时间」。本周总结时间（周日 23:59）目前是固定默认值，需要手动改 `data/settings.json` 里的 `weeklyDigestDay` 和 `weeklyDigestTime`。

### Q：Windows 桌面版什么时候有？

暂时没有。Windows 用户请走方式二（Git Clone 源码运行）。

### Q：不想用 AI 功能也能用吗？

可以。没有 Claude CLI 的话，便签管理、标签筛选、搜索、看板、主题切换、定时提醒这些功能都能正常用，只是智能助手和习惯养成的部分功能会不可用。

---

## 📜 协议

GPL-3.0 + 非商用限制，详见 [LICENSE](LICENSE)

未经作者书面许可，不得将本软件用于商业用途。

## 作者

Anselkocen
