/**
 * Booking domain service. Ported from shopify-openslot/app/lib/bookings.server.ts
 * — same logic, adapted to core's Prisma client and threaded with an
 * explicit `platform` parameter alongside `shop` (see data.ts's header).
 */
import { DateTime } from "luxon";
import type { Booking } from "@prisma/client";
import prisma from "../db.js";
import * as Data from "./data.js";
import * as Availability from "./availability.js";
import * as PaymentManager from "./paymentManager.js";
import { getSettings, type Settings } from "./settings.js";
import { term, money } from "./settingsShared.js";
import { uid, now } from "./ids.js";
import { GetBooqinError } from "./errors.js";
import events from "./events.js";
import { STATUSES, TRANSITIONS, OCCUPYING, type BookingStatus, statusLabels, paymentStatusLabels, isEmail } from "./bookingsShared.js";

export { STATUSES, TRANSITIONS, OCCUPYING, statusLabels, paymentStatusLabels, isEmail };
export type { BookingStatus };

/* ------------------------------------------------------------ Validation */

export function validDate(date: unknown): date is string {
  if (typeof date !== "string" || !/^(\d{4})-(\d{2})-(\d{2})$/.test(date)) return false;
  const dt = DateTime.fromISO(date);
  return dt.isValid;
}

/** Strict 24-hour H:i. Rejects 25:00, 99:99, 9:5 and friends. */
export function validTime(time: unknown): time is string {
  return typeof time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
}

function makeLocal(date: string, time: string, tz: string): DateTime | null {
  if (!validDate(date) || !validTime(time)) return null;
  const dt = DateTime.fromISO(`${date}T${time}:00`, { zone: tz });
  return dt.isValid ? dt : null;
}

/** Is this exact time one the slot engine actually published? Stops off-grid bookings. */
export async function slotIsPublished(
  shop: string,
  platform: string,
  shopTimezone: string,
  serviceId: number,
  resourceId: number,
  date: string,
  time: string,
  excludeBookingId = 0,
  extraDurationMin = 0
): Promise<boolean> {
  const daySlots = await Availability.slots(shop, platform, shopTimezone, serviceId, resourceId, date, excludeBookingId, extraDurationMin);
  return daySlots.some((slot) => slot.time === time);
}

/* ---------------------------------------------------------------- Create */

export interface CreateBookingArgs {
  service_id: number;
  resource_id?: number;
  date: string;
  time: string;
  first_name: string;
  last_name?: string;
  email: string;
  phone?: string;
  notes?: string;
  custom_fields?: Record<string, unknown>;
  addon_ids?: number[];
  source?: "form" | "chat" | "waitlist";
}

