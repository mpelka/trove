// Pure helpers for the trove web UI, unit-tested here (bun:test) without rendering
// React. Display formatters shared with the CLI live in @trove/core — imported via the
// browser-safe `/format` subpath (the core barrel pulls in bun:sqlite, which the
// browser bundle cannot load).

export { fmtRel, fmtSize, agentLabel, projLabel, shortId } from "@trove/core/format";

/** Web-only: CSS class per agent (colors the round agent logo). */
export const agentClass = (a: string) =>
  a === "claude-code" ? "cc"
  : a === "gemini-cli" ? "gemini"
  : a === "copilot" ? "copilot"
  : a === "antigravity" ? "agy"
  : a === "chatgpt" ? "chatgpt"
  : "";

export function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function rehypeHighlight(query: string) {
  const terms = query.trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
  return () => (tree: any) => {
    if (!terms.length) return;
    const re = new RegExp(`(${terms.join("|")})`, "i");
    const walk = (node: any) => {
      if (!node.children) return;
      const out: any[] = [];
      for (const child of node.children) {
        if (child.type === "text" && re.test(child.value)) {
          child.value.split(re).forEach((part: string, idx: number) => {
            if (part === "") return;
            if (idx % 2 === 1)
              out.push({ type: "element", tagName: "mark", properties: {}, children: [{ type: "text", value: part }] });
            else out.push({ type: "text", value: part });
          });
        } else {
          if (child.type === "element") walk(child);
          out.push(child);
        }
      }
      node.children = out;
    };
    walk(tree);
  };
}

export interface HL {
  id: number;
  text: string;
}

/**
 * Second rehype pass that marks saved highlights (distinct from the search-term pass).
 * For each highlight we do an EXACT, case-sensitive substring match within a single text
 * node and wrap the match in `<mark class="hl" data-hl-id=…>`.
 *
 * Markdown can split a phrase across text nodes (e.g. `**bold** word` → three nodes), so an
 * exact match on any single node may miss. When that happens the mark simply isn't placed;
 * the caller detects the miss separately (raw text `.includes`) and falls back to a
 * message-level tint + glyph so the highlight is never invisible. We only ever mark the FIRST
 * occurrence per highlight to avoid double-marking repeated phrases.
 */
export function rehypeHighlightExact(highlights: HL[]) {
  return () => (tree: any) => {
    if (!highlights.length) return;
    const pending = highlights.filter((h) => h.text.length > 0);
    const walk = (node: any) => {
      if (!node.children) return;
      const out: any[] = [];
      for (const child of node.children) {
        if (child.type === "text") {
          // find the earliest-starting still-pending highlight present in this node
          let best: { hl: HL; idx: number } | null = null;
          for (const hl of pending) {
            const idx = child.value.indexOf(hl.text);
            if (idx >= 0 && (best === null || idx < best.idx)) best = { hl, idx };
          }
          if (best) {
            const { hl, idx } = best;
            const before = child.value.slice(0, idx);
            const mid = child.value.slice(idx, idx + hl.text.length);
            const after = child.value.slice(idx + hl.text.length);
            if (before) out.push({ type: "text", value: before });
            out.push({
              type: "element",
              tagName: "mark",
              properties: { className: ["hl"], "data-hl-id": String(hl.id) },
              children: [{ type: "text", value: mid }],
            });
            if (after) out.push({ type: "text", value: after });
            pending.splice(pending.indexOf(hl), 1); // mark once
          } else {
            out.push(child);
          }
        } else {
          if (child.type === "element") walk(child);
          out.push(child);
        }
      }
      node.children = out;
    };
    walk(tree);
  };
}

export function parseUsed(text: string): string[] {
  const m = text.match(/^\[used:\s*(.+)\]$/);
  if (!m) return [text];
  return m[1].split(",").map((s) => s.trim()).filter(Boolean);
}

export function summarizeTools(counts: Map<string, number>): string {
  return `[used: ${[...counts.entries()].map(([n, c]) => (c > 1 ? `${c}×${n}` : n)).join(", ")}]`;
}

export interface ToolCall {
  name: string;
  input: string;
}

/** Parse the `tool_calls` JSON column into an ordered ToolCall[]. Tolerant of null/absent
 *  (older rows synced before issue #20) and malformed JSON — returns [] rather than throwing. */
export function parseToolCalls(raw: string | null | undefined): ToolCall[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((c) => c && typeof c.name === "string")
      .map((c) => ({ name: c.name as string, input: typeof c.input === "string" ? c.input : "" }));
  } catch {
    return [];
  }
}

export type RenderItem =
  | { kind: "msg"; id: number; uid: string | null; seq: number; role: string; text: string; ts: number | null }
  | { kind: "tools"; id: number; counts: Map<string, number>; calls: ToolCall[]; ts: number | null };

export function buildItems(
  messages: {
    id: number;
    uid?: string | null;
    seq?: number;
    role: string;
    text: string;
    timestamp: number | null;
    tool_calls?: string | null;
  }[],
): RenderItem[] {
  const items: RenderItem[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      const names = parseUsed(m.text);
      // Prefer the structured per-call records; fall back to the deduped names from the
      // `[used: …]` summary for older rows that predate the tool_calls column.
      const parsed = parseToolCalls(m.tool_calls);
      const calls: ToolCall[] = parsed.length ? parsed : names.map((n) => ({ name: n, input: "" }));
      const last = items[items.length - 1];
      if (last && last.kind === "tools") {
        for (const n of names) last.counts.set(n, (last.counts.get(n) ?? 0) + 1);
        last.calls.push(...calls);
        last.ts = m.timestamp;
      } else {
        const counts = new Map<string, number>();
        for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
        items.push({ kind: "tools", id: m.id, counts, calls, ts: m.timestamp });
      }
    } else {
      items.push({
        kind: "msg",
        id: m.id,
        uid: m.uid ?? null,
        seq: m.seq ?? 0,
        role: m.role,
        text: m.text,
        ts: m.timestamp,
      });
    }
  }
  return items;
}
