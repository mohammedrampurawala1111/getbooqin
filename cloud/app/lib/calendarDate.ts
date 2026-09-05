/**
 * Pure calendar-day arithmetic for the appointments calendar's date
 * navigation (prev/next day, prev/next week) and axis-label formatting.
 * Deliberately plain-Date, not luxon — this is calendar-day math (no real
 * instant, no DST concern), and keeping luxon out of anything the client
 * bundle can reach matches the rest of this app's convention (see
 * getbooqin-core/booking/tz's own header comment).
 */

function parseIsoDateUtc(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

function formatIsoDateUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function shiftDate(iso: string, days: number): string {
  const d = parseIsoDateUtc(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return formatIsoDateUtc(d);
}

/** 0=Sunday..6=Saturday, matching Schedule.dayOfWeek's own convention. */
export function dayOfWeekFromIso(iso: string): number {
  return parseIsoDateUtc(iso).getUTCDay();
}

/** Canonicalizes any date to that ISO (Monday-start) week's Monday. */
export function mondayOf(iso: string): string {
  const dow = dayOfWeekFromIso(iso);
  const back = dow === 0 ? 6 : dow - 1;
  return shiftDate(iso, -back);
}

export function toHHMM(minutesSinceMidnight: number): string {
  const clamped = Math.max(0, Math.min(24 * 60, Math.round(minutesSinceMidnight)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
