import { fmtRel, fmtSize, shortId } from "@trove/core";

// Shared display helpers come from @trove/core (single source of truth with the web
// GUI — these used to drift). Re-exported under the CLI's historical names.
export { fmtSize, shortId };
export const fmtRelative = fmtRel;

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

export function projectName(path: string | null): string {
  if (!path) return c.dim("(no project)");
  return path.replace(process.env.HOME ?? "", "~");
}
