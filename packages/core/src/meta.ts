import type { Database } from "bun:sqlite";

export type ResolveResult =
  | { kind: "ok"; id: string }
  | { kind: "none" }
  | { kind: "ambiguous"; matches: string[] };

/** Resolve a full id, a prefix of the id / native id, or a displayed short id
 *  (`cc·73da3fd6`, `gem·abcd1234`, …) to a single session id. The short forms are
 *  what trove prints everywhere, so every id-taking command must accept them. */
export function resolveSessionId(db: Database, ref: string): ResolveResult {
  const exact = db.query("SELECT id FROM sessions WHERE id = ?").get(ref) as
    | { id: string }
    | undefined;
  if (exact) return { kind: "ok", id: exact.id };

  // Strip a short-id agent prefix (same forms lookupId accepts). `cc·73da3fd6` →
  // candidate core "73da3fd6"; gemini short ids are the TRAILING hash of the
  // `session-…` native id, so match those with a suffix-friendly LIKE too.
  const m = ref.match(/^(cc|gem|cop|agy|claude-code|gemini-cli|copilot|antigravity)[·:](.+)$/i);
  const candidates = m ? [ref, m[2]] : [ref];

  const seen = new Map<string, true>();
  for (const cand of candidates) {
    const rows = db
      .query(
        "SELECT id FROM sessions WHERE id LIKE ? OR native_id LIKE ? OR native_id LIKE ? LIMIT 8",
      )
      .all(`${cand}%`, `${cand}%`, `session-%${cand}%`) as { id: string }[];
    for (const r of rows) seen.set(r.id, true);
  }
  const matches = [...seen.keys()];
  if (matches.length === 1) return { kind: "ok", id: matches[0] };
  if (matches.length === 0) return { kind: "none" };
  return { kind: "ambiguous", matches };
}

function ensureMeta(db: Database, id: string): void {
  db.query("INSERT OR IGNORE INTO session_meta (session_id) VALUES (?)").run(id);
}

export function setName(db: Database, id: string, name: string | null): void {
  ensureMeta(db, id);
  db.query("UPDATE session_meta SET custom_name = ? WHERE session_id = ?").run(name, id);
}

export function setStar(db: Database, id: string, starred: boolean): void {
  ensureMeta(db, id);
  db.query("UPDATE session_meta SET starred = ? WHERE session_id = ?").run(starred ? 1 : 0, id);
}

export function setHidden(db: Database, id: string, hidden: boolean): void {
  ensureMeta(db, id);
  db.query("UPDATE session_meta SET hidden = ? WHERE session_id = ?").run(hidden ? 1 : 0, id);
}

export function setNotes(db: Database, id: string, notes: string | null): void {
  ensureMeta(db, id);
  db.query("UPDATE session_meta SET notes = ? WHERE session_id = ?").run(notes, id);
}

function getTags(db: Database, id: string): string[] {
  const row = db.query("SELECT tags FROM session_meta WHERE session_id = ?").get(id) as
    | { tags: string | null }
    | undefined;
  return row?.tags ? (JSON.parse(row.tags) as string[]) : [];
}

export function addTags(db: Database, id: string, tags: string[]): string[] {
  ensureMeta(db, id);
  const set = new Set(getTags(db, id));
  for (const t of tags) if (t.trim()) set.add(t.trim());
  const next = [...set].sort();
  db.query("UPDATE session_meta SET tags = ? WHERE session_id = ?").run(JSON.stringify(next), id);
  return next;
}

export function removeTags(db: Database, id: string, tags: string[]): string[] {
  ensureMeta(db, id);
  const remove = new Set(tags.map((t) => t.trim()));
  const next = getTags(db, id).filter((t) => !remove.has(t));
  db.query("UPDATE session_meta SET tags = ? WHERE session_id = ?").run(JSON.stringify(next), id);
  return next;
}
