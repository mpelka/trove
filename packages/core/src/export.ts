import type { Database } from "bun:sqlite";
import { getSessionDetail } from "./queries.ts";

export type ExportFormat = "md" | "json";

/**
 * Serialize a whole session for external use. `md` renders a portable transcript
 * (header + metadata block + `## You` / `## Assistant` sections, text verbatim since it's
 * already markdown; tool markers as blockquotes). `json` returns the raw detail shape
 * ({ session, messages }) for machine consumption. Returns null for an unknown id.
 */
export function exportSession(db: Database, id: string, format: ExportFormat): string | null {
  const detail = getSessionDetail(db, id);
  if (!detail) return null;
  if (format === "json") return JSON.stringify(detail, null, 2);

  const s = detail.session;
  const out: string[] = [];
  out.push(`# ${s.name}`);
  out.push("");
  out.push("| field | value |");
  out.push("| --- | --- |");
  out.push(`| agent | ${s.agent} |`);
  out.push(`| project | ${s.projectPath ?? "—"} |`);
  out.push(`| model | ${s.model ?? "—"} |`);
  out.push(`| created | ${fmtIso(s.createdAt)} |`);
  out.push(`| updated | ${fmtIso(s.updatedAt)} |`);
  out.push(`| id | ${s.id} |`);
  out.push("");

  for (const m of detail.messages) {
    if (m.role === "user") out.push("## You");
    else if (m.role === "assistant") out.push("## Assistant");
    else out.push(`## ${m.role[0].toUpperCase()}${m.role.slice(1)}`);
    out.push("");
    if (m.role === "tool") {
      // tool markers (e.g. `[used: Read, Edit]`) rendered as a blockquote.
      for (const line of m.text.split("\n")) out.push(`> ${line}`);
    } else {
      out.push(m.text);
    }
    out.push("");
  }

  if (detail.highlights.length) {
    out.push("## Highlights");
    out.push("");
    for (const h of detail.highlights) {
      // blockquote each line so multi-line highlights stay a single quote block
      for (const line of h.text.split("\n")) out.push(`> ${line}`);
      if (h.note) out.push(`>\n> — ${h.note}`);
      out.push("");
    }
  }
  return out.join("\n").replace(/\n+$/, "\n");
}

function fmtIso(ms: number | null): string {
  return ms == null ? "—" : new Date(ms).toISOString();
}
