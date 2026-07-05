/**
 * Drizzle typed table definitions for the trove SQLite store.
 *
 * These mirror the physical columns/types/PKs/defaults of the `*Row` interfaces in schema.ts.
 * They are used for typed QUERIES *and* are the source `drizzle-kit generate` diffs to emit
 * migrations (issue #19).
 *
 * NOTE: the FTS5 virtual table `messages_fts` and its triggers can't be expressed here; they
 * are created + maintained by hand inside the baseline migration (packages/core/drizzle) and
 * are outside drizzle-kit's model, so `generate` never touches them. Keep the columns here in
 * lockstep with the physical schema — a `generate` run turns any drift into a migration.
 *
 * Booleans are stored as 0/1 integers (kept raw, no drizzle boolean mode). JSON columns
 * (agent_specific, tags) are plain TEXT — JSON.stringify/parse stays at the call boundary.
 */

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  agent: text("agent").notNull(),
  nativeId: text("native_id").notNull(),
  sourcePath: text("source_path").notNull(),
  sourceMedium: text("source_medium").notNull(),
  projectPath: text("project_path"),
  createdAt: integer("created_at"),
  updatedAt: integer("updated_at"),
  sizeBytes: integer("size_bytes"),
  turnCount: integer("turn_count"),
  messageCount: integer("message_count"),
  model: text("model"),
  sourceTitle: text("source_title"),
  kind: text("kind"),
  agentSpecific: text("agent_specific"),
  rawPath: text("raw_path"),
  contentHash: text("content_hash").notNull(),
  sourceMtime: integer("source_mtime"),
  importedAt: integer("imported_at").notNull(),
  sourceGone: integer("source_gone").notNull().default(0),
});

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  uid: text("uid"),
  sessionId: text("session_id").notNull(),
  seq: integer("seq").notNull(),
  role: text("role").notNull(),
  parentUid: text("parent_uid"),
  timestamp: integer("timestamp"),
  text: text("text").notNull(),
  // JSON array of compact per-tool_use records `[{name,input}, …]`, one per tool_use in
  // order (NOT deduped like the `text` summary). null/absent for non-tool messages and
  // for rows synced before issue #20. Stringify/parse stays at the call boundary.
  toolCalls: text("tool_calls"),
});

export const sessionMeta = sqliteTable("session_meta", {
  sessionId: text("session_id").primaryKey(),
  customName: text("custom_name"),
  starred: integer("starred").notNull().default(0),
  tags: text("tags"),
  notes: text("notes"),
  hidden: integer("hidden").notNull().default(0),
});

export const kv = sqliteTable("kv", {
  key: text("key").primaryKey(),
  value: text("value"),
});

export const highlights = sqliteTable("highlights", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").notNull(),
  messageUid: text("message_uid"),
  messageSeq: integer("message_seq"),
  text: text("text").notNull(),
  note: text("note"),
  createdAt: integer("created_at").notNull(),
});

export const summaries = sqliteTable("summaries", {
  sessionId: text("session_id").primaryKey(),
  text: text("text").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const tombstones = sqliteTable("tombstones", {
  sourcePath: text("source_path").primaryKey(),
  id: text("id"),
  deletedAt: integer("deleted_at"),
});
