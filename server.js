const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID: uuidv4 } = require('crypto');
const cron = require('node-cron');
const { execFile } = require('child_process');
const multer = require('multer');
const AdmZip = require('adm-zip');

const app = express();
const PORT = process.env.PORT || 3013;
const DATA_DIR = process.env.MEMO_DATA_DIR || path.join(__dirname, 'data');

// Auto-detect Claude CLI path
const CLAUDE_CLI_CANDIDATES = [
  process.env.CLAUDE_CLI,                                                    // User override
  '/opt/homebrew/bin/claude',                                                // Mac (Apple Silicon)
  '/usr/local/bin/claude',                                                   // Mac (Intel) / Linux
  '/usr/bin/claude',                                                         // Linux
  (process.env.HOME || '') + '/.claude/local/claude',                        // Mac/Linux local
  (process.env.APPDATA || '') + '\\npm\\claude.cmd',                         // Windows (npm global)
  (process.env.APPDATA || '') + '\\npm\\claude.ps1',                         // Windows (npm global, ps)
  (process.env.APPDATA || '') + '/claude/claude.exe',                        // Windows (legacy)
  (process.env.LOCALAPPDATA || '') + '/Programs/claude/claude.exe',          // Windows (legacy)
].filter(Boolean);

function findClaudeCli() {
  for (const p of CLAUDE_CLI_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  // fallback: hope it's in PATH
  return 'claude';
}

const CLAUDE_CLI = findClaudeCli();

app.use(express.json());
// In packaged app, server.js is in app.asar.unpacked/ but public/ is in app.asar
// Resolve by replacing 'app.asar.unpacked' with 'app.asar' for static files
const STATIC_DIR = path.join(__dirname.replace('app.asar.unpacked', 'app.asar'), 'public');
app.use(express.static(STATIC_DIR));

// Multer for habit ZIP upload
const habitUpload = multer({ dest: path.join(DATA_DIR, 'habit_upload') });

// --- Helpers ---
function readJSON(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'));
}

function writeJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2), 'utf-8');
}

