import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { getKv } from "./db/client.ts";
import { dbPath } from "./paths.ts";
import type { MessageRow } from "./db/schema.ts";

export interface ListOptions {
  agent?: string;
  star?: boolean;
  project?: string;
  tag?: string;
  includeHidden?: boolean;
  sort?: "updated" | "created" | "name" | "turns";
  order?: "asc" | "desc"; // default: desc for dates/turns, asc for name
  limit?: number;
}

export interface SessionListItem {
  id: string;
  agent: string;
  name: string; // custom_name || source_title || nativeId
  projectPath: string | null;
  turnCount: number | null;
  messageCount: number | null;
  sizeBytes: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  starred: boolean;
  tags: string[];
  sourceGone: boolean;
}

export function listSessions(db: Database, opts: ListOptions = {}): SessionListItem[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.agent) {
    where.push("s.agent = ?");
    params.push(opts.agent);
  }
  if (opts.star) where.push("COALESCE(meta.starred, 0) = 1");
  if (!opts.includeHidden) where.push("COALESCE(meta.hidden, 0) = 0");
  if (opts.project) {
    where.push("s.project_path LIKE ?");
    params.push(`%${opts.project}%`);
  }
  if (opts.tag) {
    where.push("meta.tags LIKE ?");
    params.push(`%"${opts.tag}"%`);
  }
  const field =
    opts.sort === "created"
      ? "s.created_at"
      : opts.sort === "name"
        ? "name COLLATE NOCASE"
        : opts.sort === "turns"
          ? "s.turn_count"
          : "s.updated_at";
  const dir = opts.order ?? (opts.sort === "name" ? "asc" : "desc");
  const orderBy = `${field} ${dir === "asc" ? "ASC" : "DESC"}`;
  const sql = `
    SELECT s.id AS id, s.agent AS agent,
      COALESCE(meta.custom_name, s.source_title, s.native_id) AS name,
      s.project_path AS projectPath, s.turn_count AS turnCount, s.message_count AS messageCount,
      s.size_bytes AS sizeBytes, s.created_at AS createdAt, s.updated_at AS updatedAt,
      COALESCE(meta.starred, 0) AS starred, meta.tags AS tags, s.source_gone AS sourceGone
    FROM sessions s
    LEFT JOIN session_meta meta ON meta.session_id = s.id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY ${orderBy}
    LIMIT ?`;
  params.push(opts.limit ?? 50);
  const rows = db.query(sql).all(...(params as any[])) as any[];
  return rows.map((r) => ({
    id: r.id,
    agent: r.agent,
    name: r.name,
    projectPath: r.projectPath,
    turnCount: r.turnCount,
    messageCount: r.messageCount,
    sizeBytes: r.sizeBytes,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    starred: !!r.starred,
    tags: r.tags ? (JSON.parse(r.tags) as string[]) : [],
    sourceGone: !!r.sourceGone,
  }));
}

export interface StatusReport {
  totalSessions: number;
  totalMessages: number;
  starred: number;
  gone: number;
  perAgent: { agent: string; sessions: number; messages: number }[];
  lastSync: number | null;
  dbSizeBytes: number | null;
}

