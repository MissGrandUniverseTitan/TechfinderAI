-- Cloudflare D1 (SQLite) schema.
-- Apply with:  npx wrangler d1 execute techfinder-db --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS state_versions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  value     TEXT    NOT NULL,  -- whole app state as JSON (clients, quotations, receipts, transactions, settings)
  saved_by  TEXT    NOT NULL,  -- email of the user who saved
  saved_at  TEXT    NOT NULL   -- ISO-8601 UTC timestamp
);

CREATE INDEX IF NOT EXISTS idx_state_versions_saved_at ON state_versions (saved_at);

-- Who may use the app, and what they may do. Managed from the app's "ผู้ใช้งาน" page.
--   admin  : everything, including managing users
--   editor : read and save documents
--   viewer : read only
CREATE TABLE IF NOT EXISTS users (
  email         TEXT PRIMARY KEY,           -- lower-case
  name          TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  active        INTEGER NOT NULL DEFAULT 1,
  added_by      TEXT NOT NULL,
  added_at      TEXT NOT NULL,
  last_seen_at  TEXT
);
