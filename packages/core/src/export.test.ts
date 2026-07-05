import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "./db/client.ts";
import { exportSession } from "./export.ts";
import { addHighlight } from "./highlights.ts";

let dir: string;
let db: Database;
const OLD_TROVE_DIR = process.env.TROVE_DIR;

const ID = "claude-code:exp";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "trove-export-"));
  process.env.TROVE_DIR = dir;
  db = openDb(join(dir, "trove.db"));

  db.query(
    `INSERT INTO sessions (id, agent, native_id, source_path, source_medium, project_path,
       created_at, updated_at, model, source_title, content_hash, imported_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    ID,
    "claude-code",
    "exp",
    "/src/exp.jsonl",
    "file",
    "/Users/x/proj",
    Date.parse("2025-06-01T10:00:00.000Z"),
    Date.parse("2025-06-01T11:00:00.000Z"),
    "claude-opus-4",
    "Export test",
    "h",
    Date.now(),
  );
  const im = db.query(
    "INSERT INTO messages (session_id, seq, role, uid, parent_uid, timestamp, text) VALUES (?,?,?,?,?,?,?)",
  );
  im.run(ID, 0, "user", "m0", null, 1000, "please **refactor** the widget");
  im.run(ID, 1, "assistant", "m1", "m0", 2000, "Done. Here is the diff.");
  im.run(ID, 2, "tool", "m2", "m1", 3000, "[used: Read, Edit]");
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  if (OLD_TROVE_DIR === undefined) delete process.env.TROVE_DIR;
  else process.env.TROVE_DIR = OLD_TROVE_DIR;
});

describe("exportSession md", () => {
  it("renders a header, metadata block, and role sections with verbatim text", () => {
    const md = exportSession(db, ID, "md")!;
    expect(md).toContain("# Export test");
    expect(md).toContain("| agent | claude-code |");
    expect(md).toContain("| project | /Users/x/proj |");
    expect(md).toContain("| model | claude-opus-4 |");
    expect(md).toContain(`| id | ${ID} |`);
    expect(md).toContain("## You");
    expect(md).toContain("## Assistant");
    // markdown in message text is preserved verbatim
    expect(md).toContain("please **refactor** the widget");
    // tool marker rendered as a blockquote
    expect(md).toContain("> [used: Read, Edit]");
    // "You" precedes "Assistant" in output order
    expect(md.indexOf("## You")).toBeLessThan(md.indexOf("## Assistant"));
  });

  it("returns null for an unknown id", () => {
    expect(exportSession(db, "nope:missing", "md")).toBeNull();
  });

  it("appends a ## Highlights section when the session has highlights", () => {
    expect(exportSession(db, ID, "md")!).not.toContain("## Highlights"); // none yet
    addHighlight(db, { sessionId: ID, messageUid: "m0", messageSeq: 0, text: "refactor the widget", note: "key idea" });
    const md = exportSession(db, ID, "md")!;
    expect(md).toContain("## Highlights");
    expect(md).toContain("> refactor the widget");
    expect(md).toContain("— key idea");
    // the section comes after the transcript
    expect(md.indexOf("## Assistant")).toBeLessThan(md.indexOf("## Highlights"));
  });
});

describe("exportSession json", () => {
  it("returns { session, messages } as parseable JSON", () => {
    const json = exportSession(db, ID, "json")!;
    const parsed = JSON.parse(json);
    expect(parsed.session.id).toBe(ID);
    expect(parsed.session.name).toBe("Export test");
    expect(parsed.messages.map((m: { text: string }) => m.text)).toEqual([
      "please **refactor** the widget",
      "Done. Here is the diff.",
      "[used: Read, Edit]",
    ]);
  });
});
