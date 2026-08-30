/**
 * The parts of waitlist.ts that don't touch the database — split out so UI
 * components can import them without pulling Prisma into a client bundle.
 * See bookingsShared.ts/settingsShared.ts for the same reasoning, including
 * why this must be imported via the package's "./booking/waitlistShared"
 * subpath, never the root barrel.
 */
import { DateTime } from "luxon";

export const WAITLIST_STATUSES = ["waiting", "offered", "claimed", "expired", "cancelled"] as const;
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number];

export function waitlistStatusLabels(): Record<WaitlistStatus, string> {
  return {
    waiting: "Waiting",
    offered: "Offered",
    claimed: "Claimed",
    expired: "Expired",
    cancelled: "Cancelled",
  };
}

/**
 * A waitlist entry's window is either a date range ("notify me of anything
 * this day/range" — join()'s whole-day shape) or, when windowStartUtc and
 * windowEndUtc land on the exact same instant, one specific slot ("only
 * this exact time" — join()'s time-scoped shape, see waitlist.ts's header
 * comment). Formatting them the same way as a same-day range would read as
 * "30 Aug – 30 Aug" with no indication a specific time was ever requested —
 * the whole reason that shape exists — so the exact-instant case gets its
 * own, more informative format instead.
 */
export function formatWaitlistWindow(windowStartUtc: Date, windowEndUtc: Date | null, zone: string): string {
  const start = DateTime.fromJSDate(windowStartUtc, { zone: "utc" }).setZone(zone);
  if (windowEndUtc && windowEndUtc.getTime() === windowStartUtc.getTime()) {
    return start.toFormat("d LLL, h:mm a");
  }
  if (!windowEndUtc) return `${start.toFormat("d LLL")}+`;
  const end = DateTime.fromJSDate(windowEndUtc, { zone: "utc" }).setZone(zone);
  return `${start.toFormat("d LLL")} – ${end.toFormat("d LLL")}`;
}
