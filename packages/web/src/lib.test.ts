import { describe, it, expect } from "bun:test";
import {
  fmtRel,
  fmtSize,
  agentClass,
  agentLabel,
  projLabel,
  shortId,
  escapeRegExp,
  rehypeHighlight,
  rehypeHighlightExact,
  parseUsed,
  summarizeTools,
  buildItems,
} from "./lib.ts";

describe("fmtRel", () => {
  const ago = (ms: number) => Date.now() - ms;
  it("handles null/undefined", () => {
    expect(fmtRel(null)).toBe("—");
    expect(fmtRel(undefined)).toBe("—");
  });
  it("formats each magnitude bucket", () => {
    expect(fmtRel(ago(5_000))).toBe("5s");
    expect(fmtRel(ago(90_000))).toBe("1m");
    expect(fmtRel(ago(2 * 3_600_000))).toBe("2h");
    expect(fmtRel(ago(3 * 86_400_000))).toBe("3d");
    expect(fmtRel(ago(45 * 86_400_000))).toBe("1mo");
    expect(fmtRel(ago(400 * 86_400_000))).toBe("1y");
  });
});

describe("fmtSize", () => {
  it("handles null and byte/K/M boundaries", () => {
    expect(fmtSize(null)).toBe("?");
    expect(fmtSize(undefined)).toBe("?");
    expect(fmtSize(0)).toBe("0B");
    expect(fmtSize(1023)).toBe("1023B");
    expect(fmtSize(1024)).toBe("1K");
    expect(fmtSize(1536)).toBe("2K"); // Math.round
    expect(fmtSize(1048575)).toBe("1024K");
    expect(fmtSize(1048576)).toBe("1.0M");
    expect(fmtSize(1572864)).toBe("1.5M");
  });
});

describe("agentClass / agentLabel", () => {
  it("maps known agents and falls back for unknown", () => {
    expect(agentClass("claude-code")).toBe("cc");
    expect(agentClass("gemini-cli")).toBe("gemini");
    expect(agentClass("copilot")).toBe("copilot");
    expect(agentClass("antigravity")).toBe("agy");
    expect(agentClass("codex")).toBe(""); // unknown → no class
    expect(agentLabel("claude-code")).toBe("CC");
    expect(agentLabel("gemini-cli")).toBe("GEM");
    expect(agentLabel("copilot")).toBe("COP");
    expect(agentLabel("antigravity")).toBe("AGY");
    expect(agentLabel("codex")).toBe("codex"); // unknown → passthrough
  });
});

describe("projLabel", () => {
  it("returns the last path segment", () => {
    expect(projLabel("/Users/x/Sites/trove")).toBe("trove");
    expect(projLabel("/Users/x/Sites/trove/")).toBe("trove"); // trailing slash
    expect(projLabel(null)).toBe("no project");
    expect(projLabel("")).toBe("no project");
    expect(projLabel("/")).toBe("/"); // no segments → falls back to input
  });
});

describe("shortId", () => {
  // Separator is a typeable ":" (the old "·" wasn't on a keyboard); resolvers accept both.
  it("shortens claude-code uuids", () => {
    expect(shortId("claude-code:7de4a1b2-0f0f-4e4e-8a8a-123456789abc")).toBe("cc:7de4a1b2");
  });
  it("uses the trailing token of gemini session-… native ids", () => {
    expect(shortId("gemini-cli:session-2025-06-01T10-00-abcd1234")).toBe("gem:abcd1234");
  });
  it("abbreviates copilot/antigravity", () => {
    expect(shortId("copilot:deadbeefcafe1234")).toBe("cop:deadbeef");
    expect(shortId("antigravity:0123456789abcdef")).toBe("agy:01234567");
  });
  it("keeps unknown agents and handles ids without a namespace", () => {
    expect(shortId("codex:deadbeefcafe1234")).toBe("codex:deadbeef");
    expect(shortId("deadbeefcafe1234")).toBe(":deadbeef");
  });
});

describe("escapeRegExp", () => {
  it("escapes all regex metacharacters", () => {
    const s = "a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o";
    const re = new RegExp(`^${escapeRegExp(s)}$`);
    expect(re.test(s)).toBe(true);
    expect(re.test("aXb*c+d?e^f$g{h}i(j)k|l[m]n\\o")).toBe(false);
  });
});