export async function create(shop: string, platform: string, shopTimezone: string, args: CreateBookingArgs): Promise<Booking> {
  const settings = await getSettings(shop, platform);

  const service = await Data.catalogService(shop, args.service_id);
  if (!service) throw new GetBooqinError("getbooqin_invalid_service", "That service is not available.", 400);
  if (!isEmail(args.email)) throw new GetBooqinError("getbooqin_invalid_email", "Please provide a valid email address.", 400);
  if (!args.first_name) throw new GetBooqinError("getbooqin_missing_name", "Please provide your name.", 400);
  if (settings.require_phone && !args.phone) {
    throw new GetBooqinError("getbooqin_missing_phone", "Please provide a phone number.", 400);
  }
  for (const field of settings.intake_fields) {
    if (!field.required) continue;
    const value = args.custom_fields?.[field.key];
    if (value === undefined || value === null || String(value).trim() === "") {
      throw new GetBooqinError("getbooqin_missing_field", `Please provide ${field.label}.`, 400);
    }
  }
  if (!validDate(args.date) || !validTime(args.time)) {
    throw new GetBooqinError("getbooqin_invalid_slot", "Please choose a valid date and time.", 400);
  }

  const resolvedAddons = await Data.addonsForServiceByIds(shop, service.id, args.addon_ids ?? []);
  const addonDurationMin = resolvedAddons.reduce((sum, a) => sum + a.durationMin, 0);
  const addonPrice = resolvedAddons.reduce((sum, a) => sum + a.price, 0);

  const candidates = args.resource_id
    ? [await Data.resource(shop, args.resource_id)].filter((r): r is NonNullable<typeof r> => !!r)
    : await Data.resourcesForService(shop, platform, args.service_id);

  if (candidates.length === 0) {
    throw new GetBooqinError("getbooqin_no_resource", "No one is available for that service.", 400);
  }

  let chosen: (typeof candidates)[number] | null = null;
  let startUtc: DateTime | null = null;
  let endUtc: DateTime | null = null;
  let tzName = shopTimezone;
  let offGrid = false;

  for (const resource of candidates) {
    const tz = Availability.businessTz(shopTimezone, resource);
    const start = makeLocal(args.date, args.time, tz);
    if (!start) continue;
    const end = start.plus({ minutes: service.durationMin + addonDurationMin });

    const sUtc = start.toUTC();
    const eUtc = end.toUTC();

    if (!withinBookingWindow(sUtc, settings)) continue;
    if (!(await matchesSchedule(shop, resource.id, start, end))) continue;
    if (!(await slotIsPublished(shop, platform, shopTimezone, args.service_id, resource.id, args.date, args.time, 0, addonDurationMin))) {
      offGrid = true;
      continue;
    }
    if (await Availability.isFree(shop, resource.id, sUtc, eUtc, service)) {
      chosen = resource;
      startUtc = sUtc;
      endUtc = eUtc;
      tzName = tz;
      offGrid = false;
      break;
    }
  }

  if (!chosen || !startUtc || !endUtc) {
    if (offGrid) {
      throw new GetBooqinError(
        "getbooqin_slot_not_offered",
        "That time is not one of the available slots. Please pick a time from the list.",
        400
      );
    }
    throw new GetBooqinError("getbooqin_slot_taken", "Sorry, that time was just taken. Please pick another slot.", 409);
  }

  const customerId = await Data.findOrCreateCustomer(shop, platform, {
    first_name: args.first_name,
    last_name: args.last_name,
    email: args.email,
    phone: args.phone,
    timezone: shopTimezone,
  });

  const amountDue = PaymentManager.amountDue(service) + addonPrice;
  const needsPayment = await PaymentManager.paymentBlocksConfirmation(shop, settings, service);

  const paymentStatus =
    amountDue > 0 && service.paymentRequired && PaymentManager.paymentsAvailable(settings)
      ? "unpaid"
      : "not_required";

  const status: BookingStatus = needsPayment ? "pending" : settings.auto_confirm ? "confirmed" : "pending";

  const created = await prisma.booking.create({
    data: {
      shop,
      platform,
      uid: uid(),
      serviceId: service.id,
      resourceId: chosen.id,
      customerId,
      startUtc: startUtc.toJSDate(),
      endUtc: endUtc.toJSDate(),
      timezone: tzName,
      status,
      price: service.price + addonPrice,
      amountDue,
      currency: settings.currency,
      paymentStatus,
      notes: args.notes ?? "",
      customFields: args.custom_fields ? JSON.stringify(args.custom_fields) : null,
      source: args.source ?? "form",
      createdAt: now(),
      updatedAt: now(),
    },
  });

  if (resolvedAddons.length) {
    await prisma.bookingAddon.createMany({
      data: resolvedAddons.map((a) => ({
        shop,
        platform,
        bookingId: created.id,
        addonId: a.id,
        name: a.name,
        price: a.price,
        durationMin: a.durationMin,
      })),
    });
  }

  events.emitEvent("booking_created", created);

  return created;
}

function withinBookingWindow(startUtc: DateTime, settings: Settings): boolean {
  const nowUtc = DateTime.utc();
  const earliest = nowUtc.plus({ hours: Math.max(0, settings.min_notice_hours) });
  const latest = nowUtc.plus({ days: Math.max(1, settings.max_advance_days) });
  return startUtc >= earliest && startUtc <= latest;
}

