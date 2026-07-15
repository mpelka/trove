import { describe, it, expect } from "bun:test";
import { parseQuery, highlightUnits } from "./query.ts";
import { buildMatch } from "./search.ts";

describe("parseQuery — terms", () => {
  it("splits unquoted words into terms, trailing term is a prefix candidate", () => {
    expect(parseQuery("quick brown")).toEqual({
      phrases: [],
      terms: ["quick", "brown"],
      prefixLast: true,
    });
  });

  it("trailing whitespace means the last word is finished — no prefix", () => {
    expect(parseQuery("quick brown ")).toEqual({
      phrases: [],
      terms: ["quick", "brown"],
      prefixLast: false,
    });
    expect(parseQuery("quick brown\t")).toMatchObject({ prefixLast: false });
    expect(parseQuery("quick brown\n")).toMatchObject({ prefixLast: false });
  });

  it("collapses runs of whitespace between terms", () => {
    expect(parseQuery("a1   b2\t\tc3").terms).toEqual(["a1", "b2", "c3"]);
  });

  it("handles empty and whitespace-only input", () => {
    for (const q of ["", " ", "   \t\n"]) {
      expect(parseQuery(q)).toEqual({ phrases: [], terms: [], prefixLast: false });
    }
  });

  it("keeps unicode terms intact", () => {
    expect(parseQuery("żółć naïve 日本語").terms).toEqual(["żółć", "naïve", "日本語"]);
  });
});

describe("parseQuery — stopwords", () => {
  it("strips stopwords from unquoted terms", () => {
    expect(parseQuery("pick the api").terms).toEqual(["pick", "api"]);
    expect(parseQuery("what is the state of the build ").terms).toEqual(["what", "state", "build"]);
  });

  it("stopword stripping is case-insensitive", () => {
    expect(parseQuery("The API ").terms).toEqual(["API"]);
  });

  it("exempts the trailing prefix-candidate term (may be a half-typed word)", () => {
    // "the" could be the start of "theme"/"theory" while the user is still typing
    expect(parseQuery("pick the")).toEqual({ phrases: [], terms: ["pick", "the"], prefixLast: true });
    // once the user types a space, it is a complete stopword — stripped
    expect(parseQuery("pick the ")).toEqual({ phrases: [], terms: ["pick"], prefixLast: false });
  });

  it("keeps the original terms when stripping would remove everything", () => {
    expect(parseQuery("to be or ")).toEqual({
      phrases: [],
      terms: ["to", "be", "or"],
      prefixLast: false,
    });
    expect(parseQuery("the ").terms).toEqual(["the"]);
  });

  it("does NOT fall back when a phrase survives", () => {
    const p = parseQuery('"socket hang up" the of ');
    expect(p.phrases).toEqual(["socket hang up"]);
    expect(p.terms).toEqual([]);
  });

  it("never strips stopwords inside quoted phrases", () => {
    expect(parseQuery('"the office"').phrases).toEqual(["the office"]);
    expect(parseQuery('"to be or not to be"').phrases).toEqual(["to be or not to be"]);
  });
});

describe("parseQuery — phrases", () => {
  it("extracts quoted phrases and mixes them with terms", () => {
    expect(parseQuery('err "socket hang up" retry')).toEqual({
      phrases: ["socket hang up"],
      terms: ["err", "retry"],
      prefixLast: true,
    });
  });

  it("a query ending in a closing quote gets no prefix", () => {
    expect(parseQuery('foo "bar baz"')).toEqual({
      phrases: ["bar baz"],
      terms: ["foo"],
      prefixLast: false,
    });
  });

  it("an unbalanced quote swallows everything to the end as one phrase, no prefix", () => {
    expect(parseQuery('foo "bar baz')).toEqual({
      phrases: ["bar baz"],
      terms: ["foo"],
      prefixLast: false,
    });
  });

  it("a quote glued to a word starts a phrase", () => {
    expect(parseQuery('foo"bar baz"')).toEqual({
      phrases: ["bar baz"],
      terms: ["foo"],
      prefixLast: false,
    });
  });

  it("trims and collapses whitespace inside phrases", () => {
    expect(parseQuery('"  a1   b2 "').phrases).toEqual(["a1 b2"]);
  });

  it("drops empty phrases", () => {
    expect(parseQuery('""')).toEqual({ phrases: [], terms: [], prefixLast: false });
    expect(parseQuery('"')).toEqual({ phrases: [], terms: [], prefixLast: false });
    expect(parseQuery('" " x')).toEqual({ phrases: [], terms: ["x"], prefixLast: true });
  });
});

