/**
 * Wall-clock <-> UTC instant conversion, in the business's own timezone —
 * not the browser's, not the server process's. availability.ts already
 * does this internally for slot generation; this is the same pattern
 * exposed for anywhere a route reads a timezone-naive form value (an
 * <input type="datetime-local">, no offset in the string) or displays a
 * stored UTC instant back to a merchant.
 *
 * The bug this exists to prevent: `new Date("2026-09-10T09:00")` (no
 * offset) is parsed in the *server process's* zone (UTC on Fly.io), not
 * the business's — a merchant in Amsterdam entering 09:00 got it stored
 * as 09:00 UTC, i.e. 11:00 their own time, two hours off. Reading it back
 * with `.toLocaleString()` compounds it a second way: that call uses
 * whichever zone is rendering the page (server during SSR, browser after
 * hydration), not settings.timezone either.
 */
import { DateTime } from "luxon";

/**
 * Parse a timezone-naive local datetime string (an <input type=
 * "datetime-local">'s value, e.g. "2026-09-10T09:00") as wall-clock time
 * in `zone`, returning the corresponding UTC instant.
 */
export function wallClockToUtc(localValue: string, zone: string): Date {
  const parsed = DateTime.fromISO(localValue, { zone });
  if (!parsed.isValid) throw new Error(`Invalid date/time: ${localValue}`);
  return parsed.toJSDate();
}

// Luxon's offsetNameShort resolves through Intl using whichever locale the
// DateTime carries — with none set, that's the runtime's default locale,
// and "en"/"en-US"/no-locale all resolve Europe/Amsterdam's short name to
// "GMT+2" instead of "CEST" on this stack (verified directly; only "en-GB"
// reliably returns the named abbreviation for European zones, the
// product's primary market). Zones with no CLDR short-name data still fall
// back to a GMT-offset regardless of locale — an honest fallback, not a
// bug — but pinning this removes the runtime-dependent flip between "GMT+2"
// and "CEST" for the same zone that made this look non-deterministic
// (Defect Dossier's BQ-10 finding).
const TZ_LOCALE = "en-GB";

/** The short zone abbreviation (CEST, PST, IST, ...) for a UTC instant in `zone`. */
export function zoneAbbr(utc: Date | string, zone: string): string {
  const dt = (typeof utc === "string" ? DateTime.fromISO(utc) : DateTime.fromJSDate(utc)).setZone(zone).setLocale(TZ_LOCALE);
  return dt.offsetNameShort ?? dt.toFormat("ZZZZ");
}

/**
 * Format a stored UTC instant for display in `zone`, with the zone's own
 * abbreviation appended (CEST, PST, IST, ...) so a merchant reading a
 * timestamp never has to guess — or silently trust — which zone it's in.
 */
export function formatInZone(utc: Date | string, zone: string, format = "d LLL yyyy, HH:mm"): string {
  const dt = (typeof utc === "string" ? DateTime.fromISO(utc) : DateTime.fromJSDate(utc)).setZone(zone).setLocale(TZ_LOCALE);
  return `${dt.toFormat(format)} ${zoneAbbr(utc, zone)}`;
}
