/**
 * The parts of waitlist.ts that don't touch the database — split out so UI
 * components can import them without pulling Prisma into a client bundle.
 * See bookingsShared.ts/settingsShared.ts for the same reasoning, including
 * why this must be imported via the package's "./booking/waitlistShared"
 * subpath, never the root barrel.
 */

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
