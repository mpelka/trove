import { describe, it, expect } from "bun:test";
import { parseDate } from "./dates.ts";

const localMidnight = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();

describe("parseDate", () => {
  it("returns undefined for empty/garbage", () => {
    expect(parseDate(undefined)).toBeUndefined();
    expect(parseDate("")).toBeUndefined();
    expect(parseDate("not a date")).toBeUndefined();
  });

  it("today → local midnight; endOfDay → last ms of today", () => {
    const now = new Date();
    const start = localMidnight(now.getFullYear(), now.getMonth() + 1, now.getDate());
    expect(parseDate("today")).toBe(start);
    expect(parseDate("today", { endOfDay: true })).toBe(start + 86_400_000 - 1);
  });

  it("yesterday → local midnight of the previous day", () => {
    const t = parseDate("today")!;
    expect(parseDate("yesterday")).toBe(t - 86_400_000);
  });

  it("bare YYYY-MM-DD parses as LOCAL midnight, not UTC", () => {
    // Date.parse("2026-07-04") is UTC midnight — off by the local offset. Ours must be local.
    expect(parseDate("2026-07-04")).toBe(localMidnight(2026, 7, 4));
    expect(parseDate("2026-07-04", { endOfDay: true })).toBe(
      localMidnight(2026, 7, 4) + 86_400_000 - 1,
    );
  });

  it("full timestamps resolve to their exact instant (endOfDay does not apply)", () => {
    const iso = "2026-07-04T10:30:00.000Z";
    expect(parseDate(iso)).toBe(Date.parse(iso));
    expect(parseDate(iso, { endOfDay: true })).toBe(Date.parse(iso));
  });
});
