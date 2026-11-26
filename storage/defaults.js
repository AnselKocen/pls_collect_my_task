// Default data is created only for a new database.
module.exports = function createDefaults() {
  const now = new Date().toISOString();
  const defaults = {
    'memos.json': { memos: [
      {
        id: 'welcome-1',
        content: '欢迎来到记忆手帐Memo Journal ~ 尽情探索吧 ❤️',
        tags: ['欢迎'],
        createdAt: now, updatedAt: now, pinned: true, initialOrder: 0
      },
      {
        id: 'welcome-3',
        content: '这是一个专属于你的便签手帐本，AI作为你的小助理，能帮你完成一系列任务。现在支持 Codex、Claude Code 和 CodeBuddy，登录对应的CLI后，在设置里选择你使用的助手，就能使用AI相关功能哦💗',
        tags: ['指南'],
        createdAt: now, updatedAt: now, pinned: true, initialOrder: 1
      },
      {
        id: 'welcome-5',
        content: '小技巧：按CMD+R可以刷新噢',
        tags: ['tips'],
        createdAt: now, updatedAt: now, pinned: true, initialOrder: 2
      },
      {
        id: 'welcome-2',
        content: '习惯养成✨ - 上传任何你想养成习惯的书籍，例如饮食、运动，甚至观鸟手册。如果没有素材，你也可以和助手聊聊。AI助手会帮你生成习惯卡池！每天抽取你的习惯卡片🃏，坚持然后填满打卡日历吧！',
        tags: ['特色玩法'],
        createdAt: now, updatedAt: now, pinned: true, initialOrder: 3
      },
      {
        id: 'welcome-4',
        content: '思绪太杂乱，任务太多？让AI助手帮你画一张便签关联地图，看看便签们隐藏的关联吧！🌾',
        tags: ['特色玩法'],
        createdAt: now, updatedAt: now, pinned: true, initialOrder: 4
      },
      {
        id: 'welcome-6',
        content: '事情越堆越多……不知道该先处理哪个？试试任务盲盒！随机抽取一张便签～今天就从这个任务开始吧～🎲',
        tags: ['特色玩法'],
        createdAt: now, updatedAt: now, pinned: true, initialOrder: 5
      }
    ] },
    'settings.json': {
      agent: 'cc',
      dailyDigestTime: '23:55',
      weeklyDigestDay: 'sunday',
      weeklyDigestTime: '23:59',
      tags: ['欢迎', '特色玩法', '指南', 'tips'],
      tagOrder: ['欢迎', '特色玩法', '指南', 'tips'],
      tagEmojis: { '欢迎': '🍮', '特色玩法': '🍯', '指南': '🍩', 'tips': '💫' },
      tagTapes: { '欢迎': 'tape-3', '特色玩法': 'tape-4', '指南': 'tape-1', 'tips': 'tape-8' }
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
  return defaults;
};
