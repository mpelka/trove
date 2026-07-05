import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "./db/client.ts";
import { configPath } from "./config.ts";
import { summarizeSession, getSummary, removeSummary } from "./summarize.ts";
import { deleteSession } from "./curate.ts";
import { getSessionDetail } from "./queries.ts";

let dir: string;
let db: Database;
const OLD_TROVE_DIR = process.env.TROVE_DIR;

const ID = "claude-code:sum-one";

function writeConfig(summarizer: string | null) {
  writeFileSync(configPath(), JSON.stringify(summarizer == null ? {} : { summarizer }));
}

function seed(id: string) {
  db.query(
    `INSERT INTO sessions (id, agent, native_id, source_path, source_medium, source_title,
       content_hash, imported_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, "claude-code", id.split(":")[1], `/src/${id}`, "file", "Sum session", "h", Date.now());
  db.query(
    "INSERT INTO messages (uid, session_id, seq, role, parent_uid, timestamp, text) VALUES (?,?,?,?,?,?,?)",
  ).run("u0", id, 0, "user", null, 1000, "how do I center a div");
  db.query(
    "INSERT INTO messages (uid, session_id, seq, role, parent_uid, timestamp, text) VALUES (?,?,?,?,?,?,?)",
  ).run("u1", id, 1, "assistant", "u0", 2000, "use flexbox");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trove-sum-"));
  process.env.TROVE_DIR = dir;
  db = openDb(join(dir, "trove.db"));
  seed(ID);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  if (OLD_TROVE_DIR === undefined) delete process.env.TROVE_DIR;
  else process.env.TROVE_DIR = OLD_TROVE_DIR;
});

describe("summarizeSession", () => {
  it("returns a typed error (never throws) when no summarizer is configured", async () => {
    writeConfig(null);
    const r = await summarizeSession(db, ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no summarizer configured");
    expect(getSummary(db, ID)).toBeNull();
  });

  it("runs the configured (fake) summarizer over the markdown and stores the result", async () => {
    // fake summarizer: prints a marker + the first line of the piped markdown export
    writeConfig(`sh -c 'echo "SUMMARY:" && head -1'`);
    const r = await summarizeSession(db, ID);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary.text).toContain("SUMMARY:");
      // the markdown export starts with the session title header
      expect(r.summary.text).toContain("# Sum session");
      expect(r.summary.createdAt).toBeGreaterThan(0);
    }
    // persisted
    const stored = getSummary(db, ID)!;
    expect(stored.text).toContain("SUMMARY:");
    expect(stored.sessionId).toBe(ID);
  });

  it("returns the cached summary without re-running, unless forced", async () => {
    writeConfig(`sh -c 'head -c 20'`);
    const first = await summarizeSession(db, ID);
    expect(first.ok).toBe(true);
    const firstText = first.ok ? first.summary.text : "";

    // change the summarizer to prove a cached call does NOT re-run it
    writeConfig(`sh -c 'echo DIFFERENT'`);
    const cached = await summarizeSession(db, ID);
    expect(cached.ok).toBe(true);
    if (cached.ok) expect(cached.summary.text).toBe(firstText);

    // force re-runs with the new command
    const forced = await summarizeSession(db, ID, { force: true });
    expect(forced.ok).toBe(true);
    if (forced.ok) expect(forced.summary.text).toBe("DIFFERENT");
  });

  it("returns a typed error on non-zero exit", async () => {
    writeConfig(`sh -c 'exit 3'`);
    const r = await summarizeSession(db, ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("non-zero");
    expect(getSummary(db, ID)).toBeNull();
  });

  it("returns a typed error on empty output", async () => {
    writeConfig(`sh -c 'true'`);
    const r = await summarizeSession(db, ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no output");
  });

  it("returns a typed error for an unknown session id", async () => {
    writeConfig(`sh -c 'cat'`);
    const r = await summarizeSession(db, "nope:missing");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no session");
  });

  it("times out a hung summarizer without throwing", async () => {
    writeConfig(`sh -c 'sleep 5'`);
    const r = await summarizeSession(db, ID, { timeoutMs: 100 });
    expect(r.ok).toBe(false);
    expect(getSummary(db, ID)).toBeNull();
  });
});

describe("getSummary / removeSummary", () => {
  it("removes a stored summary", async () => {
    writeConfig(`sh -c 'echo hi'`);
    await summarizeSession(db, ID);
    expect(getSummary(db, ID)).not.toBeNull();
    removeSummary(db, ID);
    expect(getSummary(db, ID)).toBeNull();
  });
});

describe("getSessionDetail includes the summary", () => {
  it("threads a stored summary through the detail shape", async () => {
    writeConfig(`sh -c 'echo "- key insight"'`);
    await summarizeSession(db, ID);
    const d = getSessionDetail(db, ID)!;
    expect(d.summary).not.toBeNull();
    expect(d.summary!.text).toContain("key insight");
  });

  it("is null when no summary exists", () => {
    const d = getSessionDetail(db, ID)!;
    expect(d.summary).toBeNull();
  });
});

describe("deleteSession cascades to summaries", () => {
  it("removes a session's summary when the session is deleted", async () => {
    writeConfig(`sh -c 'echo gone-soon'`);
    await summarizeSession(db, ID);
    expect(getSummary(db, ID)).not.toBeNull();
    deleteSession(db, ID);
    expect(getSummary(db, ID)).toBeNull();
  });
});
