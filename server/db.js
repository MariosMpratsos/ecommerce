const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(process.env.DB_PATH || path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name    TEXT NOT NULL,
    last_name     TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Hints the support agent has proposed for the garment detector.
  -- scope 'user'   = only affects the owner's own uploads
  -- scope 'global' = affects everyone (only an admin can promote a hint to this)
  -- Only rows with status = 'active' ever reach the detector prompt.
  CREATE TABLE IF NOT EXISTS learned_rules (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_text       TEXT NOT NULL,
    rationale       TEXT,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'active', 'rejected', 'disabled')),
    test_result     TEXT,
    proposed_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    source_image_id TEXT,
    scope           TEXT NOT NULL DEFAULT 'user',
    owner_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
    source          TEXT NOT NULL DEFAULT 'chat',
    notified        INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS support_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    message    TEXT NOT NULL,
    reply      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migrate databases created by the previous version (rules there were all global).
const ruleCols = db.prepare('PRAGMA table_info(learned_rules)').all().map((c) => c.name);
if (!ruleCols.includes('scope')) db.exec("ALTER TABLE learned_rules ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'");
if (!ruleCols.includes('owner_id')) db.exec('ALTER TABLE learned_rules ADD COLUMN owner_id INTEGER');
if (!ruleCols.includes('source')) db.exec("ALTER TABLE learned_rules ADD COLUMN source TEXT NOT NULL DEFAULT 'chat'");
if (!ruleCols.includes('notified')) db.exec('ALTER TABLE learned_rules ADD COLUMN notified INTEGER NOT NULL DEFAULT 1');

module.exports = { db };
