// Search-query parsing — Slack/GitHub-style semantics, shared by the FTS5 MATCH
// builder (search.ts) and the web reader's highlighter. Browser-safe: no bun:sqlite,
// no node imports (exported via the "@trove/core/query" subpath for the web bundle).
//
// Grammar (whitespace-tokenized, `"` toggles phrase mode):
//   query  := (phrase | term)*
//   phrase := '"' <anything up to the next '"' — or end of input if unbalanced> '"'
//   term   := run of non-space, non-quote characters
// Semantics:
//   - phrases match as FTS5 phrases; stopwords are NEVER stripped inside them
//   - unquoted terms are whole-token matches, implicitly AND'd; English stopwords
//     are stripped from them
//   - the trailing term gets prefix treatment (search-as-you-type) only when the
//     raw input does not end in whitespace or a closing quote; that trailing term
//     is exempt from stopword stripping ("the" may be a half-typed "theme")
//   - if stripping would leave nothing at all (no phrases either), the original
//     terms are kept so an all-stopword query like "to be or not to be" still works

/** Small English stopword list. Deliberately short — this is conversation search,
 *  and words like "how"/"why" carry signal in prompts. */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "do", "for", "i",
  "in", "is", "it", "of", "on", "or", "so", "that", "the", "this", "to",
  "was", "we", "were", "with", "you",
]);

export interface ParsedQuery {
  /** Quoted phrases, in order of appearance. Trimmed, inner whitespace collapsed. */
  phrases: string[];
  /** Unquoted terms surviving stopword stripping, in order of appearance. */
  terms: string[];
  /** True when the LAST element of `terms` should be treated as a prefix
   *  (raw input ended mid-word: no trailing whitespace / closing quote / phrase). */
  prefixLast: boolean;
}

export function parseQuery(raw: string): ParsedQuery {
  const phrases: string[] = [];
  const rawTerms: string[] = [];
  let endedInsidePhrase = false;

  let i = 0;
  let buf = "";
  const flushTerm = () => {
    if (buf) rawTerms.push(buf);
    buf = "";
  };
  while (i < raw.length) {
    const c = raw[i];
    if (c === '"') {
      flushTerm();
      const close = raw.indexOf('"', i + 1);
      const content = (close === -1 ? raw.slice(i + 1) : raw.slice(i + 1, close))
        .trim()
        .replace(/\s+/g, " ");
      if (content) phrases.push(content);
      if (close === -1) {
        endedInsidePhrase = true;
        i = raw.length;
      } else {
        i = close + 1;
      }
    } else if (/\s/.test(c)) {
      flushTerm();
      i++;
    } else {
      buf += c;
      i++;
    }
  }
  flushTerm();

  // Prefix applies only when the user is plausibly mid-word: input must end in a
  // term character (not whitespace, not a closing quote, not inside a phrase).
  const prefixCandidate =
    raw.length > 0 && !endedInsidePhrase && !/[\s"]$/.test(raw) && rawTerms.length > 0;

  // Stopword stripping — the prefix-eligible trailing term is exempt (incomplete word).
  const terms = rawTerms.filter(
    (t, idx) =>
      (prefixCandidate && idx === rawTerms.length - 1) || !STOPWORDS.has(t.toLowerCase()),
  );

  // All-stopword fallback: only when the WHOLE query would otherwise vanish.
  const surviving = terms.length === 0 && phrases.length === 0 && rawTerms.length > 0
    ? rawTerms
    : terms;

  return { phrases, terms: surviving, prefixLast: prefixCandidate };
}

/** Highlightable units for the web reader: quoted phrases (as whole strings) plus
 *  surviving unquoted terms — stopwords already stripped by parseQuery. Sorted
 *  longest-first so overlapping regex alternation prefers the phrase. */
export function highlightUnits(raw: string): string[] {
  const { phrases, terms } = parseQuery(raw);
  const units = [...new Set([...phrases, ...terms])];
  units.sort((a, b) => b.length - a.length);
  return units;
}
