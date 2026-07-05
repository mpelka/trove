/**
 * Row shapes for the trove SQLite store. Plain interfaces for now; Drizzle could take
 * over typed access of these exact tables later (see docs/trove-plan.md, archived).
 */

export interface SessionRow {
  id: string; // `${agent}:${native_id}` — unique across agents
  agent: string;
  native_id: string;
  source_path: string;
  source_medium: "file" | "sqlite";
  project_path: string | null;
  created_at: number | null; // epoch ms
  updated_at: number | null;
  size_bytes: number | null;
  turn_count: number | null; // human (user) turns
  message_count: number | null;
  model: string | null;
  source_title: string | null;
  kind: string | null;
  agent_specific: string | null; // JSON blob
  raw_path: string | null; // gzipped raw copy, if kept
  content_hash: string;
  source_mtime: number | null;
  imported_at: number;
  source_gone: number; // 0/1 — upstream vanished but archive kept
}

export interface MessageRow {
  id: number; // integer rowid, used as FTS content_rowid
  uid: string | null; // native message id (e.g. CC uuid)
  session_id: string;
  seq: number;
  role: "user" | "assistant" | "system" | "tool";
  parent_uid: string | null;
  timestamp: number | null;
  text: string;
}

export interface MetaRow {
  session_id: string;
  custom_name: string | null;
  starred: number;
  tags: string | null; // JSON array
  notes: string | null;
  hidden: number;
}

export interface HighlightRow {
  id: number;
  session_id: string;
  message_uid: string | null; // native message uuid — survives re-sync
  message_seq: number | null; // positional fallback when uid is absent/changes
  text: string; // highlighted passage, verbatim — the source of truth
  note: string | null;
  created_at: number; // epoch ms
}

/** DDL — single source of truth for the physical schema (incl. FTS5 + triggers). */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  native_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_medium TEXT NOT NULL,
  project_path TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  size_bytes INTEGER,
  turn_count INTEGER,
  message_count INTEGER,
  model TEXT,
  source_title TEXT,
  kind TEXT,
  agent_specific TEXT,
  raw_path TEXT,
  content_hash TEXT NOT NULL,
  source_mtime INTEGER,
  imported_at INTEGER NOT NULL,
  source_gone INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent);
CREATE INDEX IF NOT EXISTS idx_sessions_source_path ON sessions(source_path);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  parent_uid TEXT,
  timestamp INTEGER,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

CREATE TABLE IF NOT EXISTS session_meta (
  session_id TEXT PRIMARY KEY,
  custom_name TEXT,
  starred INTEGER NOT NULL DEFAULT 0,
  tags TEXT,
  notes TEXT,
  hidden INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);

-- User-owned highlights (readwise-style). Sidecar table: sync never touches it.
-- Anchoring: session_id + native message uid (survives re-sync) + seq (positional
-- fallback) + the verbatim text, which is the source of truth — a highlight survives
-- even if the underlying message vanishes.
CREATE TABLE IF NOT EXISTS highlights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  message_uid TEXT,
  message_seq INTEGER,
  text TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_highlights_session ON highlights(session_id);

-- User curation: a deleted session is tombstoned by source_path so sync won't re-import it.
CREATE TABLE IF NOT EXISTS tombstones (
  source_path TEXT PRIMARY KEY,
  id TEXT,
  deleted_at INTEGER
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text,
  content='messages',
  content_rowid='id',
  tokenize="unicode61 remove_diacritics 2"
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
`;
