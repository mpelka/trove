import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { antigravityAdapter } from "./antigravity.ts";
import type { SourceRef } from "./types.ts";

let root: string;
const OLD_ROOT = process.env.TROVE_AGY_ROOT;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "trove-agy-"));
  process.env.TROVE_AGY_ROOT = root;
  mkdirSync(join(root, "conversations"), { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (OLD_ROOT === undefined) delete process.env.TROVE_AGY_ROOT;
  else process.env.TROVE_AGY_ROOT = OLD_ROOT;
});

// ---------------------------------------------------------------------------
// Tiny protobuf wire encoder — builds fixture blobs with the REAL field layout
// probed from live conversation DBs (see antigravity.ts header).
// ---------------------------------------------------------------------------

function varint(n: bigint | number): Uint8Array {
  let v = BigInt(n);
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return Uint8Array.from(out);
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
/** length-delimited field (wire type 2): nested message or string */
function fLen(fieldNo: number, body: Uint8Array | string): Uint8Array {
  const b = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return concat(varint((fieldNo << 3) | 2), varint(b.length), b);
}
/** varint field (wire type 0) */
function fVar(fieldNo: number, value: bigint | number): Uint8Array {
  return concat(varint(fieldNo << 3), varint(value));
}
/** step metadata: field 1 = google.protobuf.Timestamp { 1: sec, 2: nanos } */
function metaWithTs(epochMs: number): Uint8Array {
  const sec = Math.floor(epochMs / 1000);
  const nanos = (epochMs % 1000) * 1e6;
  return fLen(1, concat(fVar(1, sec), fVar(2, nanos)));
}

const T0 = Date.parse("2026-06-10T08:00:00.000Z");
const T1 = Date.parse("2026-06-10T08:00:05.000Z");
const T2 = Date.parse("2026-06-10T08:00:09.000Z");
const T3 = Date.parse("2026-06-10T08:01:00.000Z");

/** Build one conversation DB with the real schema + protobuf-encoded steps. */
function makeConversation(name: string, opts?: { workspace?: string; noSteps?: boolean }): string {
  const path = join(root, "conversations", `${name}.db`);
  const db = new Database(path);
  db.run(
    "CREATE TABLE `steps` (`idx` integer,`step_type` integer NOT NULL DEFAULT 0,`status` integer NOT NULL DEFAULT 0,`has_subtrajectory` numeric NOT NULL DEFAULT false,`metadata` blob,`error_details` blob,`permissions` blob,`task_details` blob,`render_info` blob,`step_payload` blob,`step_format` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))",
  );
  db.run(
    "CREATE TABLE `trajectory_meta` (`trajectory_id` text,`cascade_id` text,`trajectory_type` integer,`source` integer,PRIMARY KEY (`trajectory_id`))",
  );
  db.run(
    'CREATE TABLE `trajectory_metadata_blob` (`id` text DEFAULT "main",`data` blob,PRIMARY KEY (`id`))',
  );
  db.run("CREATE TABLE `parent_references` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))");

  db.query("INSERT INTO trajectory_meta VALUES (?,?,?,?)").run(`traj-${name}`, name, 4, 17);
  if (opts?.workspace) {
    // main blob: field 1 → { field 1: "file://…" }
    db.query("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)").run(
      fLen(1, fLen(1, opts.workspace)),
    );
  }

  if (!opts?.noSteps) {
    const ins = db.query(
      "INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?,?,?,?,?)",
    );
    // user message: type 14, payload field 19 → { 2: text, 3: {…dup, ignored} }
    ins.run(
      0,
      14,
      3,
      metaWithTs(T0),
      concat(fVar(1, 14), fLen(19, concat(fLen(2, "Hello agy, build the thing"), fLen(3, fLen(1, "DUPLICATE"))))),
    );
    // tool step: type 8, payload field 5 → { 30: title, 31: status line }
    ins.run(
      1,
      8,
      3,
      metaWithTs(T1),
      concat(fVar(1, 8), fLen(5, concat(fLen(30, "View SKILL.md"), fLen(31, "Viewing skill guide")))),
    );
    // assistant thinking-only step: type 15, payload 20 → { 3: thinking, 6: bot id } → skipped
    ins.run(
      2,
      15,
      3,
      metaWithTs(T2),
      concat(fVar(1, 15), fLen(20, concat(fLen(3, "SECRET AGY THINKING"), fLen(6, "bot-123")))),
    );
    // assistant visible message: type 15, payload 20 → { 1: text, 3: thinking }
    ins.run(
      3,
      15,
      3,
      metaWithTs(T3),
      concat(
        fVar(1, 15),
        fLen(20, concat(fLen(1, "Done — wrote template.ts"), fLen(3, "MORE SECRET THINKING"), fLen(6, "bot-456"))),
      ),
    );
    // binary/undecodable payload → silently skipped
    ins.run(4, 98, 3, null, Uint8Array.from([0xff, 0xff, 0xff, 0x01, 0x02]));
  }
  db.close();
  return path;
}

function refFor(path: string, refs: SourceRef[]): SourceRef {
  const r = refs.find((x) => x.path === path);
  if (!r) throw new Error(`no ref for ${path}`);
  return r;
}

describe("antigravityAdapter.parse", () => {
  it("decodes user/assistant text and tool markers from protobuf steps", async () => {
    const path = makeConversation("conv-main", {
      workspace: "file:///Users/x/agyproj",
    });
    const refs = await antigravityAdapter.enumerate();
    const parsed = await antigravityAdapter.parse(refFor(path, refs));
    expect(parsed).not.toBeNull();
    const s = parsed!.session;

    expect(s.nativeId).toBe("conv-main"); // filename stem == cascade_id
    expect(s.agentSpecific?.trajectoryId).toBe("traj-conv-main");
    expect(s.agentSpecific?.cascadeId).toBe("conv-main");
    expect(s.projectPath).toBe("/Users/x/agyproj"); // decoded from file:// URI

    expect(s.messages.map((m) => m.role)).toEqual(["user", "tool", "assistant"]);
    expect(s.messages.map((m) => m.uid)).toEqual(["step-0", "step-1", "step-3"]);
    expect(s.messages[0]!.text).toBe("Hello agy, build the thing");
    expect(s.messages[1]!.text).toBe("[used: View SKILL.md]");
    expect(s.messages[2]!.text).toBe("Done — wrote template.ts");

    const all = s.messages.map((m) => m.text).join("\n");
    expect(all).not.toContain("SECRET AGY THINKING"); // reasoning dropped
    expect(all).not.toContain("MORE SECRET THINKING");
    expect(all).not.toContain("bot-"); // internal ids dropped
    expect(all).not.toContain("DUPLICATE");

    // per-step timestamps from the metadata Timestamp; session span covers all steps
    expect(s.messages[0]!.timestamp).toBe(T0);
    expect(s.messages[2]!.timestamp).toBe(T3);
    expect(s.createdAt).toBe(T0);
    expect(s.updatedAt).toBe(T3);

    // raw: JSON of the raw step rows (blobs base64) — faithful + deterministic
    const raw = JSON.parse(new TextDecoder().decode(parsed!.raw!));
    expect(raw.steps.length).toBe(5);
    expect(raw.trajectoryMeta.cascade_id).toBe("conv-main");
    const again = await antigravityAdapter.parse(refFor(path, refs));
    expect(again!.contentHash).toBe(parsed!.contentHash);
  });

  it("yields an empty message list for a stepless conversation (sync counts it trivial)", async () => {
    const path = makeConversation("conv-empty", { noSteps: true });
    const refs = await antigravityAdapter.enumerate();
    const parsed = await antigravityAdapter.parse(refFor(path, refs));
    expect(parsed).not.toBeNull();
    expect(parsed!.session.messages).toEqual([]);
    expect(parsed!.session.projectPath).toBeNull();
  });

  it("returns null for a corrupt or non-agy DB", async () => {
    const bad = join(root, "conversations", "corrupt.db");
    writeFileSync(bad, "not a sqlite file at all");
    const ref: SourceRef = {
      agent: "antigravity",
      medium: "sqlite",
      path: bad,
      sizeBytes: 10,
      mtimeMs: 0,
    };
    expect(await antigravityAdapter.parse(ref)).toBeNull();

    // valid sqlite, wrong schema
    const wrong = join(root, "conversations", "wrong-schema.db");
    const db = new Database(wrong);
    db.run("CREATE TABLE other (x)");
    db.close();
    expect(
      await antigravityAdapter.parse({ ...ref, path: wrong }),
    ).toBeNull();
    rmSync(bad, { force: true });
    rmSync(wrong, { force: true });
  });
});

describe("antigravityAdapter.enumerate", () => {
  it("finds only conversations/*.db, skipping -wal/-shm sidecars", async () => {
    const enumRoot = mkdtempSync(join(tmpdir(), "trove-agy-enum-"));
    const prev = process.env.TROVE_AGY_ROOT;
    try {
      process.env.TROVE_AGY_ROOT = enumRoot;
      const dir = join(enumRoot, "conversations");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "abc.db"), "x");
      writeFileSync(join(dir, "abc.db-wal"), "wal");
      writeFileSync(join(dir, "abc.db-shm"), "shm");
      writeFileSync(join(dir, "notes.txt"), "not a db");

      const refs = await antigravityAdapter.enumerate();
      expect(refs.length).toBe(1);
      expect(refs[0]!.path).toBe(join(dir, "abc.db"));
      expect(refs[0]!.agent).toBe("antigravity");
      expect(refs[0]!.medium).toBe("sqlite");
      expect(refs[0]!.dbRowId).toBe("abc");
      // WAL sidecar folded into the fingerprint
      expect(refs[0]!.sizeBytes).toBe(1 + 3);
    } finally {
      process.env.TROVE_AGY_ROOT = prev;
      rmSync(enumRoot, { recursive: true, force: true });
    }
  });

  it("fingerprint moves when unflushed steps land in the -wal sidecar", async () => {
    const enumRoot = mkdtempSync(join(tmpdir(), "trove-agy-wal-"));
    const prev = process.env.TROVE_AGY_ROOT;
    try {
      process.env.TROVE_AGY_ROOT = enumRoot;
      const dir = join(enumRoot, "conversations");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "grow.db"), "dbfile");
      writeFileSync(join(dir, "grow.db-wal"), "wal0");
      const before = (await antigravityAdapter.enumerate())[0]!;
      appendFileSync(join(dir, "grow.db-wal"), "-more-frames");
      const after = (await antigravityAdapter.enumerate())[0]!;
      expect(after.sizeBytes).toBeGreaterThan(before.sizeBytes);
    } finally {
      process.env.TROVE_AGY_ROOT = prev;
      rmSync(enumRoot, { recursive: true, force: true });
    }
  });

  it("returns [] when the conversations dir does not exist", async () => {
    const prev = process.env.TROVE_AGY_ROOT;
    try {
      process.env.TROVE_AGY_ROOT = join(tmpdir(), "trove-agy-definitely-missing");
      expect(await antigravityAdapter.enumerate()).toEqual([]);
    } finally {
      process.env.TROVE_AGY_ROOT = prev;
    }
  });
});

describe("antigravityAdapter.buildResumeCommand", () => {
  it("is unsupported (returns null)", () => {
    expect(antigravityAdapter.buildResumeCommand!({ nativeId: "conv-x" })).toBeNull();
  });
});
