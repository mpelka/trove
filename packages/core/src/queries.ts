import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { and, eq, sql, like, asc, type SQL } from "drizzle-orm";
import { statSync } from "node:fs";
import { getKv } from "./db/client.ts";
import { dbPath } from "./paths.ts";
import type { MessageRow } from "./db/schema.ts";
import { sessions, messages, sessionMeta } from "./db/drizzle-schema.ts";
import { highlightsForSession, type SessionHighlight } from "./highlights.ts";
import { getSummary, type Summary } from "./summarize.ts";

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
  const d = drizzle(db);
  const nameExpr = sql`COALESCE(${sessionMeta.customName}, ${sessions.sourceTitle}, ${sessions.nativeId})`;

  const conds: SQL[] = [];
  if (opts.agent) conds.push(eq(sessions.agent, opts.agent));
  if (opts.star) conds.push(sql`COALESCE(${sessionMeta.starred}, 0) = 1`);
  if (!opts.includeHidden) conds.push(sql`COALESCE(${sessionMeta.hidden}, 0) = 0`);
  if (opts.project) conds.push(like(sessions.projectPath, `%${opts.project}%`));
  if (opts.tag) conds.push(like(sessionMeta.tags, `%"${opts.tag}"%`));

  const dir = opts.order ?? (opts.sort === "name" ? "asc" : "desc");
  const asc = dir === "asc";
  const orderExpr =
    opts.sort === "created"
      ? sql`${sessions.createdAt}`
      : opts.sort === "name"
        ? sql`${nameExpr} COLLATE NOCASE`
        : opts.sort === "turns"
          ? sql`${sessions.turnCount}`
          : sql`${sessions.updatedAt}`;
  const orderBy = asc ? sql`${orderExpr} ASC` : sql`${orderExpr} DESC`;

  const rows = d
    .select({
      id: sessions.id,
      agent: sessions.agent,
      name: nameExpr.mapWith(String),
      projectPath: sessions.projectPath,
      turnCount: sessions.turnCount,
      messageCount: sessions.messageCount,
      sizeBytes: sessions.sizeBytes,
      createdAt: sessions.createdAt,
      updatedAt: sessions.updatedAt,
      starred: sql<number>`COALESCE(${sessionMeta.starred}, 0)`,
      tags: sessionMeta.tags,
      sourceGone: sessions.sourceGone,
    })
    .from(sessions)
    .leftJoin(sessionMeta, eq(sessionMeta.sessionId, sessions.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(orderBy)
    .limit(opts.limit ?? 50)
    .all();

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
  const d = drizzle(db);
  const totalSessions =
    d.select({ n: sql<number>`COUNT(*)` }).from(sessions).get()?.n ?? 0;
  const totalMessages =
    d.select({ n: sql<number>`COUNT(*)` }).from(messages).get()?.n ?? 0;
  const starred =
    d
      .select({ n: sql<number>`COUNT(*)` })
      .from(sessionMeta)
      .where(eq(sessionMeta.starred, 1))
      .get()?.n ?? 0;
  const gone =
    d
      .select({ n: sql<number>`COUNT(*)` })
      .from(sessions)
      .where(eq(sessions.sourceGone, 1))
      .get()?.n ?? 0;
  const perAgent = d
    .select({
      agent: sessions.agent,
      sessions: sql<number>`COUNT(*)`.as("sessions"),
      messages: sql<number>`COALESCE(SUM(${sessions.messageCount}), 0)`,
    })
    .from(sessions)
    .groupBy(sessions.agent)
    .orderBy(sql`sessions DESC`)
    .all();
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
  highlights: SessionHighlight[];
  summary: Summary | null;
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
  const d = drizzle(db);
  const q = raw.trim();

  // Numeric = message rowid; checked before the length gate so short ids (1–999) work.
  if (/^\d+$/.test(q)) {
    const row = d
      .select({ id: messages.id, session_id: messages.sessionId })
      .from(messages)
      .where(eq(messages.id, Number(q)))
      .get();
    return row ? { sessionId: row.session_id, messageId: row.id, kind: "message" } : null;
  }
  if (q.length < 4) return null;

  const exact = d.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, q)).get();
  if (exact) return { sessionId: exact.id, messageId: null, kind: "session" };

  // strip a short-id agent prefix: "cc·7de4", "gem:abc", "cop·…", "agy·…", full agent ids
  const m = q.match(/^(?:cc|gem|cop|agy|claude-code|gemini-cli|copilot|antigravity)[·:](.+)$/i);
  const core = m ? m[1] : q;

  const byUid = d
    .select({ id: messages.id, session_id: messages.sessionId })
    .from(messages)
    .where(eq(messages.uid, core))
    .get();
  if (byUid) return { sessionId: byUid.session_id, messageId: byUid.id, kind: "message" };

  if (core.length >= 6) {
    const rows = d
      .select({ id: sessions.id })
      .from(sessions)
      .where(sql`${sessions.nativeId} = ${core} OR ${sessions.nativeId} LIKE ${`${core}%`}`)
      .limit(2)
      .all();
    if (rows.length === 1) return { sessionId: rows[0].id, messageId: null, kind: "session" };
  }
  return null;
}

export function getSessionDetail(db: Database, id: string): SessionDetail | null {
  const d = drizzle(db);
  const s = d
    .select({
      id: sessions.id,
      agent: sessions.agent,
      native_id: sessions.nativeId,
      project_path: sessions.projectPath,
      model: sessions.model,
      created_at: sessions.createdAt,
      updated_at: sessions.updatedAt,
      turn_count: sessions.turnCount,
      message_count: sessions.messageCount,
      size_bytes: sessions.sizeBytes,
      source_gone: sessions.sourceGone,
      raw_path: sessions.rawPath,
      name: sql<string>`COALESCE(${sessionMeta.customName}, ${sessions.sourceTitle}, ${sessions.nativeId})`,
      custom_name: sessionMeta.customName,
      starred: sql<number>`COALESCE(${sessionMeta.starred}, 0)`,
      tags: sessionMeta.tags,
      notes: sessionMeta.notes,
    })
    .from(sessions)
    .leftJoin(sessionMeta, eq(sessionMeta.sessionId, sessions.id))
    .where(eq(sessions.id, id))
    .get();
  if (!s) return null;
  // Select with explicit snake_case aliases so the returned rows match MessageRow
  // (and the raw `SELECT *` shape the tests assert) exactly.
  const msgs = d
    .select({
      id: messages.id,
      uid: messages.uid,
      session_id: messages.sessionId,
      seq: messages.seq,
      role: messages.role,
      parent_uid: messages.parentUid,
      timestamp: messages.timestamp,
      text: messages.text,
      tool_calls: messages.toolCalls,
    })
    .from(messages)
    .where(eq(messages.sessionId, id))
    .orderBy(asc(messages.seq))
    .all() as unknown as MessageRow[];
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
    messages: msgs,
    highlights: highlightsForSession(db, id),
    summary: getSummary(db, id),
  };
}
