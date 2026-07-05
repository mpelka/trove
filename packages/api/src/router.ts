import { z } from "zod";
import {
  getAdapter,
  listSessions,
  status,
  getSessionDetail,
  lookupId,
  searchSessions,
  searchMessages,
  getContext,
  getTree,
  sync,
  deleteSession,
  setName,
  setStar,
  setHidden,
  setNotes,
  addTags,
  removeTags,
  addHighlight,
  removeHighlight,
  listHighlights,
  summarizerCommand,
  summarizeSession,
  removeSummary,
} from "@trove/core";
import { router, publicProcedure } from "./context.ts";

const searchInput = z.object({
  query: z.string().min(1),
  agent: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
  exact: z.boolean().optional(),
  star: z.boolean().optional(),
  project: z.string().optional(),
  tag: z.string().optional(),
  since: z.number().optional(),
  until: z.number().optional(),
  groupBySession: z.boolean().optional(), // false → message-level hits
  sort: z.enum(["relevance", "recent"]).optional(),
});

const listInput = z
  .object({
    agent: z.string().optional(),
    star: z.boolean().optional(),
    project: z.string().optional(),
    tag: z.string().optional(),
    includeHidden: z.boolean().optional(),
    sort: z.enum(["updated", "created", "name", "turns"]).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    limit: z.number().int().positive().max(500).optional(),
  })
  .optional();

const idInput = z.object({ id: z.string() });

export const appRouter = router({
  status: publicProcedure.query(({ ctx }) => status(ctx.trove.db)),

  list: publicProcedure
    .input(listInput)
    .query(({ ctx, input }) => listSessions(ctx.trove.db, input ?? {})),

  search: publicProcedure.input(searchInput).query(({ ctx, input }) => {
    // groupBySession is an API-level switch between the two result shapes; core's
    // searchMessages/searchSessions don't consume it.
    if (input.groupBySession === false) {
      return { kind: "messages" as const, hits: searchMessages(ctx.trove.db, input) };
    }
    return { kind: "sessions" as const, hits: searchSessions(ctx.trove.db, input) };
  }),

  resolveId: publicProcedure
    .input(z.object({ q: z.string() }))
    .query(({ ctx, input }) => lookupId(ctx.trove.db, input.q)),

  sessionDetail: publicProcedure.input(idInput).query(({ ctx, input }) => {
    const detail = getSessionDetail(ctx.trove.db, input.id);
    if (!detail) return null;
    const adapter = getAdapter(detail.session.agent);
    const resumeCommand =
      adapter?.buildResumeCommand?.({
        nativeId: detail.session.nativeId,
        projectPath: detail.session.projectPath,
        rawPath: detail.session.rawPath,
      }) ?? null;
    return { ...detail, resumeCommand };
  }),

  context: publicProcedure
    .input(z.object({ messageId: z.number().int().positive(), depth: z.number().int().positive().max(50).optional() }))
    .query(({ ctx, input }) => getContext(ctx.trove.db, input.messageId, input.depth)),

  tree: publicProcedure
    .input(idInput)
    .query(({ ctx, input }) => getTree(ctx.trove.db, input.id)),

  sync: publicProcedure
    .input(z.object({ keepRaw: z.boolean().optional(), agentIds: z.array(z.string()).optional() }).optional())
    .mutation(async ({ ctx, input }) => sync(ctx.trove.db, ctx.trove.adapters, input ?? {})),

  deleteSession: publicProcedure
    .input(idInput.extend({ deleteSource: z.boolean().optional() }))
    .mutation(({ ctx, input }) =>
      deleteSession(ctx.trove.db, input.id, { deleteSource: input.deleteSource }),
    ),

  setName: publicProcedure
    .input(idInput.extend({ name: z.string().nullable() }))
    .mutation(({ ctx, input }) => {
      setName(ctx.trove.db, input.id, input.name);
      return { ok: true as const };
    }),

  setStar: publicProcedure
    .input(idInput.extend({ starred: z.boolean() }))
    .mutation(({ ctx, input }) => {
      setStar(ctx.trove.db, input.id, input.starred);
      return { ok: true as const };
    }),

  setHidden: publicProcedure
    .input(idInput.extend({ hidden: z.boolean() }))
    .mutation(({ ctx, input }) => {
      setHidden(ctx.trove.db, input.id, input.hidden);
      return { ok: true as const };
    }),

  setNotes: publicProcedure
    .input(idInput.extend({ notes: z.string().nullable() }))
    .mutation(({ ctx, input }) => {
      setNotes(ctx.trove.db, input.id, input.notes);
      return { ok: true as const };
    }),

  addTags: publicProcedure
    .input(idInput.extend({ tags: z.array(z.string()) }))
    .mutation(({ ctx, input }) => ({ tags: addTags(ctx.trove.db, input.id, input.tags) })),

  removeTags: publicProcedure
    .input(idInput.extend({ tags: z.array(z.string()) }))
    .mutation(({ ctx, input }) => ({ tags: removeTags(ctx.trove.db, input.id, input.tags) })),

  addHighlight: publicProcedure
    .input(
      z.object({
        sessionId: z.string().min(1),
        messageUid: z.string().nullable().optional(),
        messageSeq: z.number().int().nonnegative().nullable().optional(),
        text: z.string().min(1),
        note: z.string().nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => ({ id: addHighlight(ctx.trove.db, input) })),

  removeHighlight: publicProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(({ ctx, input }) => {
      removeHighlight(ctx.trove.db, input.id);
      return { ok: true as const };
    }),

  highlights: publicProcedure
    .input(
      z
        .object({
          sessionId: z.string().optional(),
          limit: z.number().int().positive().max(500).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => listHighlights(ctx.trove.db, input ?? {})),

  // ── ghostwriter (issue #17) ────────────────────────────────────────────────
  // Whether the GUI should offer the summarize action (a summarizer is configured).
  summarizerAvailable: publicProcedure.query(() => summarizerCommand() != null),

  summarize: publicProcedure
    .input(idInput.extend({ force: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const r = await summarizeSession(ctx.trove.db, input.id, { force: input.force });
      return r.ok
        ? { ok: true as const, summary: r.summary }
        : { ok: false as const, error: r.error };
    }),

  removeSummary: publicProcedure.input(idInput).mutation(({ ctx, input }) => {
    removeSummary(ctx.trove.db, input.id);
    return { ok: true as const };
  }),
});

export type AppRouter = typeof appRouter;
