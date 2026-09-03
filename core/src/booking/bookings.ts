/**
 * Booking domain service. Ported from shopify-openslot/app/lib/bookings.server.ts
 * — same logic, adapted to core's Prisma client and threaded with an
 * explicit `platform` parameter alongside `shop` (see data.ts's header).
 */
import { DateTime } from "luxon";
import type { Booking } from "@prisma/client";
import prisma from "../db.js";
import * as Data from "./data.js";
import type { CatalogService } from "./data.js";
import * as Availability from "./availability.js";
import * as PaymentManager from "./paymentManager.js";
import { getSettings, type Settings } from "./settings.js";
import { term, money } from "./settingsShared.js";
import { zoneAbbr } from "./tz.js";
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
  /** Merchant's explicit "book outside business hours anyway" — see assertSlotBookable's own doc. Never set from the public form. */
  override?: boolean;
  /**
   * A staff member typing in their own walk-in/phone booking is entering
   * data they already trust, not a stranger's request — auto_confirm's
   * approval gate exists to triage *public* requests, so a manually-created
   * booking defaults to confirmed regardless of that rule, with Pending
   * still available for a genuinely provisional hold (Defect Dossier's
   * BQ-27 finding). Never set from the public form, which must keep going
   * through the normal needsPayment/auto_confirm decision below.
   */
  force_status?: "pending" | "confirmed";
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
  // The specific reason the last candidate was rejected for — surfaced
  // instead of a generic "just taken" when nothing else works out, so
  // "closed that day"/"outside hours"/"inside your notice window" reach the
  // caller the same way reschedule()'s single-candidate path already does
  // (Defect Dossier's BQ-03 finding: Add-consultation and the public form
  // both used to report every non-off-grid rejection as "just taken").
  let lastReason: GetBooqinError | null = null;

  for (const resource of candidates) {
    const tz = Availability.businessTz(shopTimezone, resource);
    const start = makeLocal(args.date, args.time, tz);
    if (!start) continue;
    const end = start.plus({ minutes: service.durationMin + addonDurationMin });

    try {
      await assertSlotBookable(shop, settings, { resourceId: resource.id, service, start, end, override: args.override });
    } catch (err) {
      if (err instanceof GetBooqinError) lastReason = err;
      continue;
    }

    // The published slot grid is itself generated from business hours, so
    // an out-of-hours override booking can never be "on the grid" by
    // definition — override means skip this check too, not just the
    // business-hours one, or every overridden booking would dead-end here
    // as "not one of the available slots" instead of actually going through.
    if (!args.override && !(await slotIsPublished(shop, platform, shopTimezone, args.service_id, resource.id, args.date, args.time, 0, addonDurationMin))) {
      offGrid = true;
      continue;
    }

    chosen = resource;
    startUtc = start.toUTC();
    endUtc = end.toUTC();
    tzName = tz;
    offGrid = false;
    break;
  }

  if (!chosen || !startUtc || !endUtc) {
    if (offGrid) {
      throw new GetBooqinError(
        "getbooqin_slot_not_offered",
        "That time is not one of the available slots. Please pick a time from the list.",
        400
      );
    }
    if (lastReason) throw lastReason;
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

  const status: BookingStatus = needsPayment
    ? "pending"
    : args.force_status ?? (settings.auto_confirm ? "confirmed" : "pending");

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

export async function matchesSchedule(shop: string, resourceId: number, start: DateTime, end: DateTime): Promise<boolean> {
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

export interface SlotCheckArgs {
  resourceId: number;
  service: CatalogService;
  /** Business-tz-local (not UTC) — matchesSchedule needs the resource's own weekday/HH:mm. */
  start: DateTime;
  end: DateTime;
  excludeBookingId?: number;
  /**
   * Skips the business-hours/notice/advance-window checks (only) — a
   * merchant's own explicit "book outside business hours anyway" call.
   * Time-off and double-booking are never overridable: those aren't policy,
   * they're "this literally can't happen" — either the resource is already
   * marked unavailable, or another booking already occupies the slot.
   */
  override?: boolean;
}

/**
 * The one place every write path checks whether a slot can actually be
 * booked: business hours, the notice/advance-booking window, time off, and
 * double-booking. `create()`'s per-resource-candidate loop already chained
 * these inline; reschedule() used to skip straight to the double-booking
 * check alone, which is how a reschedule to a closed Sunday night used to
 * succeed silently (UX audit's #1 finding — the whole reason this function
 * exists as one place instead of four).
 */
export async function assertSlotBookable(shop: string, settings: Settings, args: SlotCheckArgs): Promise<void> {
  const { resourceId, service, start, end, excludeBookingId = 0, override = false } = args;
  const startUtc = start.toUTC();
  const endUtc = end.toUTC();

  if (!override) {
    if (!withinBookingWindow(startUtc, settings)) {
      const nowUtc = DateTime.utc();
      const earliest = nowUtc.plus({ hours: Math.max(0, settings.min_notice_hours) });
      if (startUtc < earliest) {
        throw new GetBooqinError(
          "getbooqin_too_soon",
          `That time is inside the ${settings.min_notice_hours}-hour minimum-notice window.`,
          400
        );
      }
      throw new GetBooqinError(
        "getbooqin_too_far",
        `That date is more than ${settings.max_advance_days} days away — beyond the advance-booking window.`,
        400
      );
    }

    if (!(await matchesSchedule(shop, resourceId, start, end))) {
      const dow = start.weekday % 7;
      const dayRows = await prisma.schedule.count({ where: { shop, resourceId, dayOfWeek: dow } });
      if (dayRows === 0) {
        throw new GetBooqinError("getbooqin_closed_day", "The business is closed that day.", 400);
      }
      throw new GetBooqinError("getbooqin_outside_hours", "That time is outside business hours.", 400);
    }
  }

  if (await Availability.isBlockedByTimeOff(shop, resourceId, startUtc, endUtc, service)) {
    throw new GetBooqinError("getbooqin_time_off", "That time is blocked off (time off).", 409);
  }
  if (await Availability.hasBookingConflict(shop, resourceId, startUtc, endUtc, service, excludeBookingId)) {
    throw new GetBooqinError("getbooqin_slot_taken", "That slot is already booked.", 409);
  }
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

  // Completed/no-show describe how the appointment actually went, so
  // neither means anything before it has even started — a five-day-out
  // booking could be declared "completed" as the visually recommended
  // action (Defect Dossier's BQ-26 finding). Enforced here, not only in the
  // dashboard's button state, since this is a business rule, not a UI nicety.
  if (
    current !== newStatus &&
    (newStatus === "completed" || newStatus === "no_show") &&
    booking.startUtc > now()
  ) {
    throw new GetBooqinError(
      "getbooqin_not_started",
      `This booking can't be marked ${newStatus === "no_show" ? "no-show" : newStatus} before it starts.`,
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

export interface ScheduleConflict {
  ok: boolean;
  reasons: string[];
}

/**
 * Read-only report of whether an *existing* booking currently violates its
 * own business's rules — closed day, outside hours, a time-off block, an
 * overlap with another booking, or a service/resource that's since gone
 * inactive. Nothing composed these checks against a stored booking before;
 * the closest thing (assertNoSlotConflict above) only checks time-off/
 * overlap, only runs on one specific status transition, and throws instead
 * of reporting — a booking could sit outside opening hours (from a seed
 * script, an import, or opening hours changing after the fact) with
 * nothing anywhere flagging it (Defect Dossier's BQ-07 finding). Only
 * meaningful for a booking that's actually occupying a slot; anything else
 * (cancelled, declined, completed, no_show) always reports ok.
 */
export async function scheduleConflict(shop: string, booking: Booking): Promise<ScheduleConflict> {
  if (!OCCUPYING.includes(booking.status as BookingStatus)) return { ok: true, reasons: [] };

  const reasons: string[] = [];
  const [service, resource] = await Promise.all([Data.catalogService(shop, booking.serviceId), Data.resource(shop, booking.resourceId)]);
  if (!service || !service.status) reasons.push("The service for this booking no longer exists or is inactive.");
  if (!resource || !resource.status) reasons.push("The resource for this booking no longer exists or is inactive.");
  if (!service || !resource) return { ok: false, reasons };

  const tz = booking.timezone || "UTC";
  const localStart = DateTime.fromJSDate(booking.startUtc, { zone: "utc" }).setZone(tz);
  const localEnd = DateTime.fromJSDate(booking.endUtc, { zone: "utc" }).setZone(tz);
  if (!(await matchesSchedule(shop, booking.resourceId, localStart, localEnd))) {
    const dow = localStart.weekday % 7;
    const dayRows = await prisma.schedule.count({ where: { shop, resourceId: booking.resourceId, dayOfWeek: dow } });
    reasons.push(dayRows === 0 ? "The business is closed that day." : "This time is outside business hours.");
  }

  const startUtc = DateTime.fromJSDate(booking.startUtc, { zone: "utc" });
  const endUtc = DateTime.fromJSDate(booking.endUtc, { zone: "utc" });
  if (await Availability.isBlockedByTimeOff(shop, booking.resourceId, startUtc, endUtc, service)) {
    reasons.push("This time falls inside a time-off block.");
  }
  if (await Availability.hasBookingConflict(shop, booking.resourceId, startUtc, endUtc, service, booking.id)) {
    reasons.push("This overlaps another booking for the same resource.");
  }

  return { ok: reasons.length === 0, reasons };
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
  resourceIdInput = 0,
  opts: { override?: boolean } = {}
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

  const settings = await getSettings(shop, platform);
  await assertSlotBookable(shop, settings, {
    resourceId,
    service,
    start,
    end,
    excludeBookingId: id,
    override: opts.override,
  });

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

/**
 * Real interval-overlap query (startUtc < end AND endUtc > start), unlike
 * query()'s from/to which only filter on startUtc falling inside the range
 * — a booking already in progress when a block starts wouldn't match that.
 * resourceId 0 means "any resource" (a whole-business time-off block
 * affects every resource, the same OR convention isBlockedByTimeOff uses).
 * Used to warn before a time-off save silently strands existing bookings
 * inside it (Defect Dossier's BQ-08 finding).
 */
export async function occupyingBetween(shop: string, platform: string, resourceId: number, start: Date, end: Date) {
  return prisma.booking.findMany({
    where: {
      shop,
      platform,
      ...(resourceId ? { resourceId } : {}),
      status: { in: OCCUPYING },
      startUtc: { lt: end },
      endUtc: { gt: start },
    },
    include: { service: true, resource: true, customer: true },
    orderBy: { startUtc: "asc" },
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

/**
 * Short timezone abbreviation (CEST, PST, IST, ...) for this booking's own
 * display zone. Used to always return "" whenever that zone matched the
 * shop's default — several email templates then simply never included the
 * {{timezone}} token at all, so a customer reading "10:00" had no way to
 * know which zone that was in even the common case (UX audit's #3
 * finding). Always resolving one, the same way formatInZone does for the
 * dashboard, means a template that includes the token is never silently
 * blank.
 */
export function localTzLabel(booking: Booking, shopTimezone: string): string {
  return zoneAbbr(booking.startUtc, displayTz(booking, shopTimezone));
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

/**
 * Same convention as manageUrl, for the Visit Summary patient-facing page
 * (Clinic preset only — see docs/patient-summary-cloud-integration-plan.md
 * Part 3 §5). Same no-login trust model, keyed off the booking's uid rather
 * than a ConsultationSummary id, since the tokened page always renders
 * whatever the latest sent revision for this booking is.
 */
export function summaryUrl(booking: Booking, settings: Settings): string {
  const base = settings.booking_page_url || "/";
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}getbooqin_summary=${booking.uid}`;
}

export function bookingTerm(settings: Settings): string {
  return term(settings, "booking_single");
}

export { money };
