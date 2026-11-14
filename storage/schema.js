const VERSION = 2;
const APPLICATION_ID = 0x4d454d4f; // MEMO

// Keep every upgrade explicit and transactional. Never recreate an existing database.
const migrations = [null, `
  CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE section_extras (section TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE tags (name TEXT PRIMARY KEY);
  CREATE TABLE memos (
    id TEXT PRIMARY KEY, position INTEGER NOT NULL, content TEXT NOT NULL,
    created_at TEXT, updated_at TEXT, pinned INTEGER NOT NULL, payload TEXT NOT NULL
  );
  CREATE INDEX memos_created ON memos(created_at);
  CREATE INDEX memos_pinned_created ON memos(pinned, created_at);
  CREATE TABLE memo_tags (
    memo_id TEXT NOT NULL REFERENCES memos(id) ON DELETE CASCADE,
    position INTEGER NOT NULL, tag TEXT NOT NULL REFERENCES tags(name),
    PRIMARY KEY(memo_id, position)
  );
  CREATE INDEX memo_tags_tag ON memo_tags(tag, memo_id);
  CREATE TABLE habit_pools (id TEXT PRIMARY KEY, position INTEGER NOT NULL, payload TEXT NOT NULL);
  CREATE TABLE habit_cards (
    pool_id TEXT NOT NULL REFERENCES habit_pools(id) ON DELETE CASCADE,
    position INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY(pool_id, position)
  );
  -- pool_id is historical provenance: deleted pools must not delete or invalidate logs.
  CREATE TABLE habit_logs (
    id TEXT PRIMARY KEY, position INTEGER NOT NULL, date TEXT, pool_id TEXT,
    completed INTEGER NOT NULL, payload TEXT NOT NULL
  );
  CREATE INDEX habit_logs_date ON habit_logs(date);
  CREATE TABLE ai_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE ai_history (
    kind TEXT NOT NULL, position INTEGER NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(kind, position)
  );
  CREATE TABLE scheduled_tasks (
    id TEXT PRIMARY KEY, position INTEGER NOT NULL, date TEXT, time TEXT, payload TEXT NOT NULL
  );
  CREATE INDEX scheduled_tasks_due ON scheduled_tasks(date, time);
  -- Legacy notifications can share the same public id (for example, test notifications).
  CREATE TABLE pending_notifications (position INTEGER PRIMARY KEY, payload TEXT NOT NULL);
`, `
  ALTER TABLE memos ADD COLUMN created_ms INTEGER;
  CREATE INDEX memos_created_ms ON memos(created_ms);
`];

module.exports = { VERSION, APPLICATION_ID, migrations };
