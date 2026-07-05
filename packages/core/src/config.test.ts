import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, summarizerCommand, configPath } from "./config.ts";

let dir: string;
const OLD_TROVE_DIR = process.env.TROVE_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trove-config-"));
  process.env.TROVE_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (OLD_TROVE_DIR === undefined) delete process.env.TROVE_DIR;
  else process.env.TROVE_DIR = OLD_TROVE_DIR;
});

describe("getConfig / summarizerCommand", () => {
  it("returns null when the config file is missing", () => {
    expect(getConfig()).toEqual({ summarizer: null });
    expect(summarizerCommand()).toBeNull();
  });

  it("reads the summarizer command when present", () => {
    writeFileSync(configPath(), JSON.stringify({ summarizer: "gemini -p 'go'" }));
    expect(summarizerCommand()).toBe("gemini -p 'go'");
  });

  it("treats a missing key as unavailable", () => {
    writeFileSync(configPath(), JSON.stringify({ other: 1 }));
    expect(summarizerCommand()).toBeNull();
  });

  it("treats an empty / whitespace summarizer as unavailable", () => {
    writeFileSync(configPath(), JSON.stringify({ summarizer: "   " }));
    expect(summarizerCommand()).toBeNull();
  });

  it("treats a non-string summarizer as unavailable", () => {
    writeFileSync(configPath(), JSON.stringify({ summarizer: 42 }));
    expect(summarizerCommand()).toBeNull();
  });

  it("warns and returns null on malformed JSON, never throwing", () => {
    writeFileSync(configPath(), "{ not valid json ");
    expect(() => getConfig()).not.toThrow();
    expect(summarizerCommand()).toBeNull();
  });
});
