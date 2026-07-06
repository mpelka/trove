// Shared, dependency-free display helpers used by both the CLI and the web GUI.
// Single source of truth — these previously drifted between the two surfaces.

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

export const agentLabel = (a: string) =>
  a === "claude-code" ? "CC"
  : a === "gemini-cli" ? "GEM"
  : a === "copilot" ? "COP"
  : a === "antigravity" ? "AGY"
  : a === "chatgpt" ? "GPT"
  : a === "claude-web" ? "CW"
  : a;

export function projLabel(p: string | null): string {
  if (!p) return "no project";
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Git-style short id: `claude-code:<uuid>` → `cc:<first8>`; gemini `session-…` stems
 *  collapse to their trailing hash. Separator is a plain colon — it must be typeable
 *  (`·` isn't on a keyboard); resolvers accept both `:` and legacy `·` forms. */
export function shortId(id: string): string {
  const i = id.indexOf(":");
  const agent = i < 0 ? "" : id.slice(0, i);
  const native = i < 0 ? id : id.slice(i + 1);
  const a =
    agent === "claude-code" ? "cc"
    : agent === "gemini-cli" ? "gem"
    : agent === "copilot" ? "cop"
    : agent === "antigravity" ? "agy"
    : agent === "chatgpt" ? "gpt"
    : agent === "claude-web" ? "cw"
    : agent;
  const core = native.startsWith("session-") ? native.split("-").pop() || native : native;
  return `${a}:${core.slice(0, 8)}`;
}