describe("rehypeHighlight", () => {
  const text = (value: string) => ({ type: "text", value });
  const el = (tagName: string, children: any[]) => ({ type: "element", tagName, children });
  const tree = (...children: any[]) => ({ type: "root", children });

  it("wraps matching terms in <mark> nodes, case-insensitively", () => {
    const t = tree(el("p", [text("The Fox ran far")]));
    rehypeHighlight("fox")()(t);
    const p = t.children[0] as any;
    expect(p.children.map((c: any) => c.type)).toEqual(["text", "element", "text"]);
    expect(p.children[0].value).toBe("The ");
    expect(p.children[1].tagName).toBe("mark");
    expect(p.children[1].children[0].value).toBe("Fox");
    expect(p.children[2].value).toBe(" ran far");
  });

  it("highlights any of multiple terms and recurses into nested elements", () => {
    const t = tree(el("p", [el("strong", [text("quick fox")]), text(" and dog")]));
    rehypeHighlight("fox dog")()(t);
    const strong = (t.children[0] as any).children[0];
    expect(strong.children.some((c: any) => c.tagName === "mark")).toBe(true);
    const pTexts = (t.children[0] as any).children;
    expect(pTexts.some((c: any) => c.tagName === "mark")).toBe(true);
  });

  it("does nothing for an empty query and treats terms literally", () => {
    const t = tree(el("p", [text("untouched")]));
    rehypeHighlight("   ")()(t);
    expect((t.children[0] as any).children).toEqual([text("untouched")]);

    const t2 = tree(el("p", [text("a.c abc")]));
    rehypeHighlight("a.c")()(t2); // "." must not act as a wildcard
    const marks = (t2.children[0] as any).children.filter((c: any) => c.tagName === "mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].children[0].value).toBe("a.c");
  });

  it("does not highlight stopwords — 'pick the api' only marks pick/api", () => {
    const t = tree(el("p", [text("the theme has an api you pick")]));
    rehypeHighlight("pick the api ")()(t);
    const marks = (t.children[0] as any).children.filter((c: any) => c.tagName === "mark");
    expect(marks.map((m: any) => m.children[0].value)).toEqual(["api", "pick"]);
    // neither "the" nor "theme" got wrapped
    const texts = (t.children[0] as any).children.filter((c: any) => c.type === "text");
    expect(texts.some((c: any) => c.value.includes("the theme"))).toBe(true);
  });

  it("highlights a quoted phrase as one unit", () => {
    const t = tree(el("p", [text("a socket hang up error, not socket alone")]));
    rehypeHighlight('"socket hang up"')()(t);
    const marks = (t.children[0] as any).children.filter((c: any) => c.tagName === "mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].children[0].value).toBe("socket hang up");
  });

  it("phrase wins over an overlapping single term (longest-first alternation)", () => {
    const t = tree(el("p", [text("socket hang up now")]));
    rehypeHighlight('now "socket hang up"')()(t);
    const marks = (t.children[0] as any).children.filter((c: any) => c.tagName === "mark");
    expect(marks.map((m: any) => m.children[0].value)).toEqual(["socket hang up", "now"]);
  });

  it("still highlights an all-stopword fallback query", () => {
    const t = tree(el("p", [text("the cat")]));
    rehypeHighlight("the ")()(t);
    const marks = (t.children[0] as any).children.filter((c: any) => c.tagName === "mark");
    expect(marks.map((m: any) => m.children[0].value)).toEqual(["the"]);
  });
});

describe("rehypeHighlightExact", () => {
  const text = (value: string) => ({ type: "text", value });
  const el = (tagName: string, children: any[]) => ({ type: "element", tagName, children });
  const tree = (...children: any[]) => ({ type: "root", children });

  it("wraps an exact case-sensitive match in <mark class=hl> with the highlight id", () => {
    const t = tree(el("p", [text("keep this passage here")]));
    rehypeHighlightExact([{ id: 7, text: "this passage" }])()(t);
    const p = t.children[0] as any;
    expect(p.children.map((c: any) => c.type)).toEqual(["text", "element", "text"]);
    const mark = p.children[1];
    expect(mark.tagName).toBe("mark");
    expect(mark.properties.className).toEqual(["hl"]);
    expect(mark.properties["data-hl-id"]).toBe("7");
    expect(mark.children[0].value).toBe("this passage");
  });

  it("is case-sensitive and marks each highlight at most once", () => {
    const t = tree(el("p", [text("Fox fox fox")]));
    rehypeHighlightExact([{ id: 1, text: "fox" }])()(t);
    const marks = (t.children[0] as any).children.filter((c: any) => c.tagName === "mark");
    expect(marks).toHaveLength(1); // only the first lowercase "fox", once
    expect(marks[0].children[0].value).toBe("fox");
  });

  it("does not mark when the phrase is split across nodes (fallback territory)", () => {
    // "bold word" is split: <strong>bold</strong> " word" — no single node contains it
    const t = tree(el("p", [el("strong", [text("bold")]), text(" word tail")]));
    rehypeHighlightExact([{ id: 2, text: "bold word" }])()(t);
    const flat = JSON.stringify(t);
    expect(flat).not.toContain('"mark"');
  });
});

describe("parseUsed", () => {
  it("parses tool markers into names", () => {
    expect(parseUsed("[used: Bash, Read]")).toEqual(["Bash", "Read"]);
    expect(parseUsed("[used: Bash]")).toEqual(["Bash"]);
    expect(parseUsed("[used: Bash, , Read ]")).toEqual(["Bash", "Read"]);
  });
  it("returns non-marker text as-is", () => {
    expect(parseUsed("plain message")).toEqual(["plain message"]);
    expect(parseUsed("[used: Bash] trailing")).toEqual(["[used: Bash] trailing"]);
  });
});

describe("summarizeTools", () => {
  it("formats counts with the 2×Name convention", () => {
    const counts = new Map([
      ["Bash", 2],
      ["Read", 1],
      ["Edit", 3],
    ]);
    expect(summarizeTools(counts)).toBe("[used: 2×Bash, Read, 3×Edit]");
    expect(summarizeTools(new Map())).toBe("[used: ]");
  });
});

describe("buildItems", () => {
  const m = (id: number, role: string, text: string, timestamp: number | null = null) => ({
    id,
    role,
    text,
    timestamp,
  });

  it("passes plain messages through", () => {
    const items = buildItems([m(1, "user", "hi", 10), m(2, "assistant", "hello", 20)]);
    expect(items).toEqual([
      { kind: "msg", id: 1, uid: null, seq: 0, role: "user", text: "hi", ts: 10, calls: [] },
      { kind: "msg", id: 2, uid: null, seq: 0, role: "assistant", text: "hello", ts: 20, calls: [] },
    ]);
  });

  it("attaches tool_calls to a non-tool message (gemini agentic turns)", () => {
    const items = buildItems([
      {
        id: 1,
        role: "assistant",
        text: "",
        timestamp: 5,
        tool_calls: JSON.stringify([{ name: "Shell", input: "ls -la" }]),
      },
    ]);
    expect(items).toEqual([
      { kind: "msg", id: 1, uid: null, seq: 0, role: "assistant", text: "", ts: 5, calls: [{ name: "Shell", input: "ls -la" }] },
    ]);
  });

  it("collapses consecutive tool runs, accumulating counts and keeping the first id", () => {
    const items = buildItems([
      m(1, "user", "go", 1),
      m(2, "tool", "[used: Bash]", 2),
      m(3, "tool", "[used: Bash, Read]", 3),
      m(4, "assistant", "done", 4),
      m(5, "tool", "[used: Edit]", 5),
    ]);
    expect(items).toHaveLength(4);
    const g1 = items[1];
    expect(g1.kind).toBe("tools");
    if (g1.kind === "tools") {
      expect(g1.id).toBe(2); // first message of the run
      expect(g1.ts).toBe(3); // last message's timestamp
      expect(Object.fromEntries(g1.counts)).toEqual({ Bash: 2, Read: 1 });
    }
    const g2 = items[3];
    if (g2.kind === "tools") {
      expect(g2.id).toBe(5);
      expect(Object.fromEntries(g2.counts)).toEqual({ Edit: 1 });
    }
    // interleaving message breaks the run
    expect(items[2]).toEqual({ kind: "msg", id: 4, uid: null, seq: 0, role: "assistant", text: "done", ts: 4, calls: [] });
  });

  it("round-trips a collapsed run through summarizeTools", () => {
    const items = buildItems([m(1, "tool", "[used: Bash]"), m(2, "tool", "[used: Bash]")]);
    expect(items).toHaveLength(1);
    if (items[0].kind === "tools") expect(summarizeTools(items[0].counts)).toBe("[used: 2×Bash]");
  });
});
