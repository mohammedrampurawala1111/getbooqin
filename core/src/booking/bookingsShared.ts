/**
 * The parts of bookings.ts that don't touch the database — split out so
 * UI components can import them without pulling Prisma into a client bundle.
 * See settingsShared.ts for the same reasoning.
 *
 * Client components must import this via the package's
 * "./booking/bookingsShared" subpath export, not the root barrel
 * ("getbooqin-core"). The root barrel's index.ts does `export * as X from
 * "./foo.js"` for every domain module, and JS engines eagerly evaluate an
 * entire re-exported module graph the moment anything is imported from the
 * barrel — so even an unrelated named import pulls in every submodule,
 * including ones with Node-only side effects (Prisma's client, node:crypto,
 * nodemailer, ...). Vite's dev server doesn't tree-shake that away.
 */

export const STATUSES = ["pending", "confirmed", "declined", "cancelled", "completed", "no_show"] as const;
export type BookingStatus = (typeof STATUSES)[number];

/** Allowed status transitions. Anything not listed is rejected — fail closed. */
export const TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  pending: ["confirmed", "declined", "cancelled", "no_show"],
  confirmed: ["completed", "cancelled", "no_show"],
  declined: ["pending"],
  cancelled: ["pending", "confirmed"],
  completed: [],
  no_show: ["confirmed"],
};

/** Statuses that occupy a slot. Moving *into* one of these re-checks availability. */
export const OCCUPYING: BookingStatus[] = ["pending", "confirmed"];

export function statusLabels(): Record<BookingStatus, string> {
  return {
    pending: "Pending",
    confirmed: "Confirmed",
    declined: "Declined",
    cancelled: "Cancelled",
    completed: "Completed",
    no_show: "No show",
  };
}

export function paymentStatusLabels(): Record<string, string> {
  return {
    not_required: "No payment",
    unpaid: "Unpaid",
    paid: "Paid",
    refunded: "Refunded",
    failed: "Failed",
  };
}

export function validDate(date: unknown): date is string {
  return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date);
}

export function validTime(time: unknown): time is string {
  return typeof time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
}

export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
