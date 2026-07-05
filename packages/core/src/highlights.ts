import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { and, eq, sql, desc, asc } from "drizzle-orm";
import { highlights, sessions, sessionMeta, messages } from "./db/drizzle-schema.ts";

/**
 * Readwise-style highlights. A highlight is user-owned data (like names/stars): it lives in
 * the sidecar `highlights` table, and sync must never touch it.
 *
 * Anchoring is deliberately redundant because message rowids are REGENERATED on every re-sync
 * (messages are deleted + reinserted when a session changes). We store:
 *   - `sessionId`      — the stable, sync-proof session id
 *   - `messageUid`     — the native message uuid (survives re-sync when the message persists)
 *   - `messageSeq`     — positional fallback for when the uid is absent or the message moved
 *   - `text`           — the highlighted passage verbatim, the SOURCE OF TRUTH: a highlight
 *                        survives (and still lists) even if its message disappears entirely.
 *
 * At read time we resolve the *current* message rowid so the GUI can jump to it: match the uid
 * first, then fall back to (session_id, seq). Either may be null — the highlight is still valid.
 */

export interface AddHighlightInput {
  sessionId: string;
  messageUid?: string | null;
  messageSeq?: number | null;
  text: string;
  note?: string | null;
}

export interface Highlight {
  id: number;
  sessionId: string;
  messageUid: string | null;
  messageSeq: number | null;
  text: string;
  note: string | null;
  createdAt: number;
  /** joined session metadata + resolved current rowid, for browsing/jumping. */
  sessionName: string;
  agent: string;
  messageId: number | null; // current rowid, resolved via uid→seq, or null if unfindable
}

/** For the GUI to mark messages: highlights of one session grouped by their anchors. */
export interface SessionHighlight {
  id: number;
  messageUid: string | null;
  messageSeq: number | null;
  text: string;
  note: string | null;
  createdAt: number;
}

export function addHighlight(db: Database, input: AddHighlightInput): number {
  const text = input.text;
  if (!text || !text.trim()) throw new Error("highlight text is required");
  const d = drizzle(db);
  const [row] = d
    .insert(highlights)
    .values({
      sessionId: input.sessionId,
      messageUid: input.messageUid ?? null,
      messageSeq: input.messageSeq ?? null,
      text,
      note: input.note ?? null,
      createdAt: Date.now(),
    })
    .returning({ id: highlights.id })
    .all();
  return Number(row.id);
}

export function removeHighlight(db: Database, id: number): void {
  const d = drizzle(db);
  d.delete(highlights).where(eq(highlights.id, id)).run();
}

/** Resolve the current message rowid for a highlight: uid first, else (session, seq). */
function resolveMessageId(
  db: Database,
  sessionId: string,
  uid: string | null,
  seq: number | null,
): number | null {
  const d = drizzle(db);
  if (uid) {
    const byUid = d
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.uid, uid)))
      .get();
    if (byUid) return byUid.id;
  }
  if (seq != null) {
    const bySeq = d
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.seq, seq)))
      .get();
    if (bySeq) return bySeq.id;
  }
  return null;
}

export interface ListHighlightsOptions {
  sessionId?: string;
  limit?: number;
}

/** Highlights joined with session name/agent, newest first, each with a resolved rowid. */
export function listHighlights(db: Database, opts: ListHighlightsOptions = {}): Highlight[] {
  const d = drizzle(db);
  const rows = d
    .select({
      id: highlights.id,
      sessionId: highlights.sessionId,
      messageUid: highlights.messageUid,
      messageSeq: highlights.messageSeq,
      text: highlights.text,
      note: highlights.note,
      createdAt: highlights.createdAt,
      sessionName: sql<string>`COALESCE(${sessionMeta.customName}, ${sessions.sourceTitle}, ${sessions.nativeId}, ${highlights.sessionId})`,
      agent: sql<string>`COALESCE(${sessions.agent}, '')`,
    })
    .from(highlights)
    .leftJoin(sessions, eq(sessions.id, highlights.sessionId))
    .leftJoin(sessionMeta, eq(sessionMeta.sessionId, highlights.sessionId))
    .where(opts.sessionId ? eq(highlights.sessionId, opts.sessionId) : undefined)
    .orderBy(desc(highlights.createdAt), desc(highlights.id))
    .limit(opts.limit ?? 200)
    .all();
  return rows.map((r) => ({
    ...r,
    messageId: resolveMessageId(db, r.sessionId, r.messageUid, r.messageSeq),
  }));
}

/** Highlights for one session, for the GUI to mark messages in one pass. */
export function highlightsForSession(db: Database, sessionId: string): SessionHighlight[] {
  const d = drizzle(db);
  return d
    .select({
      id: highlights.id,
      messageUid: highlights.messageUid,
      messageSeq: highlights.messageSeq,
      text: highlights.text,
      note: highlights.note,
      createdAt: highlights.createdAt,
    })
    .from(highlights)
    .where(eq(highlights.sessionId, sessionId))
    .orderBy(asc(highlights.id))
    .all();
}
