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
  // no_show describes a confirmed appointment nobody showed up to — a
  // request nobody has approved yet is Declined or Cancelled instead
  // (Defect Dossier's BQ-26 finding: this let a pending, future booking be
  // marked no-show before anyone had even confirmed it would happen).
  pending: ["confirmed", "declined", "cancelled"],
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

// A synthesized placeholder — "phone-9325705315@getbooqin.invalid" for a
// customer who booked with no email address (see data.ts's
// findOrCreateCustomer, GetBooqin clinic audit's PB-03 finding), or
// "erased-23@getbooqin.invalid" for a customer record erased under PT-01 —
// is a syntactically valid email (isEmail() passes it) but was never
// actually given by anyone and must never receive real mail. Every
// customer-facing send funnels through mailer.ts's sendToCustomer(), which
// checks this instead of isEmail() alone.
export function isRealEmail(value: string): boolean {
  return isEmail(value) && !value.toLowerCase().endsWith("@getbooqin.invalid");
}

// Same loose E.164-ish check as cloud/app/lib/validation.ts's isValidPhone
// (that copy is client-bundle-safe UI validation; this one is what the
// WhatsApp send path — see whatsapp.ts's sendToCustomer — checks server-side
// before trying to message a customer.phone value at all). Deliberately
// permissive on formatting; not a substitute for real E.164 parsing.
export function isPhone(value: string): boolean {
  return /^\+?[1-9]\d{6,14}$/.test(value.replace(/[\s()-]/g, ""));
}

/**
 * Prepends the business's configured default country code to a phone
 * number that doesn't already have one — "9325705315" saved verbatim with
 * no country code and no format hint, then silently failing to deliver the
 * moment WhatsApp is switched on (Meta's Cloud API requires E.164), was
 * exactly the gap GetBooqin clinic audit's PB-03 finding reproduced. Only
 * ever adds a "+" prefix; never reformats or validates the rest of the
 * number, so this can't corrupt a number a customer already typed with its
 * own country code (anything starting with "+" or "00" is left alone).
 */
export function normalizePhone(phone: string, defaultCountryCode: string): string {
  const trimmed = phone.trim();
  if (!trimmed || !defaultCountryCode) return trimmed;
  if (trimmed.startsWith("+") || trimmed.startsWith("00")) return trimmed;
  const code = defaultCountryCode.startsWith("+") ? defaultCountryCode : `+${defaultCountryCode}`;
  return `${code}${trimmed.replace(/^0+/, "")}`;
}