describe("highlightUnits", () => {
  it("returns surviving terms only — stopwords excluded", () => {
    expect(highlightUnits("pick the api ")).toEqual(["pick", "api"]);
  });

  it("returns phrases as whole units, longest first", () => {
    expect(highlightUnits('err "socket hang up"')).toEqual(["socket hang up", "err"]);
  });

  it("dedupes repeated units", () => {
    expect(highlightUnits("foo foo bar ")).toEqual(["foo", "bar"]);
  });

  it("keeps all-stopword fallback terms so highlights match what was searched", () => {
    expect(highlightUnits("the ")).toEqual(["the"]);
  });
});

describe("buildMatch", () => {
  it("quotes every term; only the trailing prefix-candidate gets a star", () => {
    expect(buildMatch("quick brown", false)).toBe('"quick" "brown"*');
    expect(buildMatch("quick brown ", false)).toBe('"quick" "brown"');
    expect(buildMatch("quick", false)).toBe('"quick"*');
  });

  it("strips stopwords from unquoted terms", () => {
    expect(buildMatch("pick the api", false)).toBe('"pick" "api"*');
  });

  it("emits quoted phrases as FTS5 phrase queries", () => {
    expect(buildMatch('"quick brown" fox ', false)).toBe('"quick brown" "fox"');
    expect(buildMatch('"quick brown"', false)).toBe('"quick brown"');
  });

  it("adds the phrase-boost rewrite for purely-unquoted queries of 3+ words", () => {
    expect(buildMatch("alpha beta gamma ", false)).toBe(
      '("alpha beta gamma") OR ("alpha" "beta" "gamma")',
    );
    // mid-typing: the phrase branch carries the prefix star too ("phrase"* is valid FTS5)
    expect(buildMatch("alpha beta gamma", false)).toBe(
      '("alpha beta gamma"*) OR ("alpha" "beta" "gamma"*)',
    );
    // stopwords don't count toward the 3 ("the" is stripped first)
    expect(buildMatch("alpha the beta ", false)).toBe('"alpha" "beta"');
    // a quoted phrase anywhere disables the boost
    expect(buildMatch('"x y" alpha beta gamma ', false)).toBe('"x y" "alpha" "beta" "gamma"');
  });

  it("exact mode turns the whole query into one phrase, quotes doubled", () => {
    expect(buildMatch("quick brown", true)).toBe('"quick brown"');
    expect(buildMatch('say "hi" now', true)).toBe('"say ""hi"" now"');
  });

  it("returns the match-nothing phrase for empty/unsalvageable input", () => {
    expect(buildMatch("", false)).toBe('""');
    expect(buildMatch("   ", false)).toBe('""');
    expect(buildMatch('"', false)).toBe('""');
    expect(buildMatch('""', false)).toBe('""');
  });

  it("neutralizes hostile FTS5 syntax by quoting each unit", () => {
    expect(buildMatch("-foo", false)).toBe('"-foo"*');
    expect(buildMatch("NEAR(", false)).toBe('"NEAR("*');
    // 3 surviving terms → boost kicks in, but every unit stays quoted (NOT is inert)
    expect(buildMatch("a1 NOT b2 ", false)).toBe('("a1 NOT b2") OR ("a1" "NOT" "b2")');
    expect(buildMatch("a1 AND b2 ", false)).toBe('"a1" "b2"'); // "and" is also a stopword
    expect(buildMatch("col:val", false)).toBe('"col:val"*');
    expect(buildMatch("*", false)).toBe('"*"*');
    // phrases are emitted before terms — AND order is irrelevant to FTS5
    expect(buildMatch('x "unbalanced till end', false)).toBe('"unbalanced till end" "x"');
  });
});
