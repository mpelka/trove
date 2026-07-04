// @trove/core — framework-free domain logic: adapters, ingest, store, search, metadata.

export * from "./adapters/index.ts";
export * from "./paths.ts";
export { openDb, getKv, setKv } from "./db/client.ts";
export type { SessionRow, MessageRow, MetaRow } from "./db/schema.ts";
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
  type ListOptions,
  type SessionListItem,
  type StatusReport,
  type SessionDetail,
} from "./queries.ts";
export { deleteSession, tombstonedPaths, type DeleteResult } from "./curate.ts";
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