// ISO 8601 week number (Monday-based)
function getISOWeek(d) {
  const date = new Date(d.getTime());
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
  const week1 = new Date(date.getFullYear(), 0, 4);
  return 1 + Math.round(((date - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}

// Per-file promise queue to serialize read-modify-write operations
const fileLocks = {};
function withFileLock(file, fn) {
  if (!fileLocks[file]) fileLocks[file] = Promise.resolve();
  const prev = fileLocks[file];
  const next = prev.then(fn, fn);
  fileLocks[file] = next.catch(() => {});
  return next;
}

// Ensure data files exist on first run
function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const now = new Date().toISOString();
  const defaults = {
    'memos.json': { memos: [
      {
        id: 'welcome-1',
        content: '欢迎来到记忆手帐Memo Journal ~ 尽情探索吧 ❤️ 点击「智能助手」tag查看指南',
        tags: ['欢迎'],
        createdAt: now, updatedAt: now, pinned: true
      },
      {
        id: 'welcome-2',
        content: '习惯养成✨ - 上传任何你想养成习惯的书籍，例如饮食、运动，甚至观鸟手册。每天抽取你的习惯卡片🃏，坚持然后填满打卡日历吧！',
        tags: ['特色玩法'],
        createdAt: now, updatedAt: now, pinned: true
      },
      {
        id: 'welcome-3',
        content: '这是一个专属于你的便签手帐本，cc作为你的小助理，能帮你完成一系列任务。需要先登录Claude code CLI才能使用cc相关功能哦💗',
        tags: ['指南'],
        createdAt: now, updatedAt: now, pinned: true
      },
      {
        id: 'welcome-4',
        content: 'cc一次只能做一件事……',
        tags: ['cc'],
        createdAt: now, updatedAt: now
      },
      {
        id: 'welcome-5',
        content: '小技巧：按CMD+R可以刷新噢',
        tags: ['tips'],
        createdAt: now, updatedAt: now
      }
    ] },
    'settings.json': {
      dailyDigestTime: '23:55',
      weeklyDigestDay: 'sunday',
      weeklyDigestTime: '23:59',
      tags: ['欢迎', '特色玩法', '指南', 'cc', 'tips'],
      tagOrder: ['欢迎', '特色玩法', '指南', 'cc', 'tips'],
      tagEmojis: { '欢迎': '🍮', '特色玩法': '🍯', '指南': '🍩', 'cc': '🧁', 'tips': '💫' },
      tagTapes: { '欢迎': 'tape-3', '特色玩法': 'tape-4', '指南': 'tape-1', 'cc': 'tape-6', 'tips': 'tape-8' }
    },
    'ai_suggestions.json': {
      dailyDigest: null,
      weeklyDigest: null,
      tagSuggestions: [],
      graphHistory: []
    },
    'habit_pools.json': { pools: [{
      id: 'default-pool',
      name: '每天一个小习惯',
      description: '每天微小改变，积累非凡人生力量',
      habits: [
        '每天阅读十页书','起床后立刻叠被子','记录今日三件好事',
        '喝水前先深呼吸三次','手机放到另一个房间','出门前默念今日目标',
        '饭后散步十分钟','睡前写一句反思日记','用两分钟整理桌面',
        '每餐先吃蔬菜','晨起做五个俯卧撑','提前准备明天衣物',
        '专注工作前戴上耳机','用习惯打卡表记录进度','对镜微笑说一句肯定',
        '把零食换到高处柜子','新习惯绑定旧习惯后','完成任务后奖励自己',
        '睡前远离所有屏幕','每周回顾一次习惯清单','站立办公十五分钟',
        '午饭后冥想两分钟','随身带一瓶水','学一个新单词或概念',
        '主动向一个人表达感谢','把困难任务拆成小步','固定时间固定地点学习',
        '运动前播放专属歌曲','睡前提前准备运动装备','对坏习惯大声说出理由'
      ],
      sourceFile: '内置卡池',
      createdAt: now
    }] },
    'habit_log.json': { logs: [] },
    'scheduled_tasks.json': { tasks: [] }
  };
  for (const [file, data] of Object.entries(defaults)) {
    const fp = path.join(DATA_DIR, file);
    if (!fs.existsSync(fp)) {
      fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8');
    }
  }
  // Migrate old weekly digest time (10:00) to new default (23:59)
  try {
    const settings = readJSON('settings.json');
    if (settings.weeklyDigestTime === '10:00') {
      settings.weeklyDigestTime = '23:59';
      writeJSON('settings.json', settings);
    }
  } catch {}
}

ensureDataFiles();

// --- Memos ---
app.get('/api/memos', (req, res) => {
  const { memos } = readJSON('memos.json');
  const { tag, keyword } = req.query;
  let result = memos;
  if (tag) {
    const tags = tag.split(',');
    result = result.filter(m => m.tags.some(t => tags.includes(t)));
  }
  if (keyword) {
    const kw = keyword.toLowerCase();
    result = result.filter(m => m.content.toLowerCase().includes(kw));
  }
  result.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || new Date(b.createdAt) - new Date(a.createdAt));
  res.json(result);
});

app.post('/api/memos', async (req, res) => {
  const { content, tags } = req.body;
  if (!content) return res.status(400).json({ error: '内容不能为空' });
  const memo = await withFileLock('memos.json', () => {
    const data = readJSON('memos.json');
    const m = {
      id: uuidv4(),
      content,
      tags: tags || [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    data.memos.push(m);
    writeJSON('memos.json', data);
    return m;
  });
  res.json(memo);
});

app.get('/api/memos/random', (req, res) => {
  const { memos } = readJSON('memos.json');
  let pool = memos;
  if (req.query.tags) {
    const tags = req.query.tags.split(',');
    pool = pool.filter(m => m.tags.some(t => tags.includes(t)));
  }
  if (pool.length === 0) return res.json(null);
  res.json(pool[Math.floor(Math.random() * pool.length)]);
});

app.put('/api/memos/:id', async (req, res) => {
  try {
    const result = await withFileLock('memos.json', () => {
      const data = readJSON('memos.json');
      const idx = data.memos.findIndex(m => m.id === req.params.id);
      if (idx === -1) return null;
      const { content, tags, pinned } = req.body;
      if (content !== undefined) data.memos[idx].content = content;
      if (tags !== undefined) data.memos[idx].tags = tags;
      if (pinned !== undefined) data.memos[idx].pinned = pinned;
      data.memos[idx].updatedAt = new Date().toISOString();
      writeJSON('memos.json', data);
      return data.memos[idx];
    });
    if (!result) return res.status(404).json({ error: '未找到' });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/memos/:id', async (req, res) => {
  await withFileLock('memos.json', () => {
    const data = readJSON('memos.json');
    data.memos = data.memos.filter(m => m.id !== req.params.id);
    writeJSON('memos.json', data);
  });
  res.json({ ok: true });
});

// --- Tags ---
app.get('/api/tags', (req, res) => {
  const settings = readJSON('settings.json');
  res.json(settings.tags);
});

app.post('/api/tags', async (req, res) => {
  const { tag, emoji } = req.body;
  if (!tag) return res.status(400).json({ error: '标签不能为空' });
  const tags = await withFileLock('settings.json', () => {
    const settings = readJSON('settings.json');
    if (!settings.tags.includes(tag)) {
      settings.tags.push(tag);
    }
    if (!settings.tagOrder) settings.tagOrder = [];
    if (!settings.tagOrder.includes(tag)) settings.tagOrder.push(tag);
    if (emoji) {
      if (!settings.tagEmojis) settings.tagEmojis = {};
      settings.tagEmojis[tag] = emoji;
    }
    writeJSON('settings.json', settings);
    return settings.tags;
  });
  res.json(tags);
});

app.delete('/api/tags/:tag', async (req, res) => {
  const tag = decodeURIComponent(req.params.tag);
  const tags = await withFileLock('settings.json', () => {
    const settings = readJSON('settings.json');
    settings.tags = settings.tags.filter(t => t !== tag);
    if (settings.tagEmojis) delete settings.tagEmojis[tag];
    if (settings.tagTapes) delete settings.tagTapes[tag];
    if (settings.tagOrder) settings.tagOrder = settings.tagOrder.filter(t => t !== tag);
    writeJSON('settings.json', settings);
    return settings.tags;
  });
  await withFileLock('memos.json', () => {
    const data = readJSON('memos.json');
    data.memos = data.memos.filter(m => !m.tags.includes(tag));
    writeJSON('memos.json', data);
  });
  res.json({ ok: true, tags });
});

app.put('/api/tags/:tag', async (req, res) => {
  const oldTag = decodeURIComponent(req.params.tag);
  const { newTag } = req.body;
  if (!newTag || !newTag.trim()) return res.status(400).json({ error: 'empty' });
  const name = newTag.trim();
  const result = await withFileLock('settings.json', () => {
    const settings = readJSON('settings.json');
    if (!settings.tags) settings.tags = [];
    if (settings.tags.includes(name) && name !== oldTag) return { error: 'exists' };
    settings.tags = settings.tags.map(t => t === oldTag ? name : t);
    if (settings.tagTapes && settings.tagTapes[oldTag] !== undefined) { settings.tagTapes[name] = settings.tagTapes[oldTag]; delete settings.tagTapes[oldTag]; }
    if (settings.tagEmojis && settings.tagEmojis[oldTag] !== undefined) { settings.tagEmojis[name] = settings.tagEmojis[oldTag]; delete settings.tagEmojis[oldTag]; }
    if (settings.tagOrder) settings.tagOrder = settings.tagOrder.map(t => t === oldTag ? name : t);
    writeJSON('settings.json', settings);
    return { tags: settings.tags };
  });
  if (result.error) return res.status(409).json({ error: result.error });
  await withFileLock('memos.json', () => {
    const data = readJSON('memos.json');
    data.memos.forEach(m => { m.tags = m.tags.map(t => t === oldTag ? name : t); });
    writeJSON('memos.json', data);
  });
  res.json({ ok: true, tags: result.tags });
});

// --- Settings ---
app.get('/api/settings', (req, res) => {
  res.json(readJSON('settings.json'));
});

app.put('/api/settings', async (req, res) => {
  const updated = await withFileLock('settings.json', () => {
    const settings = readJSON('settings.json');
    const allowed = ['dailyDigestTime', 'weeklyDigestDay', 'weeklyDigestTime', 'tagOrder', 'tagTapes', 'tagEmojis', 'theme', 'customColors'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) settings[key] = req.body[key];
    }
    writeJSON('settings.json', settings);
    return settings;
  });
  scheduleCronJobs();
  res.json(updated);
});

// --- CC (Claude Code) Integration ---
const { spawn } = require('child_process');

let ccBusy = false;
let ccCurrentTask = '';

app.get('/api/cc/status', (req, res) => {
  res.json({ busy: ccBusy, task: ccCurrentTask });
});

function callClaude(prompt, taskName = '') {
  if (ccBusy) return Promise.reject(new Error(`CC_BUSY:${ccCurrentTask}`));
  ccBusy = true;
  ccCurrentTask = taskName;
  return new Promise((resolve, reject) => {
    console.log(`[CC] Calling claude, task=${taskName}, prompt length: ${prompt.length}, HOME=${process.env.HOME}`);
    let child;
    if (process.platform === 'win32') {
      // Windows: spawn .cmd/.ps1 requires shell:true; PATH uses ';' separator, keep as-is
      child = spawn(CLAUDE_CLI, ['--output-format', 'text', '-p', prompt], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
        env: {
          ...process.env,
          HOME: process.env.HOME || process.env.USERPROFILE,
        },
        cwd: DATA_DIR
      });
    } else {
      child = spawn(CLAUDE_CLI, ['--output-format', 'text', '-p', prompt], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          HOME: process.env.HOME || process.env.USERPROFILE,
          PATH: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH || ''].join(':'),
        },
        cwd: DATA_DIR
      });
    }

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    child.on('close', (code, signal) => {
      ccBusy = false; ccCurrentTask = '';
      console.log(`[CC] Claude exited: code=${code}, signal=${signal}, stdout=${stdout.length}bytes, stderr=${stderr.substring(0, 200)}`);
      // Use stdout if available, even if exit code is non-zero
      if (stdout.trim()) {
        resolve(stdout.trim());
      } else if (code !== 0) {
        reject(new Error(`Claude exited with code ${code}: ${stderr}`));
      } else {
        resolve('');
      }
    });

    child.on('error', (err) => {
      ccBusy = false; ccCurrentTask = '';
      console.error('[CC] Spawn error:', err);
      reject(err);
    });

    // Manual timeout
    const timer = setTimeout(() => {
      console.log('[CC] Timeout, killing process');
      child.kill('SIGTERM');
    }, 120000);

    child.on('close', () => clearTimeout(timer));
  });
}

