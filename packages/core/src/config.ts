import { readFileSync } from "node:fs";
import { join } from "node:path";
import { troveDir } from "./paths.ts";

/**
 * User config, read from `$TROVE_DIR/config.json` (default `~/.trove/config.json`).
 * Everything here is opaque, user-supplied — trove itself never calls a network API.
 *
 * `summarizer` is a shell command that reads a session's markdown export on **stdin** and
 * writes a summary to **stdout** (e.g. `gemini -p 'Summarize the key insights:'` at work, a
 * local LLM at home). Missing file / missing key → summarizer unavailable. Malformed JSON is
 * warned-and-ignored, never thrown — a broken config must not brick the CLI or server.
 */
export interface TroveConfig {
  summarizer: string | null;
}

export function configPath(): string {
  return join(troveDir(), "config.json");
}

/** Read + parse the config. Never throws: missing → empty config, malformed → warn + empty. */
export function getConfig(): TroveConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath(), "utf8");
  } catch {
    // no file (ENOENT) or unreadable → summarizer simply unavailable
    return { summarizer: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(
      `trove: ignoring malformed ${configPath()} (${(err as Error).message}) — summarizer unavailable`,
    );
    return { summarizer: null };
  }
  if (!parsed || typeof parsed !== "object") return { summarizer: null };
  const s = (parsed as Record<string, unknown>).summarizer;
  return { summarizer: typeof s === "string" && s.trim() ? s : null };
}

/** The configured summarizer command, or null when unset/unavailable. */
export function summarizerCommand(): string | null {
  return getConfig().summarizer;
}
