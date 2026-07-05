/**
 * Row shapes for the trove SQLite store — the TS view of the physical rows.
 *
 * The physical DDL (tables, indexes, the FTS5 virtual table + triggers) is no longer
 * defined here: as of issue #19 it lives in tracked drizzle-kit migrations under
 * packages/core/drizzle, applied at runtime by openDb(). Typed query builders live in
 * drizzle-schema.ts. These interfaces are imported across the codebase, so they stay.
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
  tool_calls: string | null; // JSON array `[{name,input}, …]`; null for non-tool / pre-#20 rows
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

export interface SummaryRow {
  session_id: string;
  text: string; // the summarizer's stdout, stored verbatim
  created_at: number; // epoch ms
}
