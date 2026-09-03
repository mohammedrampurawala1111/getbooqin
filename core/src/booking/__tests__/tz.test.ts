/**
 * Regression test for the UX audit's #1 finding: a <input type=
 * "datetime-local"> value (wall-clock, no offset) written with a naive
 * `new Date(value)` was parsed in the server process's zone (UTC on Fly.io)
 * instead of the business's — a merchant entering 09:00 in Amsterdam
 * (UTC+2 in September) got it stored as 11:00 their own time. Round-trips
 * a wall-clock time through wallClockToUtc -> formatInZone and asserts the
 * clock-face time survives, in zones chosen to catch the traps a naive fix
 * (e.g. a fixed +N-hours offset) would still fail: a half-hour offset, and
 * a DST boundary where the "same" zone means two different UTC offsets a
 * day apart.
 */
import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { wallClockToUtc, formatInZone, zoneAbbr } from "../tz.js";

function roundTrips(localValue: string, zone: string) {
  const utc = wallClockToUtc(localValue, zone);
  const backInZone = DateTime.fromJSDate(utc).setZone(zone);
  return backInZone.toFormat("yyyy-MM-dd'T'HH:mm");
}

describe("wall-clock time round-trips through the business timezone, not UTC or the runtime's own zone", () => {
  it("Europe/Amsterdam (UTC+2 in September) — the exact repro from the audit", () => {
    expect(roundTrips("2026-09-10T09:00", "Europe/Amsterdam")).toBe("2026-09-10T09:00");
    const utc = wallClockToUtc("2026-09-10T09:00", "Europe/Amsterdam");
    // 09:00 CEST is 07:00 UTC — if this read 09:00 or 11:00 UTC, the bug's back.
    expect(utc.toISOString()).toBe("2026-09-10T07:00:00.000Z");
  });

  it("America/Los_Angeles — different sign from Amsterdam, catches an offset applied backwards", () => {
    expect(roundTrips("2026-09-10T09:00", "America/Los_Angeles")).toBe("2026-09-10T09:00");
  });

  it("Asia/Kolkata — half-hour offset, breaks any fix that only handles whole hours", () => {
    expect(roundTrips("2026-09-10T09:00", "Asia/Kolkata")).toBe("2026-09-10T09:00");
    const utc = wallClockToUtc("2026-09-10T09:00", "Asia/Kolkata");
    expect(utc.toISOString()).toBe("2026-09-10T03:30:00.000Z");
  });

  it("survives a DST boundary — the zone's UTC offset is different the day before vs. after", () => {
    // US DST ends 2026-11-01; America/New_York is UTC-4 before, UTC-5 after.
    const beforeUtc = wallClockToUtc("2026-10-31T09:00", "America/New_York");
    const afterUtc = wallClockToUtc("2026-11-02T09:00", "America/New_York");
    expect(DateTime.fromJSDate(beforeUtc).setZone("America/New_York").offset).toBe(-4 * 60);
    expect(DateTime.fromJSDate(afterUtc).setZone("America/New_York").offset).toBe(-5 * 60);
    // Same wall-clock 09:00 both sides, one hour apart in real UTC time —
    // a fixed-offset "fix" would get exactly one of these two right.
    expect(afterUtc.getTime() - beforeUtc.getTime()).toBe(
      (2 * 24 + 1) * 60 * 60 * 1000 // 2 days + the DST hour
    );
  });

  it("formatInZone shows the business zone's own clock face and abbreviation, not the caller's", () => {
    const utc = wallClockToUtc("2026-09-10T09:00", "Europe/Amsterdam");
    const shown = formatInZone(utc, "Europe/Amsterdam");
    expect(shown).toContain("09:00");
    // Pinned to a deterministic locale (BQ-10 finding) — this used to be
    // "GMT+2" or "CEST" depending on the runtime's default locale, so the
    // test hedged with an either/or. A zone with real CLDR short-name
    // coverage should now always resolve the named abbreviation.
    expect(shown).toContain("CEST");
    // Same instant, formatted for a merchant on the other side of the
    // world, must show *their* clock face, not Amsterdam's — this is what
    // .toLocaleString() with no explicit zone silently fails to do.
    const elsewhere = formatInZone(utc, "America/Los_Angeles");
    expect(elsewhere).not.toContain("09:00");
  });

  it("falls back to a plain GMT offset for a zone with no CLDR short-name data, regardless of locale", () => {
    // Not a bug — an honest fallback for zones the CLDR data set simply
    // doesn't assign a named abbreviation to.
    const utc = wallClockToUtc("2026-09-10T09:00", "Asia/Kolkata");
    expect(zoneAbbr(utc, "Asia/Kolkata")).toMatch(/^GMT\+/);
  });
});
