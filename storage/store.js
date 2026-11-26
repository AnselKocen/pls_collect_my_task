require('./runtime')();
const fs = require('fs');
const path = require('path');
const { randomUUID, createHash } = require('crypto');
const { isDeepStrictEqual } = require('util');
const { DatabaseSync } = require('node:sqlite');
const createDefaults = require('./defaults');
const { VERSION, APPLICATION_ID, migrations } = require('./schema');
const { searchScore } = require('./search');

const FILES = {
  memos: 'memos.json', settings: 'settings.json', suggestions: 'ai_suggestions.json',
  pools: 'habit_pools.json', logs: 'habit_log.json', scheduled: 'scheduled_tasks.json'
};
const HISTORIES = ['graphHistory', 'tagSummaries', 'tagSuggestionHistory', 'weeklyDigests'];
const arrays = { memos: 'memos', pools: 'pools', logs: 'logs', scheduled: 'tasks' };
const encode = value => JSON.stringify(value);
const decode = value => JSON.parse(value);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const hash = value => createHash('sha256').update(value).digest('hex');
const localDay = () => { const now=new Date(); return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`; };

function validate(section, data) {
  const fail = message => { throw new Error(`${FILES[section]}: ${message}`); };
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('需要 JSON 对象');
  const array = (value, label) => { if (!Array.isArray(value)) fail(`${label} 需要数组`); };
  if (arrays[section]) {
    const key = arrays[section]; array(data[key], key);
    const ids = new Set();
    for (const [index, row] of data[key].entries()) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || !row.id) fail(`${key}[${index}] 缺少有效 ID`);
      if (ids.has(row.id)) fail(`${key}[${index}] ID 重复: ${row.id}`);
      ids.add(row.id);
      if (section === 'memos') {
        if (typeof row.content !== 'string') fail(`${key}[${index}].content 需要文字`);
        array(row.tags, `${key}[${index}].tags`);
        if (row.tags.some(t => typeof t !== 'string')) fail(`${key}[${index}].tags 含非文字标签`);
      }
      if (section === 'pools') {
        array(row.habits, `${key}[${index}].habits`);
        if (row.habits.some(h => typeof h !== 'string')) fail(`${key}[${index}].habits 含非文字卡片`);
      }
    }
  }
  if (section === 'settings') {
    if (data.agent !== undefined && !['cc','codex','codebuddy','trae'].includes(data.agent)) fail('无效的 AI 助手');
    array(data.tags, 'tags');
    if (data.tags.some(t => typeof t !== 'string')) fail('tags 含非文字标签');
    for (const key of ['dailyDigestTime', 'weeklyDigestTime']) {
      if (typeof data[key] !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(data[key])) fail(`${key} 需要 HH:mm 时间`);
    }
    if (!['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].includes(data.weeklyDigestDay)) fail('weeklyDigestDay 无效');
  }
  if (section === 'suggestions') for (const key of HISTORIES) {
    if (key in data) array(data[key], key);
  }
  if (section === 'scheduled' && 'pending' in data) array(data.pending, 'pending');
  return data;
}

class Store {
  constructor(dataDir, { automaticBackup = true } = {}) {
    this.dataDir = path.resolve(dataDir);
    this.filename = path.join(this.dataDir, 'memo.sqlite');
    this.backupDir = path.join(this.dataDir, 'backups');
    this.automaticBackup = automaticBackup;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.db = new DatabaseSync(this.filename);
    this.db.function('memo_search_score',{deterministic:true},(text,query,mode) => searchScore(text,query,mode));
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > VERSION) throw new Error(`数据库版本 ${version} 高于应用支持的 ${VERSION}，请升级应用。`);
      const identity = this.db.prepare('PRAGMA application_id').get().application_id;
      if (identity && identity !== APPLICATION_ID) throw new Error('数据文件不属于记忆手帐，已停止打开。');
      this.db.exec('PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE;');
      this.transaction(() => {
        const currentVersion = this.db.prepare('PRAGMA user_version').get().user_version;
        for (let next = currentVersion + 1; next <= VERSION; next++) {
          this.db.exec(migrations[next]);
          if (next === 2) {
            const update = this.db.prepare('UPDATE memos SET created_ms=? WHERE id=?');
            for (const row of this.db.prepare('SELECT id,created_at FROM memos').all()) {
              const milliseconds = Date.parse(row.created_at);
              update.run(Number.isFinite(milliseconds) ? milliseconds : null,row.id);
            }
          }
          this.db.exec(`PRAGMA user_version=${next}; PRAGMA application_id=${APPLICATION_ID};`);
        }
      });
      this.checkIntegrity(this.db);
      // Another connection may have initialized the same directory while we waited for a lock.
      this.transaction(() => {
        if (!this.meta('initialized')) this.initialize();
      });
    } catch (error) { this.db.close(); throw error; }
  }

  transaction(fn) {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = fn();
      if (result && typeof result.then === 'function') throw new Error('数据库事务中不能等待异步任务');
      this.db.exec(`DELETE FROM tags WHERE NOT EXISTS (SELECT 1 FROM memo_tags WHERE tag=tags.name)
        AND NOT EXISTS (SELECT 1 FROM settings, json_each(settings.value) WHERE settings.key='tags' AND json_each.value=tags.name)`);
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }

  meta(key, value) {
    if (value === undefined) return this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value;
    this.db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }

  initialize() {
    const defaults = createDefaults();
    const source = Object.values(FILES).filter(file => fs.existsSync(path.join(this.dataDir, file)));
    const snapshots = new Map();
    let legacyBackup;
    if (source.length) {
      legacyBackup = path.join(this.backupDir, `legacy-${stamp()}-${randomUUID().slice(0, 8)}`);
      fs.mkdirSync(legacyBackup, { recursive: true });
      const manifest = {};
      for (const file of source) {
        const bytes = fs.readFileSync(path.join(this.dataDir, file));
        snapshots.set(file, bytes);
        fs.writeFileSync(path.join(legacyBackup, file), bytes, { flag: 'wx' });
        manifest[file] = hash(bytes);
      }
      fs.writeFileSync(path.join(legacyBackup, 'manifest.json'), encode({ createdAt: new Date().toISOString(), files: manifest }));
    }
    const expected = {};
    for (const [section, file] of Object.entries(FILES)) {
      let data;
      if (snapshots.has(file)) {
        try { data = decode(snapshots.get(file).toString('utf8')); }
        catch { throw new Error(`${file}: JSON 无法解析，原文件备份在 ${legacyBackup}`); }
      } else {
        data = defaults[file];
        if (source.length && section === 'memos') data = { memos: [] };
        if (source.length && section === 'pools') data = { pools: [] };
      }
      validate(section, data);
      this.write(section, data);
      expected[section] = data;
    }
    for (const [section, data] of Object.entries(expected)) {
      if (!isDeepStrictEqual(this.read(section), data)) throw new Error(`${FILES[section]}: 导入后校验不一致，迁移已回滚`);
    }
    for (const [file, bytes] of snapshots) {
      if (hash(fs.readFileSync(path.join(this.dataDir, file))) !== hash(bytes)) throw new Error(`${file} 在迁移时发生变化，请关闭旧版应用后重试`);
    }
    this.meta('initialized', new Date().toISOString());
    this.meta('source', source.length ? 'legacy-json' : 'new');
    if (legacyBackup) this.meta('legacyBackup', path.basename(legacyBackup));
  }

  read(section) {
    if (section === 'settings') return Object.fromEntries(this.db.prepare('SELECT key,value FROM settings ORDER BY rowid').all().map(r => [r.key, decode(r.value)]));
    if (section === 'suggestions') {
      const state = Object.fromEntries(this.db.prepare('SELECT key,value FROM ai_state ORDER BY rowid').all().map(r => [r.key, decode(r.value)]));
      for (const key of HISTORIES) if (state[key] === true) state[key] = this.db.prepare('SELECT payload FROM ai_history WHERE kind=? ORDER BY position').all(key).map(r => decode(r.payload));
      return state;
    }
    const tables = { memos: 'memos', pools: 'habit_pools', logs: 'habit_logs', scheduled: 'scheduled_tasks' };
    if (!tables[section]) throw new Error(`未知数据类型: ${section}`);
    const extras = this.db.prepare('SELECT value FROM section_extras WHERE section=?').get(section);
    const result = extras ? decode(extras.value) : {};
    result[arrays[section]] = this.db.prepare(`SELECT ${section === 'pools' ? 'id,' : ''}payload FROM ${tables[section]} ORDER BY position`).all().map(row => {
      const value = decode(row.payload);
      if (section === 'pools') value.habits = this.db.prepare('SELECT content FROM habit_cards WHERE pool_id=? ORDER BY position').all(row.id).map(r => r.content);
      return value;
    });
    if (section === 'scheduled' && this.meta('scheduled.pending') === '1') {
      result.pending = this.db.prepare('SELECT payload FROM pending_notifications ORDER BY position').all().map(row => decode(row.payload));
    }
    return result;
  }

  // A compatibility boundary for existing API shapes, backed by per-record SQL writes.
  write(section, data) {
    validate(section, data);
    return this.transaction(() => {
      if (section === 'settings') {
        this.syncKeys('settings', data);
        this.ensureTags(data.tags);
        return;
      }
      if (section === 'suggestions') {
        const state = { ...data };
        for (const key of HISTORIES) {
          if (key in state) { this.syncPositions('ai_history', data[key], key); state[key] = true; }
          else this.db.prepare('DELETE FROM ai_history WHERE kind=?').run(key);
        }
        this.syncKeys('ai_state', state);
        return;
      }
      const key = arrays[section];
      const extras = { ...data }; delete extras[key];
      if (section === 'scheduled') {
        this.meta('scheduled.pending', Object.hasOwn(data, 'pending') ? '1' : '0');
        delete extras.pending;
        this.syncPositions('pending_notifications', data.pending || []);
      }
      this.db.prepare('INSERT INTO section_extras VALUES (?,?) ON CONFLICT(section) DO UPDATE SET value=excluded.value').run(section, encode(extras));
      const definitions = {
        memos: ['memos', ['content','created_at','updated_at','pinned','created_ms'], row => [row.content,row.createdAt ?? null,row.updatedAt ?? null,row.pinned ? 1 : 0,Number.isFinite(Date.parse(row.createdAt)) ? Date.parse(row.createdAt) : null]],
        pools: ['habit_pools', [], () => []],
        logs: ['habit_logs', ['date','pool_id','completed'], row => [row.date ?? null,row.poolId ?? null,row.completed ? 1 : 0]],
        scheduled: ['scheduled_tasks', ['date','time'], row => [row.date ?? null,row.time ?? null]]
      };
      const [table, columns, values] = definitions[section];
      const existing = new Map(this.db.prepare(`SELECT id,position,payload FROM ${table}`).all().map(row => [row.id, row]));
      const names = ['id','position',...columns,'payload'];
      const upsert = this.db.prepare(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${names.slice(1).map(c => `${c}=excluded.${c}`).join(',')}`);
      for (const [position, row] of data[key].entries()) {
        const payload = { ...row }; if (section === 'pools') delete payload.habits;
        const json = encode(payload), previous = existing.get(row.id);
        if (!previous || previous.payload !== json || previous.position !== position) upsert.run(row.id, position, ...values(row), json);
        if (section === 'memos' && (!previous || !isDeepStrictEqual(decode(previous.payload).tags, row.tags))) {
          this.ensureTags(row.tags);
          this.db.prepare('DELETE FROM memo_tags WHERE memo_id=?').run(row.id);
          const add = this.db.prepare('INSERT INTO memo_tags VALUES (?,?,?)');
          row.tags.forEach((tag, index) => add.run(row.id, index, tag));
        }
        if (section === 'pools') {
          const oldCards = this.db.prepare('SELECT content FROM habit_cards WHERE pool_id=? ORDER BY position').all(row.id).map(r => r.content);
          if (!isDeepStrictEqual(oldCards, row.habits)) {
            this.db.prepare('DELETE FROM habit_cards WHERE pool_id=?').run(row.id);
            const add = this.db.prepare('INSERT INTO habit_cards VALUES (?,?,?)');
            row.habits.forEach((content, index) => add.run(row.id, index, content));
          }
        }
        existing.delete(row.id);
      }
      const remove = this.db.prepare(`DELETE FROM ${table} WHERE id=?`);
      for (const id of existing.keys()) remove.run(id);
    });
  }

  ensureTags(tags) {
    const add = this.db.prepare('INSERT OR IGNORE INTO tags VALUES (?)');
    tags.forEach(tag => add.run(tag));
  }

  syncKeys(table, object) {
    const existing = new Map(this.db.prepare(`SELECT key,value FROM ${table}`).all().map(row => [row.key,row.value]));
    const put = this.db.prepare(`INSERT INTO ${table} VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
    for (const [key,value] of Object.entries(object)) {
      const json = encode(value);
      if (existing.get(key) !== json) put.run(key,json);
      existing.delete(key);
    }
    for (const key of existing.keys()) this.db.prepare(`DELETE FROM ${table} WHERE key=?`).run(key);
  }

  syncPositions(table, values, kind) {
    const scoped = kind !== undefined;
    const rows = this.db.prepare(`SELECT position,payload FROM ${table}${scoped ? ' WHERE kind=?' : ''}`).all(...(scoped ? [kind] : []));
    const existing = new Map(rows.map(row => [row.position,row.payload]));
    const put = this.db.prepare(scoped
      ? `INSERT INTO ${table} VALUES (?,?,?) ON CONFLICT(kind,position) DO UPDATE SET payload=excluded.payload`
      : `INSERT INTO ${table} VALUES (?,?) ON CONFLICT(position) DO UPDATE SET payload=excluded.payload`);
    values.forEach((value,position) => {
      const json=encode(value);
      if (existing.get(position) !== json) put.run(...(scoped ? [kind,position,json] : [position,json]));
    });
    this.db.prepare(`DELETE FROM ${table} WHERE ${scoped ? 'kind=? AND ' : ''}position>=?`).run(...(scoped ? [kind,values.length] : [values.length]));
  }

  update(section, mutate) {
    return this.transaction(() => {
      const data = this.read(section);
      const result = mutate(data);
      this.write(section, data);
      return result;
    });
  }

  exportLegacy() {
    return Object.fromEntries(Object.entries(FILES).map(([section,file]) => [file,this.read(section)]));
  }

  queryMemos({ tags = [], ids, start, end, asOf, keyword = '', mode = 'exact', sort = 'position' } = {}) {
    if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string')) throw new Error('标签范围需要文字数组');
    if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string'))) throw new Error('便签 ID 需要文字数组');
    if (!['exact','fuzzy'].includes(mode)) throw new Error('搜索模式需要 exact 或 fuzzy');
    if (typeof keyword !== 'string' || keyword.length > 200) throw new Error('搜索内容不能超过 200 字');
    const where = [], parameters = [];
    if (tags.length) {
      where.push(`id IN (SELECT memo_id FROM memo_tags WHERE tag IN (${tags.map(() => '?').join(',')}))`);
      parameters.push(...tags);
    }
    if (ids !== undefined) {
      if (!ids.length) return [];
      where.push(`id IN (${ids.map(() => '?').join(',')})`); parameters.push(...ids);
    }
    for (const [value,operator] of [[start,'>='],[end,'<'],[asOf,'<=']]) if (value !== undefined) {
      const milliseconds = Date.parse(value);
      if (!Number.isFinite(milliseconds)) throw new Error('查询日期无效');
      where.push(`created_ms ${operator} ?`); parameters.push(milliseconds);
    }
    if (keyword.trim()) {
      // Tags are searchable too; a newline separates fields so phrases cannot span them.
      where.push(`memo_search_score(content || char(10) || COALESCE((SELECT group_concat(tag,char(10)) FROM memo_tags WHERE memo_id=memos.id),''),?,?) > 0`);
      parameters.push(keyword,mode);
    }
    const order = sort === 'display' ? 'pinned DESC, created_ms DESC, position' : 'position';
    const rows = this.db.prepare(`SELECT payload FROM memos${where.length ? ' WHERE '+where.join(' AND ') : ''} ORDER BY ${order}`).all(...parameters);
    const memos = rows.map(row => decode(row.payload));
    if (mode === 'fuzzy' && keyword.trim()) memos.sort((a,b) => searchScore([b.content,...b.tags].join('\n'),keyword,mode)-searchScore([a.content,...a.tags].join('\n'),keyword,mode));
    return memos;
  }

  countTags() {
    const counts=Object.fromEntries(this.read('settings').tags.map(tag=>[tag,0]));
    for(const row of this.db.prepare('SELECT tag,COUNT(DISTINCT memo_id) AS n FROM memo_tags GROUP BY tag').all()) Object.defineProperty(counts,row.tag,{value:row.n,enumerable:true,writable:true,configurable:true});
    return counts;
  }

  fireReminders(date, time, firedAt) {
    return this.transaction(() => {
      const minute = `${date}T${time}`;
      if (this.meta('lastReminderMinute') === minute) return 0;
      let count = 0;
      this.update('scheduled', data => {
        const due = data.tasks.filter(task => task.time === time && (!task.date || task.date === date));
        if (due.length) {
          if (!data.pending) data.pending = [];
          due.forEach(task => data.pending.push({ id:task.id, message:`记忆手帐：${task.content}`, firedAt }));
          const oneTime = new Set(due.filter(task => task.date).map(task => task.id));
          data.tasks = data.tasks.filter(task => !oneTime.has(task.id));
        }
        count = due.length;
      });
      this.meta('lastReminderMinute', minute);
      return count;
    });
  }

  checkIntegrity(db) {
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('数据库完整性校验失败，请从备份恢复。');
  }

  status() {
    return { version: VERSION, path: this.filename, source: this.meta('source'), initializedAt: this.meta('initialized'), legacyBackup: this.meta('legacyBackup') || null,
      counts: Object.fromEntries(['memos','habit_pools','habit_cards','habit_logs','ai_history','scheduled_tasks','pending_notifications'].map(table => [table,this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n])), backups: this.listBackups() };
  }

  listBackups() {
    if (!fs.existsSync(this.backupDir)) return [];
    return fs.readdirSync(this.backupDir).filter(name => /^(auto|manual|before-restore)-[\w-]+\.sqlite$/.test(name) && fs.lstatSync(path.join(this.backupDir,name)).isFile()).sort().reverse().map(name => {
      const stat=fs.statSync(path.join(this.backupDir,name));
      return { name, size: stat.size, createdAt: stat.mtime.toISOString() };
    }).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  }

  backupPath(name) {
    if (!this.listBackups().some(item => item.name === name)) throw new Error('备份不存在');
    return path.join(this.backupDir,name);
  }

  async createBackup(kind = 'manual') {
    if (!['auto','manual','before-restore'].includes(kind)) throw new Error('备份类型无效');
    fs.mkdirSync(this.backupDir, { recursive:true });
    const name=`${kind}-${kind === 'auto' ? localDay()+'-' : ''}${stamp()}-${randomUUID().slice(0,8)}.sqlite`;
    const target=path.join(this.backupDir,name), temporary=target+'.partial';
    try {
      // Fix the snapshot synchronously before yielding to later application writes.
      // SQLite copies one consistent committed view (including WAL contents); writes
      // after this call returns stay in the live database, outside this backup.
      this.db.prepare('VACUUM INTO ?').run(temporary);
      const copy=new DatabaseSync(temporary,{readOnly:true});
      try { this.checkIntegrity(copy); } finally { copy.close(); }
      fs.renameSync(temporary,target);
      return this.listBackups().find(item => item.name === name);
    } catch (error) { fs.rmSync(temporary,{force:true}); throw error; }
  }

  async startupBackup() {
    if (!this.automaticBackup) return;
    const today=localDay();
    if (!this.listBackups().some(item => item.name.startsWith(`auto-${today}`))) await this.createBackup('auto');
    for (const item of this.listBackups().filter(item => item.name.startsWith('auto-')).slice(7)) fs.unlinkSync(this.backupPath(item.name));
  }

  async restore(filename) {
    let copy;
    let documents;
    try {
      copy=new DatabaseSync(filename,{readOnly:true});
      const version = copy.prepare('PRAGMA user_version').get().user_version;
      if (copy.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID || version < 1 || version > VERSION) throw new Error('请选择当前版本或旧版记忆手帐生成的数据库备份');
      this.checkIntegrity(copy);
      // Read only application data; never execute an uploaded database's SQL in the live DB.
      const reader=Object.create(Store.prototype);reader.db=copy;
      if (!reader.meta('initialized')) throw new Error('备份尚未完成初始化');
      documents=reader.exportLegacy();
      for (const [section,file] of Object.entries(FILES)) validate(section,documents[file]);
    } finally { copy?.close(); }
    const safety=await this.createBackup('before-restore');
    this.transaction(() => {
      for (const [section,file] of Object.entries(FILES)) this.write(section,documents[file]);
      this.checkIntegrity(this.db);
      for (const [section,file] of Object.entries(FILES)) if (!isDeepStrictEqual(this.read(section),documents[file])) throw new Error('恢复后数据校验失败，已回滚');
    });
    return { safetyBackup:safety.name };
  }

  close() { if (this.db.isOpen) this.db.close(); }
}

module.exports = { Store, FILES, validate };
