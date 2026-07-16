import { describe, it, expect } from "bun:test";
import {
  visibleAgentChips,
  parseHiddenAgents,
  serializeHiddenAgents,
  type AgentSessionCount,
} from "./chip-visibility.ts";

const KNOWN = ["claude-code", "gemini-cli", "copilot", "antigravity", "chatgpt", "claude-web"] as const;

const counts = (o: Record<string, number>): AgentSessionCount[] =>
  Object.entries(o).map(([agent, sessions]) => ({ agent, sessions }));

const vis = (over: Partial<Parameters<typeof visibleAgentChips>[0]> = {}) =>
  visibleAgentChips({
    known: KNOWN,
    counts: counts({ "claude-code": 12, "gemini-cli": 3 }),
    hidden: new Set(),
    active: null,
    ...over,
  });

describe("visibleAgentChips", () => {
  it("auto-hides agents with zero or missing session counts", () => {
    expect(vis()).toEqual(["claude-code", "gemini-cli"]);
    // explicit zero counts as absent
    expect(vis({ counts: counts({ "claude-code": 5, copilot: 0 }) })).toEqual(["claude-code"]);
  });

  it("fresh empty store shows no agent chips at all", () => {
    expect(vis({ counts: [] })).toEqual([]);
  });

  it("loading (undefined counts) auto-hides nothing — the set only shrinks later", () => {
    expect(vis({ counts: undefined })).toEqual([...KNOWN]);
    // manual hides still apply while loading
    expect(vis({ counts: undefined, hidden: new Set(["chatgpt"]) })).toEqual(
      KNOWN.filter((a) => a !== "chatgpt"),
    );
  });

  it("manual hides drop chips even when sessions exist", () => {
    expect(vis({ hidden: new Set(["gemini-cli"]) })).toEqual(["claude-code"]);
    expect(vis({ hidden: new Set(["claude-code", "gemini-cli"]) })).toEqual([]);
  });

  it("the ACTIVE agent's chip always shows — manual hide, zero count, or empty store", () => {
    // manually hidden but active (toggle flipped elsewhere / restored from storage)
    expect(vis({ hidden: new Set(["gemini-cli"]), active: "gemini-cli" })).toEqual([
      "claude-code",
      "gemini-cli",
    ]);
    // deep link to an agent with no sessions on this machine
    expect(vis({ active: "copilot" })).toEqual(["claude-code", "gemini-cli", "copilot"]);
    // deep link into a fresh empty store
    expect(vis({ counts: [], active: "chatgpt" })).toEqual(["chatgpt"]);
  });

  it("active = null (all) adds nothing", () => {
    expect(vis({ active: null })).toEqual(["claude-code", "gemini-cli"]);
  });

  it("preserves canonical `known` order regardless of counts order", () => {
    const shuffled = counts({ "claude-web": 1, "claude-code": 1, chatgpt: 9 });
    expect(vis({ counts: shuffled })).toEqual(["claude-code", "chatgpt", "claude-web"]);
  });

  it("ignores agents in the store that have no chip (unknown ids)", () => {
    expect(vis({ counts: counts({ "mystery-agent": 40, "gemini-cli": 1 }) })).toEqual(["gemini-cli"]);
    // an unknown ACTIVE agent (hand-edited URL) still gets no chip — nothing to render it as
    expect(vis({ active: "mystery-agent" })).toEqual(["claude-code", "gemini-cli"]);
  });
});

describe("hidden-agents localStorage round-trip", () => {
  it("serialize → parse is lossless", () => {
    const set = new Set(["copilot", "chatgpt"]);
    expect(parseHiddenAgents(serializeHiddenAgents(set))).toEqual(set);
    expect(parseHiddenAgents(serializeHiddenAgents(new Set()))).toEqual(new Set());
  });

  it("serializes deterministically (sorted)", () => {
    expect(serializeHiddenAgents(new Set(["b", "a"]))).toBe(serializeHiddenAgents(new Set(["a", "b"])));
  });

  it("fails open on missing or malformed storage — never hides by accident", () => {
    expect(parseHiddenAgents(null)).toEqual(new Set());
    expect(parseHiddenAgents("")).toEqual(new Set());
    expect(parseHiddenAgents("not json {")).toEqual(new Set());
    expect(parseHiddenAgents('"a string"')).toEqual(new Set());
    expect(parseHiddenAgents('{"copilot":true}')).toEqual(new Set());
    // non-string junk inside an array is dropped, strings survive
    expect(parseHiddenAgents('["copilot", 3, null, {"x":1}]')).toEqual(new Set(["copilot"]));
  });
});
