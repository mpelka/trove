// Pure helpers for the trove web UI, unit-tested here (bun:test) without rendering
// React. Display formatters shared with the CLI live in @trove/core — imported via the
// browser-safe `/format` subpath (the core barrel pulls in bun:sqlite, which the
// browser bundle cannot load).

export { fmtRel, fmtSize, agentLabel, projLabel, shortId } from "@trove/core/format";

/** Web-only: CSS class per agent (colors the round agent logo). */
export const agentClass = (a: string) =>
  a === "claude-code" ? "cc" : a === "gemini-cli" ? "gemini" : "";

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

export function parseUsed(text: string): string[] {
  const m = text.match(/^\[used:\s*(.+)\]$/);
  if (!m) return [text];
  return m[1].split(",").map((s) => s.trim()).filter(Boolean);
}

export function summarizeTools(counts: Map<string, number>): string {
  return `[used: ${[...counts.entries()].map(([n, c]) => (c > 1 ? `${c}×${n}` : n)).join(", ")}]`;
}

export type RenderItem =
  | { kind: "msg"; id: number; role: string; text: string; ts: number | null }
  | { kind: "tools"; id: number; counts: Map<string, number>; ts: number | null };

export function buildItems(
  messages: { id: number; role: string; text: string; timestamp: number | null }[],
): RenderItem[] {
  const items: RenderItem[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      const names = parseUsed(m.text);
      const last = items[items.length - 1];
      if (last && last.kind === "tools") {
        for (const n of names) last.counts.set(n, (last.counts.get(n) ?? 0) + 1);
        last.ts = m.timestamp;
      } else {
        const counts = new Map<string, number>();
        for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
        items.push({ kind: "tools", id: m.id, counts, ts: m.timestamp });
      }
    } else {
      items.push({ kind: "msg", id: m.id, role: m.role, text: m.text, ts: m.timestamp });
    }
  }
  return items;
}
