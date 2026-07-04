import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

/** trove's own writable data dir (never an agent's store). Override with TROVE_DIR. */
export function troveDir(): string {
  return process.env.TROVE_DIR || join(homedir(), ".trove");
}

export function dbPath(): string {
  return join(troveDir(), "trove.db");
}

/** Where optional gzipped raw session copies live. */
export function archiveDir(): string {
  return join(troveDir(), "archive");
}

export function ensureDirs(): void {
  mkdirSync(troveDir(), { recursive: true });
  mkdirSync(archiveDir(), { recursive: true });
}
