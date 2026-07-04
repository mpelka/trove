import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Smoke test only: `--help` must print usage and exit 0 without touching any real
// data dir (TROVE_* env pinned to throwaway paths just in case).
describe("trove CLI", () => {
  it("--help exits 0 and prints the program name", () => {
    const dir = mkdtempSync(join(tmpdir(), "trove-cli-"));
    try {
      const proc = Bun.spawnSync(["bun", join(import.meta.dir, "index.ts"), "--help"], {
        env: {
          ...process.env,
          TROVE_DIR: join(dir, "trove"),
          TROVE_CC_ROOT: join(dir, "cc"),
          TROVE_GEMINI_ROOT: join(dir, "gem"),
        },
      });
      expect(proc.exitCode).toBe(0);
      const out = proc.stdout.toString();
      expect(out).toContain("trove");
      expect(out).toContain("Usage");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
