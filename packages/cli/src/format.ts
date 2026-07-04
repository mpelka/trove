const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;

const wrap = (code: string) => (s: string | number) =>
  useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s);

export const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
};

export function fmtSize(bytes: number | null | undefined): string {
  if (bytes == null) return "?";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}M`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}G`;
}

export function fmtDate(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtRelative(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  return fmtDate(ms);
}

/** Short session id for display: `claude-code:<uuid>` → `cc:<first8>`. */
export function shortId(id: string): string {
  const [agent, native] = id.split(/:(.+)/);
  const a = agent === "claude-code" ? "cc" : agent;
  return `${a}:${(native ?? "").slice(0, 8)}`;
}

export function projectName(path: string | null): string {
  if (!path) return c.dim("(no project)");
  return path.replace(process.env.HOME ?? "", "~");
}
