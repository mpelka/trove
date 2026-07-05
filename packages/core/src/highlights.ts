import type { Database } from "bun:sqlite";

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
  const info = db
    .query(
      `INSERT INTO highlights (session_id, message_uid, message_seq, text, note, created_at)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(
      input.sessionId,
      input.messageUid ?? null,
      input.messageSeq ?? null,
      text,
      input.note ?? null,
      Date.now(),
    );
  return Number(info.lastInsertRowid);
}

export function removeHighlight(db: Database, id: number): void {
  db.query("DELETE FROM highlights WHERE id = ?").run(id);
}

/** Resolve the current message rowid for a highlight: uid first, else (session, seq). */
function resolveMessageId(
  db: Database,
  sessionId: string,
  uid: string | null,
  seq: number | null,
): number | null {
  if (uid) {
    const byUid = db
      .query("SELECT id FROM messages WHERE session_id = ? AND uid = ?")
      .get(sessionId, uid) as { id: number } | undefined;
    if (byUid) return byUid.id;
  }
  if (seq != null) {
    const bySeq = db
      .query("SELECT id FROM messages WHERE session_id = ? AND seq = ?")
      .get(sessionId, seq) as { id: number } | undefined;
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
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.sessionId) {
    where.push("h.session_id = ?");
    params.push(opts.sessionId);
  }
  params.push(opts.limit ?? 200);
  const rows = db
    .query(
      `SELECT h.id AS id, h.session_id AS sessionId, h.message_uid AS messageUid,
              h.message_seq AS messageSeq, h.text AS text, h.note AS note,
              h.created_at AS createdAt,
              COALESCE(meta.custom_name, s.source_title, s.native_id, h.session_id) AS sessionName,
              COALESCE(s.agent, '') AS agent
       FROM highlights h
       LEFT JOIN sessions s ON s.id = h.session_id
       LEFT JOIN session_meta meta ON meta.session_id = h.session_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY h.created_at DESC, h.id DESC
       LIMIT ?`,
    )
    .all(...(params as any[])) as Omit<Highlight, "messageId">[];
  return rows.map((r) => ({
    ...r,
    messageId: resolveMessageId(db, r.sessionId, r.messageUid, r.messageSeq),
  }));
}

/** Highlights for one session, for the GUI to mark messages in one pass. */
export function highlightsForSession(db: Database, sessionId: string): SessionHighlight[] {
  return db
    .query(
      `SELECT id, message_uid AS messageUid, message_seq AS messageSeq, text, note,
              created_at AS createdAt
       FROM highlights WHERE session_id = ? ORDER BY id ASC`,
    )
    .all(sessionId) as SessionHighlight[];
}
