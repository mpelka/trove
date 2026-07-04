import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "./db/client.ts";
import { resolveSessionId, setName, setStar, setHidden, setNotes, addTags, removeTags } from "./meta.ts";

let dir: string;
let db: Database;

function seedSession(id: string, nativeId: string) {
  db.query(
    `INSERT INTO sessions (id, agent, native_id, source_path, source_medium, content_hash, imported_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(id, id.split(":")[0], nativeId, `/src/${nativeId}`, "file", "h", Date.now());
}

const metaRow = (id: string) =>
  db.query("SELECT * FROM session_meta WHERE session_id = ?").get(id) as any;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trove-meta-"));
  db = openDb(join(dir, "meta.db"));
  seedSession("claude-code:aaaa1111-2222", "aaaa1111-2222");
  seedSession("claude-code:aaaa9999-8888", "aaaa9999-8888");
  seedSession("gemini-cli:session-bbbb", "session-bbbb");
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveSessionId", () => {
  it("resolves an exact id", () => {
    expect(resolveSessionId(db, "claude-code:aaaa1111-2222")).toEqual({
      kind: "ok",
      id: "claude-code:aaaa1111-2222",
    });
  });

  it("resolves a unique native-id prefix", () => {
    expect(resolveSessionId(db, "aaaa1111")).toEqual({ kind: "ok", id: "claude-code:aaaa1111-2222" });
    expect(resolveSessionId(db, "session-b")).toEqual({ kind: "ok", id: "gemini-cli:session-bbbb" });
  });

  it("resolves a unique full-id prefix", () => {
    expect(resolveSessionId(db, "gemini-cli:sess")).toEqual({ kind: "ok", id: "gemini-cli:session-bbbb" });
  });

  it("resolves the DISPLAYED short-id forms (they must round-trip into commands)", () => {
    expect(resolveSessionId(db, "cc·aaaa1111")).toEqual({
      kind: "ok",
      id: "claude-code:aaaa1111-2222",
    });
    expect(resolveSessionId(db, "cc:aaaa1111")).toEqual({
      kind: "ok",
      id: "claude-code:aaaa1111-2222",
    });
    // gemini short ids are the TRAILING hash of the session-… native id
    expect(resolveSessionId(db, "gem·bbbb")).toEqual({ kind: "ok", id: "gemini-cli:session-bbbb" });
  });

  it("reports ambiguity with the candidate ids", () => {
    const r = resolveSessionId(db, "aaaa");
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(new Set(r.matches)).toEqual(
        new Set(["claude-code:aaaa1111-2222", "claude-code:aaaa9999-8888"]),
      );
    }
  });

  it("reports none for no match", () => {
    expect(resolveSessionId(db, "zzzz")).toEqual({ kind: "none" });
  });
});

describe("tags", () => {
  it("addTags dedupes, trims and sorts", () => {
    expect(addTags(db, "claude-code:aaaa1111-2222", ["zeta", " alpha ", "zeta", "", "  "])).toEqual([
      "alpha",
      "zeta",
    ]);
    // adding again is idempotent and merges sorted
    expect(addTags(db, "claude-code:aaaa1111-2222", ["mid"])).toEqual(["alpha", "mid", "zeta"]);
    expect(JSON.parse(metaRow("claude-code:aaaa1111-2222").tags)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("removeTags removes only the named tags (trimmed)", () => {
    addTags(db, "claude-code:aaaa1111-2222", ["a", "b", "c"]);
    expect(removeTags(db, "claude-code:aaaa1111-2222", [" b ", "nope"])).toEqual(["a", "c"]);
    expect(removeTags(db, "claude-code:aaaa1111-2222", ["a", "c"])).toEqual([]);
  });

  it("removeTags on a session with no tags yields []", () => {
    expect(removeTags(db, "gemini-cli:session-bbbb", ["x"])).toEqual([]);
  });
});

describe("setName / setStar / setHidden / setNotes", () => {
  const id = "claude-code:aaaa1111-2222";

  it("creates the meta row on demand and round-trips values", () => {
    setName(db, id, "renamed");
    setStar(db, id, true);
    setHidden(db, id, true);
    setNotes(db, id, "some notes");
    const m = metaRow(id);
    expect(m.custom_name).toBe("renamed");
    expect(m.starred).toBe(1);
    expect(m.hidden).toBe(1);
    expect(m.notes).toBe("some notes");
  });

  it("clears values back to defaults", () => {
    setName(db, id, "renamed");
    setStar(db, id, true);
    setName(db, id, null);
    setStar(db, id, false);
    setHidden(db, id, false);
    setNotes(db, id, null);
    const m = metaRow(id);
    expect(m.custom_name).toBeNull();
    expect(m.starred).toBe(0);
    expect(m.hidden).toBe(0);
    expect(m.notes).toBeNull();
  });
});
