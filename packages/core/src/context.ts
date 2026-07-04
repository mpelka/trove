import type { Database } from "bun:sqlite";
import { openDb, getKv } from "./db/client.ts";
import { ensureDirs, dbPath } from "./paths.ts";
import { adapters as allAdapters } from "./adapters/index.ts";
import { sync, type SyncOptions, type SyncResult } from "./ingest/sync.ts";
import type { Adapter } from "./adapters/types.ts";

export interface TroveContext {
  db: Database;
  adapters: Adapter[];
  close(): void;
}

/** Open the store (creating the data dir + db on first use) and bind the adapters. */
export function openContext(opts?: { adapters?: Adapter[] }): TroveContext {
  ensureDirs();
  const db = openDb(dbPath());
  return {
    db,
    adapters: opts?.adapters ?? allAdapters,
    close() {
      db.close();
    },
  };
}

/**
 * Cooldown-gated JIT sync: run an incremental sync only if the last one is older than
 * `ttlMs`. This is what keeps a pure-CLI call fresh without a background daemon.
 */
export async function maybeSync(
  ctx: TroveContext,
  ttlMs = 5 * 60 * 1000,
  opts: SyncOptions = {},
): Promise<SyncResult | null> {
  const last = getKv(ctx.db, "last_sync");
  const age = last ? Date.now() - Number(last) : Infinity;
  if (age < ttlMs) return null;
  return sync(ctx.db, ctx.adapters, opts);
}
