import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "./db/client.ts";
import { readRawSource, RAW_CHUNK_BYTES } from "./raw.ts";

let dir: string;
let db: Database;

function seedSession(id: string, sourcePath: string, rawPath: string | null = null) {
  db.query(
    `INSERT INTO sessions (id, agent, native_id, source_path, source_medium, raw_path,
       content_hash, imported_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, "gemini-cli", id.split(":")[1], sourcePath, "file", rawPath, "h", Date.now());
}

/** Walk the offset chain from 0 and reassemble the full text. */
function walk(id: string): { text: string; chunks: number; meta: { totalBytes: number; fromArchive: boolean } } {
  let text = "";
  let chunks = 0;
  let offset: number | null = 0;
  let meta = { totalBytes: 0, fromArchive: false };
  while (offset != null) {
    const r = readRawSource(db, id, offset);
    if (!r || !r.available) throw new Error("chunk unavailable mid-walk");
    text += r.text;
    chunks++;
    meta = { totalBytes: r.totalBytes, fromArchive: r.fromArchive };
    offset = r.nextOffset;
  }
  return { text, chunks, meta };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "trove-raw-"));
  db = openDb(join(dir, "raw.db"));
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("readRawSource", () => {
  it("returns null for an unknown session id", () => {
    expect(readRawSource(db, "nope:missing")).toBeNull();
  });

  it("reads a small live file in one chunk", () => {
    const p = join(dir, "small.jsonl");
    const content = '{"a":1}\n{"b":"two"}\nnot json\n';
    writeFileSync(p, content);
    seedSession("gemini-cli:small", p);
    const r = readRawSource(db, "gemini-cli:small");
    expect(r).not.toBeNull();
    if (!r || !r.available) throw new Error("expected available");
    expect(r.text).toBe(content);
    expect(r.nextOffset).toBeNull();
    expect(r.totalBytes).toBe(Buffer.byteLength(content));
    expect(r.sourcePath).toBe(p);
    expect(r.fromArchive).toBe(false);
  });

  it("chunks at line boundaries and an offset walk reassembles the file exactly", () => {
    // ~2.5MB of .jsonl-ish lines (multi-byte chars included to stress the decoder).
    const line = `{"seq":%,"text":"żółć — ${"x".repeat(200)}"}`;
    let content = "";
    for (let i = 0; content.length < 2.5 * RAW_CHUNK_BYTES; i++) content += line.replace("%", String(i)) + "\n";
    const p = join(dir, "big.jsonl");
    writeFileSync(p, content);
    seedSession("gemini-cli:big", p);

    const first = readRawSource(db, "gemini-cli:big");
    if (!first || !first.available) throw new Error("expected available");
    expect(first.text.length).toBeLessThanOrEqual(RAW_CHUNK_BYTES);
    expect(first.text.endsWith("\n")).toBe(true); // cut at a line boundary
    expect(first.nextOffset).toBe(Buffer.byteLength(first.text)); // byte offset, not char count
    expect(first.totalBytes).toBe(Buffer.byteLength(content));

    const { text, chunks } = walk("gemini-cli:big");
    expect(chunks).toBeGreaterThanOrEqual(3);
    expect(text).toBe(content); // byte-exact reassembly
  });

  it("respects the cap on an oversized single line (no newline within the cap)", () => {
    // One giant 1.5MB line with multi-byte chars: emitted in cap-sized pieces, cut at
    // UTF-8 character boundaries, and still reassembles exactly.
    const content = "ą".repeat(Math.ceil((1.5 * RAW_CHUNK_BYTES) / 2)) + "\n";
    const p = join(dir, "giant-line.jsonl");
    writeFileSync(p, content);
    seedSession("gemini-cli:giant", p);

    const first = readRawSource(db, "gemini-cli:giant");
    if (!first || !first.available) throw new Error("expected available");
    expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(RAW_CHUNK_BYTES);
    expect(first.text).not.toInclude("�"); // no replacement chars → clean UTF-8 cut
    expect(first.nextOffset).not.toBeNull();

    const { text } = walk("gemini-cli:giant");
    expect(text).toBe(content);
  });

  it("falls back to the gzipped archive when the live file is gone", () => {
    const content = '{"archived":true}\n{"line":2}\n';
    const rawPath = join(dir, "gone.raw.gz");
    writeFileSync(rawPath, Bun.gzipSync(new TextEncoder().encode(content)));
    seedSession("gemini-cli:gone", join(dir, "does-not-exist.jsonl"), rawPath);

    const r = readRawSource(db, "gemini-cli:gone");
    if (!r || !r.available) throw new Error("expected available");
    expect(r.text).toBe(content);
    expect(r.fromArchive).toBe(true);
    expect(r.nextOffset).toBeNull();
    expect(r.totalBytes).toBe(Buffer.byteLength(content)); // decompressed size
  });

  it("chunks the archive path too (offsets are into the decompressed bytes)", () => {
    let content = "";
    for (let i = 0; content.length < 1.5 * RAW_CHUNK_BYTES; i++) content += `{"i":${i}}\n`;
    const rawPath = join(dir, "gone-big.raw.gz");
    writeFileSync(rawPath, Bun.gzipSync(new TextEncoder().encode(content)));
    seedSession("gemini-cli:gonebig", join(dir, "also-missing.jsonl"), rawPath);

    const { text, chunks, meta } = walk("gemini-cli:gonebig");
    expect(chunks).toBeGreaterThanOrEqual(2);
    expect(text).toBe(content);
    expect(meta.fromArchive).toBe(true);
  });

  it("returns a typed unavailable result when both the source and the archive are missing", () => {
    seedSession("gemini-cli:lost", join(dir, "never-was.jsonl"), join(dir, "never-was.raw.gz"));
    const r = readRawSource(db, "gemini-cli:lost");
    expect(r).toEqual({ available: false, sourcePath: join(dir, "never-was.jsonl") });
  });

  it("clamps an offset at/past the end to an empty final chunk", () => {
    const r = readRawSource(db, "gemini-cli:small", 10_000_000);
    if (!r || !r.available) throw new Error("expected available");
    expect(r.text).toBe("");
    expect(r.nextOffset).toBeNull();
  });
});
