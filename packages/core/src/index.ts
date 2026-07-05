// @trove/core — framework-free domain logic: adapters, ingest, store, search, metadata.

export * from "./adapters/index.ts";
export { fmtRel, fmtSize, agentLabel, projLabel, shortId } from "./format.ts";
export * from "./paths.ts";
export { openDb, getKv, setKv } from "./db/client.ts";
export type { SessionRow, MessageRow, MetaRow, HighlightRow } from "./db/schema.ts";
export { openContext, maybeSync, type TroveContext } from "./context.ts";
export { sync, type SyncOptions, type SyncResult } from "./ingest/sync.ts";
export {
  searchMessages,
  searchSessions,
  type SearchOptions,
  type SearchHit,
  type SessionHit,
} from "./search/search.ts";
export {
  listSessions,
  status,
  getSessionDetail,
  lookupId,
  type IdHit,
  type ListOptions,
  type SessionListItem,
  type StatusReport,
  type SessionDetail,
} from "./queries.ts";
export { deleteSession, tombstonedPaths, type DeleteResult } from "./curate.ts";
export {
  addHighlight,
  removeHighlight,
  listHighlights,
  highlightsForSession,
  type AddHighlightInput,
  type Highlight,
  type SessionHighlight,
  type ListHighlightsOptions,
} from "./highlights.ts";
export {
  getContext,
  getTree,
  type ContextMessage,
  type ContextResult,
  type TreeNode,
  type TreeResult,
} from "./context-tree.ts";
export { exportSession, type ExportFormat } from "./export.ts";
export { getConfig, summarizerCommand, configPath, type TroveConfig } from "./config.ts";
export {
  summarizeSession,
  getSummary,
  removeSummary,
  type Summary,
  type SummarizeResult,
  type SummarizeOptions,
} from "./summarize.ts";
export { repoRoot } from "./repo.ts";
export {
  resolveSessionId,
  setName,
  setStar,
  setHidden,
  setNotes,
  addTags,
  removeTags,
  type ResolveResult,
} from "./meta.ts";
