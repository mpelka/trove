import type { Database } from "bun:sqlite";
import type { MessageRow } from "./db/schema.ts";

/** One message plus a flag marking whether it's the context request's target. */
export interface ContextMessage extends MessageRow {
  isTarget: boolean;
}

export interface ContextResult {
  sessionId: string;
  target: MessageRow;
  /** target + up to `depth` messages before and after, in conversation order. */
  messages: ContextMessage[];
}

/**
 * The target message plus up to `depth` messages *before* and *after* it within the
 * same session. When the session has parent links (CC), we walk the `parent_uid` chain
 * (ancestors ← target → descendants); otherwise (gemini/copilot/agy — flat, no links) we
 * fall back to seq-adjacency. Returns null if the message id is unknown.
 */
export function getContext(db: Database, messageId: number, depth = 3): ContextResult | null {
  const target = db.query("SELECT * FROM messages WHERE id = ?").get(messageId) as
    | MessageRow
    | undefined;
  if (!target) return null;

  const all = db
    .query("SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC")
    .all(target.session_id) as MessageRow[];

  // A session "has links" if any message carries a parent_uid; then we can walk the chain.
  const hasLinks = all.some((m) => m.parent_uid != null);

  let before: MessageRow[] = [];
  let after: MessageRow[] = [];

  if (hasLinks && target.uid != null) {
    const byUid = new Map<string, MessageRow>();
    for (const m of all) if (m.uid != null) byUid.set(m.uid, m);
    const childrenByParent = new Map<string, MessageRow[]>();
    for (const m of all) {
      if (m.parent_uid == null) continue;
      const list = childrenByParent.get(m.parent_uid) ?? [];
      list.push(m);
      childrenByParent.set(m.parent_uid, list);
    }

    // ancestors: walk parent_uid up to `depth` hops (nearest-first, then reversed to order).
    const ancestors: MessageRow[] = [];
    let cur: MessageRow | undefined = target;
    for (let i = 0; i < depth && cur; i++) {
      const parent: MessageRow | undefined =
        cur.parent_uid != null ? byUid.get(cur.parent_uid) : undefined;
      if (!parent) break;
      ancestors.push(parent);
      cur = parent;
    }
    before = ancestors.reverse();

    // descendants: follow the first child at each step (linear conversation spine).
    const descendants: MessageRow[] = [];
    let node: MessageRow | undefined = target;
    for (let i = 0; i < depth && node && node.uid != null; i++) {
      const kids: MessageRow[] = (childrenByParent.get(node.uid) ?? [])
        .slice()
        .sort((a, b) => a.seq - b.seq);
      const next: MessageRow | undefined = kids[0];
      if (!next) break;
      descendants.push(next);
      node = next;
    }
    after = descendants;
  } else {
    // No usable links → seq-adjacency around the target's position.
    const idx = all.findIndex((m) => m.id === target.id);
    if (idx >= 0) {
      before = all.slice(Math.max(0, idx - depth), idx);
      after = all.slice(idx + 1, idx + 1 + depth);
    }
  }

  const messages: ContextMessage[] = [
    ...before.map((m) => ({ ...m, isTarget: false })),
    { ...target, isTarget: true },
    ...after.map((m) => ({ ...m, isTarget: false })),
  ];
  return { sessionId: target.session_id, target, messages };
}

export interface TreeNode extends MessageRow {
  children: TreeNode[];
}

export interface TreeResult {
  sessionId: string;
  /** true when the tree was built from parent_uid links; false = flat seq fallback. */
  linked: boolean;
  roots: TreeNode[];
}

/**
 * All of a session's messages as a tree. Children are built from `parent_uid` (matched on
 * `uid`); roots are messages whose parent_uid is null or dangling (points outside the
 * session). Sessions without links degrade to a flat, seq-ordered single level.
 */
export function getTree(db: Database, sessionId: string): TreeResult | null {
  const exists = db.query("SELECT 1 FROM sessions WHERE id = ?").get(sessionId);
  if (!exists) return null;

  const all = db
    .query("SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC")
    .all(sessionId) as MessageRow[];

  const hasLinks = all.some((m) => m.parent_uid != null);
  if (!hasLinks) {
    const roots = all.map((m) => ({ ...m, children: [] as TreeNode[] }));
    return { sessionId, linked: false, roots };
  }

  const nodes = new Map<string, TreeNode>();
  for (const m of all) if (m.uid != null) nodes.set(m.uid, { ...m, children: [] });
  // Messages without a uid can never be a parent, but still belong in the tree.
  const orphanNodes: TreeNode[] = all.filter((m) => m.uid == null).map((m) => ({ ...m, children: [] }));

  const roots: TreeNode[] = [];
  for (const m of all) {
    const node = m.uid != null ? nodes.get(m.uid)! : orphanNodes.shift()!;
    const parent = m.parent_uid != null ? nodes.get(m.parent_uid) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node); // null OR dangling parent → root
  }
  for (const n of nodes.values()) n.children.sort((a, b) => a.seq - b.seq);
  roots.sort((a, b) => a.seq - b.seq);

  return { sessionId, linked: true, roots };
}
