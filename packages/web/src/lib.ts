// Pure, dependency-free helpers for the trove web UI. Extracted verbatim from
// app.tsx so they can be unit-tested (bun:test) without rendering React.

export function fmtRel(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  const d = s / 86400;
  if (d < 30) return `${Math.floor(d)}d`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
}

export function fmtSize(b: number | null | undefined): string {
  if (b == null) return "?";
  if (b < 1024) return `${b}B`;
  if (b < 1048576) return `${Math.round(b / 1024)}K`;
  return `${(b / 1048576).toFixed(1)}M`;
}

export const agentClass = (a: string) =>
  a === "claude-code" ? "cc" : a === "gemini-cli" ? "gemini" : "";
export const agentLabel = (a: string) =>
  a === "claude-code" ? "CC" : a === "gemini-cli" ? "GEM" : a;

export function projLabel(p: string | null): string {
  if (!p) return "no project";
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function shortId(id: string): string {
  const i = id.indexOf(":");
  const agent = i < 0 ? "" : id.slice(0, i);
  const native = i < 0 ? id : id.slice(i + 1);
  const a = agent === "claude-code" ? "cc" : agent === "gemini-cli" ? "gem" : agent;
  const core = native.startsWith("session-") ? native.split("-").pop() || native : native;
  return `${a}·${core.slice(0, 8)}`;
}

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
