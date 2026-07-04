import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "./repo.ts";

let repo: string;
let nonRepo: string;

beforeAll(() => {
  // realpath: macOS /tmp is a symlink; `git rev-parse` returns the resolved path.
  repo = realpathSync(mkdtempSync(join(tmpdir(), "trove-repo-")));
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  nonRepo = realpathSync(mkdtempSync(join(tmpdir(), "trove-norepo-")));
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(nonRepo, { recursive: true, force: true });
});

describe("repoRoot", () => {
  it("returns the git toplevel from anywhere inside the repo", () => {
    expect(repoRoot(repo)).toBe(repo);
  });

  it("falls back to the given dir when git can't resolve a toplevel", () => {
    // A path that doesn't exist → `git rev-parse` fails → we return the dir verbatim.
    const missing = join(nonRepo, "does-not-exist");
    expect(repoRoot(missing)).toBe(missing);
  });
});