app.post('/api/cc/ask', async (req, res) => {
  const { action, params } = req.body;
  const taskNames = { 'search':'智能搜索', 'tag-suggestions':'整理标签建议', 'graph':'生成知识图谱', 'discuss-tag':'标签总结', 'daily-digest':'今日摘要', 'weekly-digest':'本周总结' };
  const taskName = taskNames[action] || action;
  try {
    const { memos } = readJSON('memos.json');
    const settings = readJSON('settings.json');
    const suggestions = readJSON('ai_suggestions.json');
    let prompt, result;

    switch (action) {
      case 'search': {
        const memosText = memos.map(m => `(${m.tags.join(',')}) ${m.content}`).join('\n');
        prompt = `你是一个手帐助手。用户想找: "${params.query}"。根据以下手帐内容，提取最可能匹配的搜索关键词（中文）。返回JSON数组，只包含关键词字符串，例如["关键词1","关键词2"]。最多5个关键词。只返回JSON。\n\n手帐:\n${memosText}`;
        result = await callClaude(prompt, taskName);
        try {
          const jsonMatch = result.match(/\[[\s\S]*?\]/);
          const keywords = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
          // Use keywords to filter memos locally
          const matched = memos.filter(m => {
            const text = m.content.toLowerCase();
            return keywords.some(kw => text.includes(kw.toLowerCase()));
          });
          return res.json({ type: 'search', keywords, results: matched.map(m => m.id) });
        } catch { return res.json({ type: 'search', keywords: [], results: [] }); }
      }

      case 'tag-suggestions': {
        const tagCounts = {};
        settings.tags.forEach(t => { tagCounts[t] = 0; });
        memos.forEach(m => m.tags.forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));
        const tagInfo = Object.entries(tagCounts).map(([t, c]) => `${t}: ${c}条`).join('\n');
        const tagMemosDetail = settings.tags.map(t => {
          const tagMemos = memos.filter(m => m.tags.includes(t));
          const items = tagMemos.slice(0, 20).map(m => `  - ${m.content}`).join('\n');
          return `【${t}】(${tagMemos.length}条)\n${items || '  (空)'}`;
        }).join('\n\n');
        prompt = `你是一个手帐助手。分析以下标签的使用情况和具体内容，给出合并或清理建议。返回JSON数组，每项包含action("merge"或"review")、tags(数组)、reason字段。只返回JSON。\n\n标签统计:\n${tagInfo}\n\n各标签下的具体内容:\n${tagMemosDetail}`;
        result = await callClaude(prompt, taskName);
        try {
          const jsonMatch = result.match(/\[[\s\S]*\]/);
          const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
          suggestions.tagSuggestions = parsed;
          if (!suggestions.tagSuggestionHistory) suggestions.tagSuggestionHistory = [];
          suggestions.tagSuggestionHistory.unshift({ suggestions: parsed, generatedAt: new Date().toISOString() });
          writeJSON('ai_suggestions.json', suggestions);
          return res.json({ type: 'tag-suggestions', suggestions: parsed });
        } catch { return res.json({ type: 'tag-suggestions', suggestions: [], raw: result }); }
      }

      case 'graph': {
        let graphMemos = memos;
        const scopeTags = (params && params.tags && params.tags.length > 0) ? params.tags : [...new Set(memos.flatMap(m => m.tags))];
        if (params && params.tags && params.tags.length > 0) {
          graphMemos = memos.filter(m => m.tags.some(t => params.tags.includes(t)));
        }
        const memosText = graphMemos.slice(0, 100).map(m => `[${m.id}] (${m.tags.join(',')}) ${m.content}`).join('\n');
        const tagsListStr = scopeTags.join('、');
        prompt = `你是一个手帐助手。请完成以下分析任务，一次性返回所有结果。

任务1：分析以下手帐之间的内容关联，生成知识图谱的节点和边。
任务2：针对以下每个标签（${tagsListStr}）下的内容进行整理和讨论，总结要点、发现规律、给出建议。
任务3：跨标签发散思考，找出隐藏的关联、有趣的发现、或者可以进一步探索的方向。

返回JSON对象，格式如下（只返回JSON，不要其他内容）：
{
  "nodes": [{"id": "1", "label": "节点名", "tag": "所属标签"}],
  "edges": [{"source": "1", "target": "2", "relation": "关系描述"}],
  "summaries": [{"tag": "标签名", "summary": "该标签的总结分析"}],
  "insights": "跨标签的发散思考和关联发现（用markdown格式）"
}

手帐内容:
${memosText}`;
        result = await callClaude(prompt, taskName);
        try {
          const jsonMatch = result.match(/\{[\s\S]*\}/);
          const graphData = jsonMatch ? JSON.parse(jsonMatch[0]) : { nodes: [], edges: [], summaries: [], insights: '' };
          if (!suggestions.graphHistory) suggestions.graphHistory = [];
          const entry = {
            id: uuidv4(),
            nodes: graphData.nodes || [],
            edges: graphData.edges || [],
            summaries: graphData.summaries || [],
            insights: graphData.insights || '',
            tags: scopeTags,
            generatedAt: new Date().toISOString()
          };
          suggestions.graphHistory.push(entry);
          writeJSON('ai_suggestions.json', suggestions);
          return res.json({ type: 'graph', graph: entry });
        } catch { return res.json({ type: 'graph', graph: { nodes: [], edges: [], summaries: [], insights: '', generatedAt: null }, raw: result }); }
      }

      case 'daily-digest': {
        const weekdays = ['周日','周一','周二','周三','周四','周五','周六'];
        const now = new Date();
        const today = now.toISOString().split('T')[0];
        const yesterday = new Date(now - 86400000);
        const yesterdayStr = yesterday.toISOString().split('T')[0];
        const fmtDate = (d) => `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
        const yesterdayLabel = fmtDate(yesterday);
        const todayLabel = fmtDate(now);
        const yesterdayMemos = memos.filter(m => m.createdAt.startsWith(yesterdayStr));
        const todayMemos = memos.filter(m => m.createdAt.startsWith(today));
        const yesterdayText = yesterdayMemos.map(m => `- (${m.tags.join(',')}) ${m.content}`).join('\n');
        const todayText = todayMemos.map(m => `- (${m.tags.join(',')}) ${m.content}`).join('\n');
        prompt = `你是一个手帐助手。请根据以下两天的手帐内容生成摘要。返回JSON对象，包含date、summary、tasks(数组)字段。
summary的格式要求：
· ${yesterdayLabel}，概述当天的主要内容
· ${todayLabel}，概述当天的主要内容
每个日期单独一段，前面用"· "开头。如果某天没有内容就写"暂无记录"。
只返回JSON。\n\n${yesterdayLabel}的手帐:\n${yesterdayText || '(暂无记录)'}\n\n${todayLabel}的手帐:\n${todayText || '(暂无记录)'}`;
        result = await callClaude(prompt, taskName);
        try {
          const jsonMatch = result.match(/\{[\s\S]*\}/);
          suggestions.dailyDigest = jsonMatch ? JSON.parse(jsonMatch[0]) : { date: today, summary: '暂无内容', tasks: [] };
          writeJSON('ai_suggestions.json', suggestions);
          return res.json({ type: 'daily-digest', digest: suggestions.dailyDigest });
        } catch { return res.json({ type: 'daily-digest', digest: { date: today, summary: result, tasks: [] } }); }
      }

      case 'weekly-digest': {
        const now = new Date();
        const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
        let weekMemos = memos.filter(m => new Date(m.createdAt) >= weekAgo);
        const filterTags = params && params.tags && params.tags.length > 0 ? params.tags : null;
        if (filterTags) {
          weekMemos = weekMemos.filter(m => m.tags.some(t => filterTags.includes(t)));
        }
        const tagLabel = filterTags ? `（范围：${filterTags.join('、')}）` : '';
        const memosText = weekMemos.map(m => `- (${m.tags.join(',')}) ${m.content} [${m.createdAt.split('T')[0]}]`).join('\n');
        prompt = `你是一个手帐助手。总结过去一周的手帐${tagLabel}，分析标签趋势，生成深度总结。返回JSON对象，包含week、summary、tagTrends(对象)字段。只返回JSON。\n\n本周备忘:\n${memosText || '(本周暂无手帐)'}`;
        result = await callClaude(prompt, taskName);
        try {
          const jsonMatch = result.match(/\{[\s\S]*\}/);
          const weekStr = `${now.getFullYear()}-W${String(getISOWeek(now)).padStart(2, '0')}`;
          const digest = jsonMatch ? JSON.parse(jsonMatch[0]) : { week: weekStr, summary: result };
          if (filterTags) digest.tags = filterTags;
          digest.generatedAt = new Date().toISOString();
          // Save to array
          if (!suggestions.weeklyDigests) suggestions.weeklyDigests = [];
          suggestions.weeklyDigests.unshift(digest);
          suggestions.weeklyDigest = digest; // backward compat
          writeJSON('ai_suggestions.json', suggestions);
          return res.json({ type: 'weekly-digest', digest });
        } catch { return res.json({ type: 'weekly-digest', digest: { summary: result, generatedAt: new Date().toISOString() } }); }
      }

      default:
        return res.status(400).json({ error: '未知操作' });
    }
  } catch (err) {
    console.error('CC error:', err.message);
    if (err.message.startsWith('CC_BUSY:')) {
      const busyTask = err.message.replace('CC_BUSY:', '');
      return res.status(409).json({ error: `CC正在忙「${busyTask}」，等它忙完吧～`, busy: true, currentTask: busyTask });
    }
    res.status(500).json({ error: 'CC 调用失败: ' + err.message });
  }
});

app.get('/api/cc/suggestions', (req, res) => {
  res.json(readJSON('ai_suggestions.json'));
});

// Delete tag summary by index
app.delete('/api/cc/tag-summary/:index', async (req, res) => {
  await withFileLock('ai_suggestions.json', () => {
    const suggestions = readJSON('ai_suggestions.json');
    const idx = parseInt(req.params.index);
    if (suggestions.tagSummaries && idx >= 0 && idx < suggestions.tagSummaries.length) {
      suggestions.tagSummaries.splice(idx, 1);
      writeJSON('ai_suggestions.json', suggestions);
    }
  });
  res.json({ ok: true });
});

// Delete weekly digest by index
app.delete('/api/cc/weekly-digest/:index', async (req, res) => {
  await withFileLock('ai_suggestions.json', () => {
    const suggestions = readJSON('ai_suggestions.json');
    const idx = parseInt(req.params.index);
    if (suggestions.weeklyDigests && idx >= 0 && idx < suggestions.weeklyDigests.length) {
      suggestions.weeklyDigests.splice(idx, 1);
      writeJSON('ai_suggestions.json', suggestions);
    }
  });
  res.json({ ok: true });
});

// Delete tag suggestion by index
app.delete('/api/cc/tag-suggestion/:index', async (req, res) => {
  await withFileLock('ai_suggestions.json', () => {
    const suggestions = readJSON('ai_suggestions.json');
    const idx = parseInt(req.params.index);
    if (suggestions.tagSuggestionHistory && idx >= 0 && idx < suggestions.tagSuggestionHistory.length) {
      suggestions.tagSuggestionHistory.splice(idx, 1);
      writeJSON('ai_suggestions.json', suggestions);
    }
  });
  res.json({ ok: true });
});

// Delete a specific graph from history
app.delete('/api/cc/graph/:id', async (req, res) => {
  await withFileLock('ai_suggestions.json', () => {
    const suggestions = readJSON('ai_suggestions.json');
    if (!suggestions.graphHistory) suggestions.graphHistory = [];
    suggestions.graphHistory = suggestions.graphHistory.filter(g => g.id !== req.params.id);
    // Also clean up legacy taskGraph if the migrated entry is being deleted
    if (req.params.id === 'migrated' && suggestions.taskGraph) {
      delete suggestions.taskGraph;
    }
    writeJSON('ai_suggestions.json', suggestions);
  });
  res.json({ ok: true });
});

// --- Habit Building ---
app.get('/api/habit/pools', (req, res) => {
  res.json(readJSON('habit_pools.json'));
});

app.post('/api/habit/pools/generate', habitUpload.single('zipFile'), async (req, res) => {
  const uploadedFile = req.file;
  if (!uploadedFile) return res.status(400).json({ error: '请上传ZIP文件' });

  const extractId = uuidv4();
  const extractDir = path.join(DATA_DIR, 'habit_upload', extractId);

  try {
    // Extract ZIP
    const zip = new AdmZip(uploadedFile.path);
    zip.extractAllTo(extractDir, true);

    // Read extracted file contents (text files only, truncate if too long)
    function readDirRecursive(dir) {
      let content = '';
      const items = fs.readdirSync(dir);
      for (const item of items) {
        if (item.startsWith('.') || item === '__MACOSX') continue;
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) { content += readDirRecursive(fullPath); }
        else {
          const ext = path.extname(item).toLowerCase();
          if (['.txt', '.md', '.html', '.htm', '.csv', '.json', '.xml', '.epub'].includes(ext) || !ext) {
            try {
              let text = fs.readFileSync(fullPath, 'utf-8');
              if (text.length > 30000) text = text.substring(0, 30000) + '\n...(截断)';
              content += `\n--- ${item} ---\n${text}\n`;
            } catch {}
          }
        }
      }
      return content;
    }

    let bookContent = readDirRecursive(extractDir);
    if (bookContent.length > 80000) bookContent = bookContent.substring(0, 80000) + '\n...(内容过长，已截断)';
    if (!bookContent.trim()) throw new Error('ZIP中没有找到可读的文本文件');

    // Call CC with the actual content
    const prompt = `以下是一本书的内容：

${bookContent}

请基于这本书的核心思想，总结出30个通用的、可执行的日常习惯。每个习惯用一句简短的中文描述（不超过15个字）。
这些习惯应该具有通用性，适合日常养成，涵盖书中提到的各个方面。
同时为这组习惯想一个5个汉字以内的名字（有意境，与书的主题相关，例如"微习惯养成"、"清晨唤醒术"、"心流工作法"）。
再用一句话（不超过20个字）介绍这个卡池是关于什么的。
返回JSON: {"name": "五字名", "description": "一句话介绍", "habits": ["习惯1", "习惯2", ...]}。只返回JSON，不要其他内容。`;

    const result = await callClaude(prompt, '生成习惯卡池');
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('CC返回格式错误');

    const parsed = JSON.parse(jsonMatch[0]);
    const pool = {
      id: uuidv4(),
      name: parsed.name || '习惯卡池',
      description: parsed.description || '',
      habits: (parsed.habits || []).slice(0, 30),
      sourceFile: uploadedFile.originalname,
      createdAt: new Date().toISOString()
    };

    const data = readJSON('habit_pools.json');
    data.pools.push(pool);
    writeJSON('habit_pools.json', data);

    res.json({ pool });
  } catch (err) {
    console.error('[Habit] Generate error:', err.message);
    if (err.message.startsWith('CC_BUSY:')) {
      const busyTask = err.message.replace('CC_BUSY:', '');
      return res.status(409).json({ error: `CC正在忙「${busyTask}」，等它忙完吧～`, busy: true });
    }
    res.status(500).json({ error: '生成失败: ' + err.message });
  } finally {
    // Cleanup temp files
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(uploadedFile.path); } catch {}
  }
});

app.put('/api/habit/pools/:id', async (req, res) => {
  const result = await withFileLock('habit_pools.json', () => {
    const data = readJSON('habit_pools.json');
    const pool = data.pools.find(p => p.id === req.params.id);
    if (!pool) return null;
    if (req.body.name) pool.name = req.body.name;
    if (req.body.habits) pool.habits = req.body.habits;
    writeJSON('habit_pools.json', data);
    return pool;
  });
  if (!result) return res.status(404).json({ error: '卡池不存在' });
  res.json({ pool: result });
});

app.delete('/api/habit/pools/:id', async (req, res) => {
  await withFileLock('habit_pools.json', () => {
    const data = readJSON('habit_pools.json');
    data.pools = data.pools.filter(p => p.id !== req.params.id);
    writeJSON('habit_pools.json', data);
  });
  res.json({ ok: true });
});

app.get('/api/habit/today', (req, res) => {
  const { logs } = readJSON('habit_log.json');
  const today = new Date().toISOString().split('T')[0];
  const todayLogs = logs.filter(l => l.date === today);
  res.json({ logs: todayLogs });
});

app.post('/api/habit/draw', async (req, res) => {
  const { poolId } = req.body;
  if (!poolId) return res.status(400).json({ error: '请选择卡池' });

  const poolData = readJSON('habit_pools.json');
  const pool = poolData.pools.find(p => p.id === poolId);
  if (!pool) return res.status(404).json({ error: '卡池不存在' });
  if (!pool.habits.length) return res.status(400).json({ error: '卡池为空' });

  const entry = await withFileLock('habit_log.json', () => {
    const logData = readJSON('habit_log.json');
    const today = new Date().toISOString().split('T')[0];
    const habit = pool.habits[Math.floor(Math.random() * pool.habits.length)];
    const e = {
      id: uuidv4(),
      date: today,
      habit,
      poolId: pool.id,
      poolName: pool.name,
      completed: false,
      drawnAt: new Date().toISOString(),
      completedAt: null
    };
    logData.logs.push(e);
    writeJSON('habit_log.json', logData);
    return e;
  });
  res.json({ log: entry });
});

app.get('/api/habit/log', (req, res) => {
  const { logs } = readJSON('habit_log.json');
  const { month, date } = req.query;
  let result = logs;
  if (date) result = result.filter(l => l.date === date);
  else if (month) result = result.filter(l => l.date.startsWith(month));
  result.sort((a, b) => b.date.localeCompare(a.date));
  res.json({ logs: result });
});

app.put('/api/habit/log/:id/complete', async (req, res) => {
  const result = await withFileLock('habit_log.json', () => {
    const data = readJSON('habit_log.json');
    const entry = data.logs.find(l => l.id === req.params.id);
    if (!entry) return null;
    entry.completed = true;
    entry.completedAt = new Date().toISOString();
    writeJSON('habit_log.json', data);
    return entry;
  });
  if (!result) return res.status(404).json({ error: '记录不存在' });
  res.json(result);
});

app.delete('/api/habit/log/:id', async (req, res) => {
  await withFileLock('habit_log.json', () => {
    const data = readJSON('habit_log.json');
    data.logs = data.logs.filter(l => l.id !== req.params.id);
    writeJSON('habit_log.json', data);
  });
  res.json({ ok: true });
});

app.get('/api/habit/calendar', (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: '需要year和month参数' });
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const { logs } = readJSON('habit_log.json');
  const today = new Date().toISOString().split('T')[0];
  const result = {};
  logs.filter(l => l.date.startsWith(prefix)).forEach(l => {
    // Any completed entry marks the day as completed
    if (l.completed) result[l.date] = 'completed';
    else if (!result[l.date]) {
      result[l.date] = l.date < today ? 'missed' : 'drawn';
    }
  });
  res.json({ calendar: result });
});

// --- Scheduled Reminders ---
app.get('/api/scheduled', (req, res) => {
  res.json(readJSON('scheduled_tasks.json'));
});

app.get('/api/scheduled/pending', (req, res) => {
  const data = readJSON('scheduled_tasks.json');
  const pending = data.pending || [];
  if (pending.length > 0) {
    data.pending = [];
    writeJSON('scheduled_tasks.json', data);
  }
  res.json({ pending });
});

// Test endpoint: manually push a pending notification
app.post('/api/scheduled/test', (req, res) => {
  const data = readJSON('scheduled_tasks.json');
  if (!data.pending) data.pending = [];
  data.pending.push({ id: 'test', message: "Memo's CC: 这是一条测试通知", firedAt: new Date().toISOString() });
  writeJSON('scheduled_tasks.json', data);
  res.json({ ok: true });
});

app.post('/api/scheduled', async (req, res) => {
  const { date, time, content } = req.body;
  if (!time || !content) return res.status(400).json({ error: '时间和内容不能为空' });
  const task = await withFileLock('scheduled_tasks.json', () => {
    const data = readJSON('scheduled_tasks.json');
    const t = { id: uuidv4(), date: date || null, time, content, createdAt: new Date().toISOString() };
    data.tasks.push(t);
    writeJSON('scheduled_tasks.json', data);
    return t;
  });
  scheduleReminders();
  res.json(task);
});

app.delete('/api/scheduled/:id', async (req, res) => {
  await withFileLock('scheduled_tasks.json', () => {
    const data = readJSON('scheduled_tasks.json');
    data.tasks = data.tasks.filter(t => t.id !== req.params.id);
    writeJSON('scheduled_tasks.json', data);
  });
  scheduleReminders();
  res.json({ ok: true });
});

// --- Cron Jobs ---
let dailyJob = null;
let weeklyJob = null;

function scheduleCronJobs() {
  const settings = readJSON('settings.json');

  if (dailyJob) dailyJob.stop();
  if (weeklyJob) weeklyJob.stop();

  const [dH, dM] = settings.dailyDigestTime.split(':');
  dailyJob = cron.schedule(`${parseInt(dM)} ${parseInt(dH)} * * *`, async () => {
    console.log('[Cron] Running daily digest...');
    try {
      const { memos } = readJSON('memos.json');
      const weekdays = ['周日','周一','周二','周三','周四','周五','周六'];
      const now = new Date();
      const today = now.toISOString().split('T')[0];
      const yesterday = new Date(now - 86400000);
      const yesterdayStr = yesterday.toISOString().split('T')[0];
      const fmtDate = (d) => `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
      const yesterdayLabel = fmtDate(yesterday);
      const todayLabel = fmtDate(now);
      const yesterdayMemos = memos.filter(m => m.createdAt.startsWith(yesterdayStr));
      const todayMemos = memos.filter(m => m.createdAt.startsWith(today));
      const yesterdayText = yesterdayMemos.map(m => `- (${m.tags.join(',')}) ${m.content}`).join('\n');
      const todayText = todayMemos.map(m => `- (${m.tags.join(',')}) ${m.content}`).join('\n');
      const prompt = `你是一个手帐助手。请根据以下两天的手帐内容生成摘要。返回JSON对象，包含date、summary、tasks(数组)字段。\nsummary的格式要求：\n· ${yesterdayLabel}，概述当天的主要内容\n· ${todayLabel}，概述当天的主要内容\n每个日期单独一段，前面用"· "开头。如果某天没有内容就写"暂无记录"。\n只返回JSON。\n\n${yesterdayLabel}的手帐:\n${yesterdayText || '(暂无记录)'}\n\n${todayLabel}的手帐:\n${todayText || '(暂无记录)'}`;
      const result = await callClaude(prompt, '定时今日摘要');
      await withFileLock('ai_suggestions.json', () => {
        const suggestions = readJSON('ai_suggestions.json');
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        suggestions.dailyDigest = jsonMatch ? JSON.parse(jsonMatch[0]) : { date: today, summary: result, tasks: [] };
        writeJSON('ai_suggestions.json', suggestions);
      });
      console.log('[Cron] Daily digest done.');
    } catch (err) { console.error('[Cron] Daily digest error:', err.message); }
  });

  const dayMap = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  const [wH, wM] = settings.weeklyDigestTime.split(':');
  const wDay = dayMap[settings.weeklyDigestDay] ?? 0;
  weeklyJob = cron.schedule(`${parseInt(wM)} ${parseInt(wH)} * * ${wDay}`, async () => {
    console.log('[Cron] Running weekly digest...');
    try {
      const { memos } = readJSON('memos.json');
      const now = new Date();
      const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
      const weekMemos = memos.filter(m => new Date(m.createdAt) >= weekAgo);
      const memosText = weekMemos.map(m => `- (${m.tags.join(',')}) ${m.content} [${m.createdAt.split('T')[0]}]`).join('\n');
      const prompt = `你是一个手帐助手。总结过去一周的手帐，分析标签趋势，生成深度总结。返回JSON对象，包含week、summary、tagTrends(对象)字段。只返回JSON。\n\n本周备忘:\n${memosText || '(本周暂无手帐)'}`;
      const result = await callClaude(prompt, '定时本周总结');
      await withFileLock('ai_suggestions.json', () => {
        const suggestions = readJSON('ai_suggestions.json');
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        suggestions.weeklyDigest = jsonMatch ? JSON.parse(jsonMatch[0]) : { summary: result };
        writeJSON('ai_suggestions.json', suggestions);
      });
      console.log('[Cron] Weekly digest done.');
    } catch (err) { console.error('[Cron] Weekly digest error:', err.message); }
  });

  console.log(`[Cron] Scheduled daily at ${settings.dailyDigestTime}, weekly on ${settings.weeklyDigestDay} at ${settings.weeklyDigestTime}`);
  scheduleReminders();
}

