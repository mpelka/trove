// Raw source view (debug): read a session's on-disk source file in capped chunks.
//
// Chunking contract (byte-offset based):
//   - `offset` is a byte position into the source content (0 = start). Each call returns
//     at most RAW_CHUNK_BYTES of UTF-8 text, cut back to the last newline inside the cap
//     so lines are never split across chunks. A single line longer than the cap is the
//     one exception: it is emitted in cap-sized pieces, cut at UTF-8 character
//     boundaries so decoding stays lossless.
//   - `nextOffset` is the byte position to pass to the next call, or null when the
//     returned chunk reaches the end of the content. Concatenating `text` across an
//     offset walk reproduces the file exactly.
//
// The path always comes from the session row — callers never supply one. When the live
// source file is gone, we fall back to the gzipped archive copy (`raw_path`), gunzipped
// in memory (gzip isn't seekable, and archives only matter for gone sources).

import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { sessions } from "./db/drizzle-schema.ts";

/** ~1MB per chunk — sessions run up to ~30MB locally; never ship whole files. */
export const RAW_CHUNK_BYTES = 1 << 20;

export interface RawSourceChunk {
  available: true;
  text: string;
  /** Byte offset for the next request; null when this chunk reaches the end. */
  nextOffset: number | null;
  totalBytes: number;
  sourcePath: string;
  /** True when the live file is gone and we read the gzipped archive copy instead. */
  fromArchive: boolean;
}

export interface RawSourceUnavailable {
  available: false;
  sourcePath: string;
}

export type RawSourceResult = RawSourceChunk | RawSourceUnavailable;

/** Trim `bytes` (a cap-sized slice starting at `offset`) to a clean cut point:
 *  after the last newline, or — for a single over-cap line — back to a UTF-8
 *  character boundary so the decoded text round-trips byte-exactly. */
function cutAt(bytes: Uint8Array): number {
  const nl = bytes.lastIndexOf(0x0a);
  if (nl >= 0) return nl + 1; // include the newline
  // One giant line: back off past any UTF-8 continuation bytes (0b10xxxxxx).
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] & 0xc0) === 0x80) end--;
  // The lead byte of the split character must go too (unless the slice is all
  // continuation bytes, which can't happen for valid UTF-8 within the cap).
  if (end > 0 && end < bytes.length) end--;
  return end > 0 ? end : bytes.length; // never return 0 — the walk must progress
}

/**
 * Read one chunk of a session's raw source. Returns null when the session id is
 * unknown; `{ available: false }` when neither the live file nor the archived copy
 * exists (never throws for missing files — this is the expected `source_gone` +
 * no-archive case).
 */
export function readRawSource(db: Database, id: string, offset = 0): RawSourceResult | null {
  const d = drizzle(db);
  const row = d
    .select({ sourcePath: sessions.sourcePath, rawPath: sessions.rawPath })
    .from(sessions)
    .where(eq(sessions.id, id))
    .get();
  if (!row) return null;

  if (existsSync(row.sourcePath)) {
    return readLiveChunk(row.sourcePath, offset);
  }
  if (row.rawPath && existsSync(row.rawPath)) {
    const bytes = Bun.gunzipSync(readWholeFile(row.rawPath));
    return chunkOf(bytes, offset, row.sourcePath, true);
  }
  return { available: false, sourcePath: row.sourcePath };
}

/** Read only the cap window from the live file — no whole-file reads (30MB sessions). */
function readLiveChunk(path: string, offset: number): RawSourceChunk {
  const totalBytes = statSync(path).size;
  const start = Math.min(Math.max(0, offset), totalBytes);
  const want = Math.min(RAW_CHUNK_BYTES, totalBytes - start);
  const buf = new Uint8Array(want);
  if (want > 0) {
    const fd = openSync(path, "r");
    try {
      let read = 0;
      while (read < want) {
        const n = readSync(fd, buf, read, want - read, start + read);
        if (n <= 0) break;
        read += n;
      }
    } finally {
      closeSync(fd);
    }
  }
  return finishChunk(buf, start, totalBytes, path, false);
}

function readWholeFile(path: string): Uint8Array<ArrayBuffer> {
  const size = statSync(path).size;
  const buf = new Uint8Array(size);
  const fd = openSync(path, "r");
  try {
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buf, read, size - read, read);
      if (n <= 0) break;
      read += n;
    }
  } finally {
    closeSync(fd);
  }
  return buf;
}

/** Chunk an in-memory content buffer (the gunzipped archive path). */
function chunkOf(bytes: Uint8Array, offset: number, sourcePath: string, fromArchive: boolean): RawSourceChunk {
  const start = Math.min(Math.max(0, offset), bytes.length);
  const window = bytes.subarray(start, Math.min(start + RAW_CHUNK_BYTES, bytes.length));
  return finishChunk(window, start, bytes.length, sourcePath, fromArchive);
}

function finishChunk(
  window: Uint8Array,
  start: number,
  totalBytes: number,
  sourcePath: string,
  fromArchive: boolean,
): RawSourceChunk {
  const atEnd = start + window.length >= totalBytes;
  // Only trim to a line boundary when there's more content after this window —
  // the final chunk is emitted whole (it may lack a trailing newline).
  const emit = atEnd ? window : window.subarray(0, cutAt(window));
  const nextOffset = start + emit.length >= totalBytes ? null : start + emit.length;
  return {
    available: true,
    text: new TextDecoder().decode(emit),
    nextOffset,
    totalBytes,
    sourcePath,
    fromArchive,
  };
}