async function matchesSchedule(shop: string, resourceId: number, start: DateTime, end: DateTime): Promise<boolean> {
  const dow = start.weekday % 7;
  const count = await prisma.schedule.count({
    where: {
      shop,
      resourceId,
      dayOfWeek: dow,
      startTime: { lte: start.toFormat("HH:mm") },
      endTime: { gte: end.toFormat("HH:mm") },
    },
  });
  return count > 0;
}

export function get(shop: string, id: number) {
  return prisma.booking.findFirst({ where: { shop, id } });
}

export function getByUid(shop: string, uidValue: string) {
  return prisma.booking.findFirst({ where: { shop, uid: uidValue } });
}

/** Change status through the transition table. Throws GetBooqinError on rejection. */
export async function setStatus(shop: string, id: number, newStatus: string, reason = ""): Promise<Booking> {
  const booking = await get(shop, id);
  if (!booking) throw new GetBooqinError("getbooqin_not_found", "Booking not found.", 404);
  if (!STATUSES.includes(newStatus as BookingStatus)) {
    throw new GetBooqinError("getbooqin_bad_status", "Unknown status.", 400);
  }

  const current = booking.status as BookingStatus;
  const allowed = TRANSITIONS[current] ?? [];
  if (current !== newStatus && !allowed.includes(newStatus as BookingStatus)) {
    throw new GetBooqinError(
      "getbooqin_bad_transition",
      `Cannot move a booking from ${current} to ${newStatus}.`,
      400
    );
  }

  if (
    current !== newStatus &&
    OCCUPYING.includes(newStatus as BookingStatus) &&
    !OCCUPYING.includes(current)
  ) {
    await assertNoSlotConflict(shop, booking);
  }

  const old = booking.status;
  const updated = await prisma.booking.update({
    where: { id },
    data: { status: newStatus, updatedAt: now() },
  });

  events.emitEvent("booking_status_changed", updated, old, newStatus, reason);
  if (newStatus === "cancelled") {
    events.emitEvent("booking_cancelled", updated, reason);
  }
  // A slot freed up early (not "completed" — that's a normal conclusion,
  // not a vacancy) — offer it to the waitlist. Fired for the same
  // OCCUPYING-boundary reason assertNoSlotConflict guards the opposite
  // direction, just mirrored: leaving pending/confirmed into
  // cancelled/declined/no_show, not entering it.
  if (
    OCCUPYING.includes(current) &&
    ["cancelled", "declined", "no_show"].includes(newStatus) &&
    current !== newStatus
  ) {
    events.emitEvent("booking_slot_freed", {
      shop,
      platform: updated.platform,
      serviceId: updated.serviceId,
      resourceId: updated.resourceId,
      startUtc: updated.startUtc,
      endUtc: updated.endUtc,
    });
  }

  return updated;
}

/** Decline a pending request, optionally recording the owner's reason (stashed in customFields — no schema for a dedicated column). */
export async function decline(shop: string, id: number, reason = ""): Promise<Booking> {
  const booking = await get(shop, id);
  if (!booking) throw new GetBooqinError("getbooqin_not_found", "Booking not found.", 404);

  if (reason) {
    const existing = booking.customFields ? JSON.parse(booking.customFields) : {};
    await prisma.booking.update({
      where: { id },
      data: { customFields: JSON.stringify({ ...existing, _decline_reason: reason }) },
    });
  }

  return setStatus(shop, id, "declined", reason ? `declined: ${reason}` : "declined");
}

