import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { summaries } from "./db/drizzle-schema.ts";
import { exportSession } from "./export.ts";
import { summarizerCommand } from "./config.ts";

/**
 * Ghostwriter (issue #17): summarize a session by piping its markdown export through a
 * USER-CONFIGURED shell command. trove stays zero-network — it never calls any API; the
 * summarizer is opaque config (`gemini -p '…'` at work, a local LLM at home).
 *
 * The command reads the markdown on stdin and writes the summary to stdout. We run it via
 * `sh -c <cmd>` with the markdown fed in, capture stdout/stderr, and enforce a timeout.
 * Failure (no summarizer, non-zero exit, timeout, empty output) is returned as a typed
 * error result — never thrown raw — so callers can surface it gracefully.
 */

export interface Summary {
  sessionId: string;
  text: string;
  createdAt: number;
}

export type SummarizeResult =
  | { ok: true; summary: Summary }
  | { ok: false; error: string };

const DEFAULT_TIMEOUT_MS = 120_000;

export function getSummary(db: Database, id: string): Summary | null {
  const d = drizzle(db);
  const row = d
    .select({
      sessionId: summaries.sessionId,
      text: summaries.text,
      createdAt: summaries.createdAt,
    })
    .from(summaries)
    .where(eq(summaries.sessionId, id))
    .get();
  return row ?? null;
}

export function removeSummary(db: Database, id: string): void {
  const d = drizzle(db);
  d.delete(summaries).where(eq(summaries.sessionId, id)).run();
}

function upsertSummary(db: Database, id: string, text: string): Summary {
  const createdAt = Date.now();
  const d = drizzle(db);
  d.insert(summaries)
    .values({ sessionId: id, text, createdAt })
    .onConflictDoUpdate({ target: summaries.sessionId, set: { text, createdAt } })
    .run();
  return { sessionId: id, text, createdAt };
}

export interface SummarizeOptions {
  force?: boolean;
  timeoutMs?: number;
}

export async function summarizeSession(
  db: Database,
  id: string,
  opts: SummarizeOptions = {},
): Promise<SummarizeResult> {
  // Return a cached summary unless the caller forces a re-run.
  if (!opts.force) {
    const existing = getSummary(db, id);
    if (existing) return { ok: true, summary: existing };
  }

  const cmd = summarizerCommand();
  if (!cmd) {
    return {
      ok: false,
      error:
        'no summarizer configured — add {"summarizer": "…"} to your trove config.json',
    };
  }

  const markdown = exportSession(db, id, "md");
  if (markdown == null) return { ok: false, error: `no session matching "${id}"` };

  let stdout: string;
  let stderr: string;
  let exitCode: number;
  try {
    const proc = Bun.spawn(["sh", "-c", cmd], {
      stdin: new TextEncoder().encode(markdown),
      stdout: "pipe",
      stderr: "pipe",
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    exitCode = await proc.exited;
  } catch (err) {
    return { ok: false, error: `summarizer failed to run: ${(err as Error).message}` };
  }

  if (exitCode !== 0) {
    const detail = stderr.trim() || `exit code ${exitCode}`;
    return { ok: false, error: `summarizer exited non-zero: ${detail}` };
  }
  const text = stdout.trim();
  if (!text) return { ok: false, error: "summarizer produced no output" };

  return { ok: true, summary: upsertSummary(db, id, text) };
}
