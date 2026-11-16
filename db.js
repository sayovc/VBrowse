// Database layer: SQLite via Node's built-in node:sqlite (no native build needed).
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'vbrowse.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  bio           TEXT NOT NULL DEFAULT '',
  avatar        TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('video','image','text')),
  media      TEXT,
  caption    TEXT NOT NULL DEFAULT '',
  category   TEXT NOT NULL DEFAULT 'other',
  tags       TEXT NOT NULL DEFAULT '',
  views      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);

CREATE TABLE IF NOT EXISTS reactions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  value   INTEGER NOT NULL CHECK (value IN (1,-1)),
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_reactions_post ON reactions(post_id);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id  INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);

CREATE TABLE IF NOT EXISTS comment_likes (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, comment_id)
);

CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id     INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  comment_id  INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_post ON reports(reporter_id, post_id) WHERE post_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_comment ON reports(reporter_id, comment_id) WHERE comment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS saves (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
`);

// Columns added for moderation (safe to run on an existing database)
for (const sql of [
  "ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE posts ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'", // approved | pending | removed
  "ALTER TABLE posts ADD COLUMN mod_reason TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE comments ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN email TEXT",
  "ALTER TABLE users ADD COLUMN banner TEXT",
]) { try { db.exec(sql); } catch { /* column already exists */ } }
db.exec("CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status)");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email COLLATE NOCASE) WHERE email IS NOT NULL");

// Small transaction helper
db.tx = (fn) => {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
};

module.exports = db;