/** Would putting this booking back on the calendar collide with another? Throws if not. */
export async function assertNoSlotConflict(shop: string, booking: Booking): Promise<void> {
  const service = await Data.catalogService(shop, booking.serviceId);
  if (!service) throw new GetBooqinError("getbooqin_invalid_service", "The service for this booking no longer exists.", 400);

  const start = DateTime.fromJSDate(booking.startUtc, { zone: "utc" });
  const end = DateTime.fromJSDate(booking.endUtc, { zone: "utc" });

  if (!(await Availability.isFree(shop, booking.resourceId, start, end, service, booking.id))) {
    throw new GetBooqinError(
      "getbooqin_slot_taken",
      "That slot is no longer available — another booking now occupies it. Reschedule this one instead.",
      409
    );
  }
}

/** Can the customer still cancel this themselves? */
export function customerCanCancel(booking: Booking, settings: Settings): boolean {
  if (!settings.allow_cancel) return false;
  if (!["pending", "confirmed"].includes(booking.status)) return false;
  const cutoffMs = settings.cancel_cutoff_hours * 3600 * 1000;
  return booking.startUtc.getTime() - Date.now() > cutoffMs;
}

/**
 * Can the customer move this to a new time themselves? Reuses the same
 * cutoff protection as cancellation.
 */
export function customerCanReschedule(booking: Booking, settings: Settings): boolean {
  return customerCanCancel(booking, settings);
}

/** Reschedule to a new date/time. Throws GetBooqinError on rejection. */
export async function reschedule(
  shop: string,
  platform: string,
  shopTimezone: string,
  id: number,
  date: string,
  time: string,
  resourceIdInput = 0
): Promise<Booking> {
  const booking = await get(shop, id);
  if (!booking) throw new GetBooqinError("getbooqin_not_found", "Booking not found.", 404);
  const service = await Data.catalogService(shop, booking.serviceId);
  if (!service) throw new GetBooqinError("getbooqin_invalid_service", "Service no longer exists.", 400);
  if (!validDate(date) || !validTime(time)) {
    throw new GetBooqinError("getbooqin_invalid_slot", "Please choose a valid date and time.", 400);
  }

  const resourceId = resourceIdInput || booking.resourceId;
  const resource = await Data.resource(shop, resourceId);
  if (!resource) throw new GetBooqinError("getbooqin_no_resource", "That staff member no longer exists.", 400);
  const tz = Availability.businessTz(shopTimezone, resource);

  const start = makeLocal(date, time, tz);
  if (!start) throw new GetBooqinError("getbooqin_invalid_slot", "Please choose a valid date and time.", 400);
  const end = start.plus({ minutes: service.durationMin });
  const sUtc = start.toUTC();
  const eUtc = end.toUTC();

  if (!(await Availability.isFree(shop, resourceId, sUtc, eUtc, service, id))) {
    throw new GetBooqinError("getbooqin_slot_taken", "That slot is not available.", 409);
  }

  const previous = booking;
  const updated = await prisma.booking.update({
    where: { id },
    data: {
      resourceId,
      startUtc: sUtc.toJSDate(),
      endUtc: eUtc.toJSDate(),
      timezone: tz,
      reminderSent: false,
      updatedAt: now(),
    },
  });

  events.emitEvent("booking_rescheduled", updated, previous);
  // The original slot is now vacant — same freed-slot signal setStatus()
  // emits for a cancellation, just for the previous time/resource instead.
  events.emitEvent("booking_slot_freed", {
    shop,
    platform: previous.platform,
    serviceId: previous.serviceId,
    resourceId: previous.resourceId,
    startUtc: previous.startUtc,
    endUtc: previous.endUtc,
  });

  return updated;
}

export async function remove(shop: string, id: number): Promise<void> {
  const booking = await get(shop, id);
  if (!booking) throw new GetBooqinError("getbooqin_not_found", "Booking not found.", 404);
  await prisma.booking.delete({ where: { id } });
  events.emitEvent("booking_deleted", booking);
}

/* --------------------------------------------------------------- Queries */

export interface QueryArgs {
  status?: string;
  statusIn?: string[];
  notStatus?: string[];
  resource_id?: number;
  service_id?: number;
  customer_id?: number;
  from?: Date;
  to?: Date;
  search?: string;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
}

