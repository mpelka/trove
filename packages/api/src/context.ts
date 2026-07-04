import type { TroveContext } from "@trove/core";
import { initTRPC } from "@trpc/server";

/** tRPC request context: the shared TroveContext (db + adapters). */
export interface ApiContext {
  trove: TroveContext;
}

const t = initTRPC.context<ApiContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
