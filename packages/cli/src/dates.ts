/** Parse a user-facing date filter into epoch ms, in LOCAL time.
 *
 * - "today" / "yesterday" → local midnight of that day
 * - "YYYY-MM-DD" → local midnight (NOT Date.parse, which treats date-only as UTC)
 * - anything else → Date.parse (full timestamps resolve to their exact instant)
 *
 * With `endOfDay`, day-granular inputs resolve to 23:59:59.999 so `--until today`
 * includes the whole day instead of excluding everything after midnight.
 */
export function parseDate(
  s: string | undefined,
  opts: { endOfDay?: boolean } = {},
): number | undefined {
  if (!s) return undefined;
  const lower = s.toLowerCase().trim();
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const finish = (startMs: number) => (opts.endOfDay ? startMs + 86_400_000 - 1 : startMs);

  const now = new Date();
  if (lower === "today") return finish(dayStart(now));
  if (lower === "yesterday") return finish(dayStart(new Date(now.getTime() - 86_400_000)));

  const ymd = lower.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) {
    const local = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
    return finish(local.getTime());
  }

  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}