export async function query(shop: string, platform: string, args: QueryArgs = {}) {
  const limit = Math.max(1, Math.min(500, args.limit ?? 50));
  const offset = Math.max(0, args.offset ?? 0);

  return prisma.booking.findMany({
    where: {
      shop,
      platform,
      ...(args.status ? { status: args.status } : {}),
      ...(args.statusIn?.length ? { status: { in: args.statusIn } } : {}),
      ...(args.notStatus?.length ? { status: { notIn: args.notStatus } } : {}),
      ...(args.resource_id ? { resourceId: args.resource_id } : {}),
      ...(args.service_id ? { serviceId: args.service_id } : {}),
      ...(args.customer_id ? { customerId: args.customer_id } : {}),
      ...(args.from ? { startUtc: { gte: args.from } } : {}),
      ...(args.to ? { startUtc: { lte: args.to } } : {}),
      ...(args.search
        ? {
            customer: {
              OR: [
                { firstName: { contains: args.search } },
                { lastName: { contains: args.search } },
                { email: { contains: args.search } },
                { phone: { contains: args.search } },
              ],
            },
          }
        : {}),
    },
    include: { service: true, resource: true, customer: true },
    orderBy: { startUtc: args.order === "asc" ? "asc" : "desc" },
    take: limit,
    skip: offset,
  });
}

export async function queryCount(shop: string, platform: string, args: QueryArgs = {}) {
  return prisma.booking.count({
    where: {
      shop,
      platform,
      ...(args.status ? { status: args.status } : {}),
      ...(args.from ? { startUtc: { gte: args.from } } : {}),
      ...(args.to ? { startUtc: { lte: args.to } } : {}),
      ...(args.search
        ? {
            customer: {
              OR: [
                { firstName: { contains: args.search } },
                { lastName: { contains: args.search } },
                { email: { contains: args.search } },
                { phone: { contains: args.search } },
              ],
            },
          }
        : {}),
    },
  });
}

export async function count(shop: string, platform: string, args: { status?: string; from?: Date; to?: Date } = {}) {
  return prisma.booking.count({
    where: {
      shop,
      platform,
      ...(args.status ? { status: args.status } : {}),
      ...(args.from ? { startUtc: { gte: args.from } } : {}),
      ...(args.to ? { startUtc: { lte: args.to } } : {}),
    },
  });
}

/* ------------------------------------------------------------- Formatting */

/** The timezone a booking should be displayed in: the one recorded on the row. */
export function displayTz(booking: Booking, shopTimezone: string): string {
  const stored = booking.timezone || "";
  if (stored && stored.includes("/")) return stored;
  return shopTimezone || "UTC";
}

export function localDate(booking: Booking, shopTimezone: string, format = "DDD"): string {
  return DateTime.fromJSDate(booking.startUtc, { zone: "utc" })
    .setZone(displayTz(booking, shopTimezone))
    .toFormat(format);
}

export function localTime(booking: Booking, shopTimezone: string): string {
  return DateTime.fromJSDate(booking.startUtc, { zone: "utc" })
    .setZone(displayTz(booking, shopTimezone))
    .toFormat("h:mm a");
}

/** Short timezone label (IST, GMT+5:30) — empty when it matches the shop timezone. */
export function localTzLabel(booking: Booking, shopTimezone: string): string {
  const tz = displayTz(booking, shopTimezone);
  if (tz === shopTimezone) return "";
  return DateTime.fromJSDate(booking.startUtc, { zone: "utc" }).setZone(tz).toFormat("z");
}

export function needsPayment(booking: Booking): boolean {
  const status = booking.paymentStatus || "not_required";
  const due = booking.amountDue || 0;
  return ["unpaid", "failed"].includes(status) && due > 0;
}

export function manageUrl(booking: Booking, settings: Settings): string {
  const base = settings.booking_page_url || "/";
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}getbooqin_booking=${booking.uid}`;
}

export function bookingTerm(settings: Settings): string {
  return term(settings, "booking_single");
}

export { money };