export function status(db: Database): StatusReport {
  const totalSessions =
    (db.query("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n ?? 0;
  const totalMessages =
    (db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n ?? 0;
  const starred =
    (db.query("SELECT COUNT(*) AS n FROM session_meta WHERE starred = 1").get() as { n: number })
      .n ?? 0;
  const gone =
    (db.query("SELECT COUNT(*) AS n FROM sessions WHERE source_gone = 1").get() as { n: number })
      .n ?? 0;
  const perAgent = db
    .query(
      `SELECT s.agent AS agent, COUNT(*) AS sessions,
              COALESCE(SUM(s.message_count), 0) AS messages
       FROM sessions s GROUP BY s.agent ORDER BY sessions DESC`,
    )
    .all() as { agent: string; sessions: number; messages: number }[];
  const lastSyncRaw = getKv(db, "last_sync");
  let dbSizeBytes: number | null = null;
  try {
    dbSizeBytes = statSync(dbPath()).size;
  } catch {
    /* ignore */
  }
  return {
    totalSessions,
    totalMessages,
    starred,
    gone,
    perAgent,
    lastSync: lastSyncRaw ? Number(lastSyncRaw) : null,
    dbSizeBytes,
  };
}

export interface SessionDetail {
  session: {
    id: string;
    agent: string;
    nativeId: string;
    name: string;
    projectPath: string | null;
    model: string | null;
    createdAt: number | null;
    updatedAt: number | null;
    turnCount: number | null;
    messageCount: number | null;
    sizeBytes: number | null;
    sourceGone: boolean;
    starred: boolean;
    customName: string | null; // raw custom name (null = derived title)
    tags: string[];
    notes: string | null;
    rawPath: string | null;
  };
  messages: MessageRow[];
}

export interface IdHit {
  sessionId: string;
  messageId: number | null;
  kind: "session" | "message";
}

/**
 * If the query looks like an id, resolve it to a jump target: a numeric message rowid,
 * a full namespaced session id, a short id (`cc·7de4…`), a message uuid, or a unique
 * native-id prefix. Returns null when the query isn't an id (fall back to text search).
 */
export function lookupId(db: Database, raw: string): IdHit | null {
  const q = raw.trim();

  // Numeric = message rowid; checked before the length gate so short ids (1–999) work.
  if (/^\d+$/.test(q)) {
    const row = db.query("SELECT id, session_id FROM messages WHERE id = ?").get(Number(q)) as
      | { id: number; session_id: string }
      | undefined;
    return row ? { sessionId: row.session_id, messageId: row.id, kind: "message" } : null;
  }
  if (q.length < 4) return null;

  const exact = db.query("SELECT id FROM sessions WHERE id = ?").get(q) as { id: string } | undefined;
  if (exact) return { sessionId: exact.id, messageId: null, kind: "session" };

  // strip a short-id agent prefix: "cc·7de4", "gem:abc", "cop·…", "agy·…", full agent ids
  const m = q.match(/^(?:cc|gem|cop|agy|claude-code|gemini-cli|copilot|antigravity)[·:](.+)$/i);
  const core = m ? m[1] : q;

  const byUid = db.query("SELECT id, session_id FROM messages WHERE uid = ?").get(core) as
    | { id: number; session_id: string }
    | undefined;
  if (byUid) return { sessionId: byUid.session_id, messageId: byUid.id, kind: "message" };

  if (core.length >= 6) {
    const rows = db
      .query("SELECT id FROM sessions WHERE native_id = ? OR native_id LIKE ? LIMIT 2")
      .all(core, `${core}%`) as { id: string }[];
    if (rows.length === 1) return { sessionId: rows[0].id, messageId: null, kind: "session" };
  }
  return null;
}

export function getSessionDetail(db: Database, id: string): SessionDetail | null {
  const s = db
    .query(
      `SELECT s.*, COALESCE(meta.custom_name, s.source_title, s.native_id) AS name,
              meta.custom_name AS custom_name,
              COALESCE(meta.starred,0) AS starred, meta.tags AS tags, meta.notes AS notes
       FROM sessions s LEFT JOIN session_meta meta ON meta.session_id = s.id
       WHERE s.id = ?`,
    )
    .get(id) as any;
  if (!s) return null;
  const messages = db
    .query("SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC")
    .all(id) as MessageRow[];
  return {
    session: {
      id: s.id,
      agent: s.agent,
      nativeId: s.native_id,
      name: s.name,
      projectPath: s.project_path,
      model: s.model,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
      turnCount: s.turn_count,
      messageCount: s.message_count,
      sizeBytes: s.size_bytes,
      sourceGone: !!s.source_gone,
      starred: !!s.starred,
      customName: s.custom_name ?? null,
      tags: s.tags ? (JSON.parse(s.tags) as string[]) : [],
      notes: s.notes,
      rawPath: s.raw_path,
    },
    messages,
  };
}