// --- Scheduled Reminders (interval-based, more reliable in Electron fork) ---
let reminderInterval = null;
let lastReminderMinute = '';

function scheduleReminders() {
  if (reminderInterval) return; // already running
  reminderInterval = setInterval(() => {
    try {
      const now = new Date();
      const currentMinute = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
      if (currentMinute === lastReminderMinute) return; // already checked this minute
      lastReminderMinute = currentMinute;
      const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

      const data = readJSON('scheduled_tasks.json');
      if (!data.tasks || data.tasks.length === 0) return;
      if (!data.pending) data.pending = [];

      let changed = false;
      const toRemove = [];

      data.tasks.forEach(t => {
        if (t.time !== currentMinute) return;
        if (t.date && t.date !== today) return;
        const msg = `Memo's CC: ${t.content}`;
        console.log(`[Reminder] Firing: ${msg} (time=${t.time} date=${t.date || 'daily'})`);
        data.pending.push({ id: t.id, message: msg, firedAt: now.toISOString() });
        if (t.date) toRemove.push(t.id);
        changed = true;
      });

      if (toRemove.length > 0) {
        data.tasks = data.tasks.filter(x => !toRemove.includes(x.id));
      }
      if (changed) {
        writeJSON('scheduled_tasks.json', data);
      }
    } catch (err) { console.error('[Reminder] Error:', err.message); }
  }, 15000); // check every 15 seconds
  console.log(`[Reminder] Interval checker started`);
}

// --- Start ---
app.listen(PORT, () => {
  console.log(`Memo server running at http://localhost:${PORT}`);
  console.log(`Claude CLI: ${CLAUDE_CLI}`);
  scheduleCronJobs();

  // Auto-open browser (skip if running inside Electron)
  if (!process.env.ELECTRON_RUN_AS_NODE && !process.env.MEMO_ELECTRON) {
    const { exec } = require('child_process');
    const url = `http://localhost:${PORT}`;
    switch (process.platform) {
      case 'darwin': exec(`open "${url}"`); break;
      case 'win32': exec(`start "${url}"`); break;
      default: exec(`xdg-open "${url}"`); break;
    }
  }
});
