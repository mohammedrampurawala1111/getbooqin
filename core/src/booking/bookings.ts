/**
 * Booking domain service. Ported from shopify-openslot/app/lib/bookings.server.ts
 * — same logic, adapted to core's Prisma client and threaded with an
 * explicit `platform` parameter alongside `shop` (see data.ts's header).
 */
import { DateTime } from "luxon";
import type { Booking } from "@prisma/client";
import prisma, { type DbClient } from "../db.js";
import * as Data from "./data.js";
import type { CatalogService } from "./data.js";
import * as Availability from "./availability.js";
import { getSettings, type Settings } from "./settings.js";
import { term, money } from "./settingsShared.js";
import { zoneAbbr } from "./tz.js";
import { uid, now } from "./ids.js";
import { GetBooqinError } from "./errors.js";
import events from "./events.js";
import { withShopBookingLock, translateOverlapViolation } from "./slotLock.js";
import { assertCanTakeBooking } from "../billing/enforcement.js";
import { STATUSES, TRANSITIONS, OCCUPYING, type BookingStatus, statusLabels, isEmail, isRealEmail, isPhone, normalizePhone } from "./bookingsShared.js";

export { STATUSES, TRANSITIONS, OCCUPYING, statusLabels, isEmail, isRealEmail, isPhone, normalizePhone };
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
   * through the normal auto_confirm decision below.
   */
  force_status?: "pending" | "confirmed";
}

export async function create(shop: string, platform: string, shopTimezone: string, args: CreateBookingArgs): Promise<Booking> {
  const settings = await getSettings(shop, platform);

  // Monthly booking quota. Only "form" bookings count — a staff member
  // typing in a walk-in is doing admin, not consuming a quota, and
  // metering that would push a merchant back to paper for exactly the
  // bookings this product exists to absorb. Checked before anything is
  // written so a customer who is going to be turned away is turned away
  // before a Customer row is created for them.
  await assertCanTakeBooking(shop, platform, args.source ?? "form");

  const service = await Data.catalogService(shop, args.service_id);
  if (!service) throw new GetBooqinError("getbooqin_invalid_service", "That service is not available.", 400);
  // Email used to be hard-required with no matching setting, while phone
  // had its own require_phone toggle right beside it on Booking rules — a
  // walk-in patient with no email address (common for a clinic's older or
  // lower-income patients) couldn't book online at all (GetBooqin clinic
  // audit's PB-03 finding). A non-empty email must still be well-formed
  // either way; only the "must be present" half is now conditional.
  if (args.email && !isEmail(args.email)) {
    throw new GetBooqinError("getbooqin_invalid_email", "Please provide a valid email address.", 400);
  }
  if (settings.require_email && !args.email) {
    throw new GetBooqinError("getbooqin_missing_email", "Please provide an email address.", 400);
  }
  if (!args.first_name) throw new GetBooqinError("getbooqin_missing_name", "Please provide your name.", 400);
  if (settings.require_phone && !args.phone) {
    throw new GetBooqinError("getbooqin_missing_phone", "Please provide a phone number.", 400);
  }
  // With both email and phone optional, at least one real way to reach the
  // customer must exist — Data.findOrCreateCustomer() can technically
  // synthesize a record with neither, but a booking nobody can be
  // contacted about isn't a state this app should let happen silently.
  if (!settings.require_email && !settings.require_phone && !args.email && !args.phone) {
    throw new GetBooqinError("getbooqin_missing_contact", "Please provide a phone number or email address.", 400);
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
  // Business-tz-local, not UTC — assertSlotBookable() needs the resource's
  // own weekday/HH:mm for the business-hours check, so the second pass
  // under the shop lock below has to be handed the same pair this loop
  // used, not a UTC round-trip of it.
  let localStart: DateTime | null = null;
  let localEnd: DateTime | null = null;
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
  // The last candidate that passed every bookability check and then
  // turned out not to be on the published slot grid. Kept so the failure
  // below can work out *why* it wasn't — see there.
  let offGridCandidate: { resource: (typeof candidates)[number]; start: DateTime; end: DateTime } | null = null;

  for (const resource of candidates) {
    const tz = Availability.businessTz(shopTimezone, resource);
    const start = makeLocal(args.date, args.time, tz);
    if (!start) continue;
    const end = start.plus({ minutes: service.durationMin + addonDurationMin });

    try {
      await assertSlotBookable(shop, platform, settings, { resourceId: resource.id, service, start, end, override: args.override });
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
      offGridCandidate = { resource, start, end };
      continue;
    }

    chosen = resource;
    localStart = start;
    localEnd = end;
    startUtc = start.toUTC();
    endUtc = end.toUTC();
    tzName = tz;
    offGrid = false;
    break;
  }

  if (!chosen || !startUtc || !endUtc || !localStart || !localEnd) {
    if (offGrid && offGridCandidate) {
      // "Not on the published grid" is an ambiguous answer, because the
      // grid is generated from business hours *minus existing bookings*.
      // A slot the customer picked off our own list a moment ago, which
      // passed every bookability check two statements ago and has now
      // vanished from the grid, almost certainly vanished because
      // somebody else just booked it — and telling that customer "that
      // time is not one of the available slots" is both confusing and
      // the wrong error code: the public booking form re-fetches the day
      // on getbooqin_slot_taken and does nothing on this one. Ask
      // directly rather than guessing.
      try {
        await assertSlotBookable(shop, platform, settings, {
          resourceId: offGridCandidate.resource.id,
          service,
          start: offGridCandidate.start,
          end: offGridCandidate.end,
          override: args.override,
        });
      } catch (err) {
        // Something concrete changed under us — taken, timed off, now
        // outside hours. That reason beats the generic one.
        if (err instanceof GetBooqinError) throw err;
        throw err;
      }

      // Still bookable, still not on the grid: the time really is one we
      // never offered (typed by hand, or off the slot_interval lattice).
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
    phone: args.phone ? normalizePhone(args.phone, settings.default_country_code) : args.phone,
    timezone: shopTimezone,
  });

  const status: BookingStatus = args.force_status ?? (settings.auto_confirm ? "confirmed" : "pending");

  // Everything above only *chose* a slot. The check and the insert were two
  // separate statements with nothing holding the slot in between, so two
  // customers clicking the last 10:00 at the same moment both passed and
  // both got booked (Phase 0's B2). From here the shop's booking-write lock
  // is held, the check is re-run on the locked connection, and the insert
  // happens before anyone else can look — see slotLock.ts for why the lock
  // is per shop and why a bare transaction would not have been enough.
  const created = await withShopBookingLock(shop, async (tx) => {
    const { roomId } = await assertSlotBookable(
      shop,
      platform,
      settings,
      { resourceId: chosen.id, service, start: localStart, end: localEnd, override: args.override },
      tx
    );

    const booking = await tx.booking.create({
      data: {
        shop,
        platform,
        uid: uid(),
        serviceId: service.id,
        resourceId: chosen.id,
        roomId,
        customerId,
        startUtc: startUtc.toJSDate(),
        endUtc: endUtc.toJSDate(),
        timezone: tzName,
        status,
        price: service.price + addonPrice,
        // Payment columns stay in the schema (no destructive migrations
        // in this trim) but nothing writes a live value into them any
        // more — merchant deposits came out with the rest of the dark
        // surfaces, so every new booking is simply "nothing to collect".
        amountDue: 0,
        currency: settings.currency,
        paymentStatus: "not_required",
        notes: args.notes ?? "",
        customFields: args.custom_fields ? JSON.stringify(args.custom_fields) : null,
        source: args.source ?? "form",
        // Denormalised from the service's capacity so the
        // Booking_resource_no_overlap constraint can tell a one-per-slot
        // booking from a seat in a class — see the schema comment.
        exclusive: Math.max(1, service.capacity) <= 1,
        createdAt: now(),
        updatedAt: now(),
      },
    });

    if (resolvedAddons.length) {
      await tx.bookingAddon.createMany({
        data: resolvedAddons.map((a) => ({
          shop,
          platform,
          bookingId: booking.id,
          addonId: a.id,
          name: a.name,
          price: a.price,
          durationMin: a.durationMin,
        })),
      });
    }

    return booking;
  });

  // Outside the transaction deliberately: handlers send email, call
  // payment gateways and offer freed slots to the waitlist. None of that
  // should hold the shop's booking lock, and none of it should be able to
  // roll the booking back.
  events.emitEvent("booking_created", created);

  return created;
}

function withinBookingWindow(startUtc: DateTime, settings: Settings): boolean {
  const nowUtc = DateTime.utc();
  const earliest = nowUtc.plus({ hours: Math.max(0, settings.min_notice_hours) });
  const latest = nowUtc.plus({ days: Math.max(1, settings.max_advance_days) });
  return startUtc >= earliest && startUtc <= latest;
}

export async function matchesSchedule(
  shop: string,
  resourceId: number,
  start: DateTime,
  end: DateTime,
  db: DbClient = prisma
): Promise<boolean> {
  const dow = start.weekday % 7;
  const count = await db.schedule.count({
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
 *
 * When `service.requiresRoom`, this also picks an actual free room and
 * returns its id — the practitioner and the room are two independently
 * double-booking-checked resources sharing one time slot (GetBooqin clinic
 * audit's RS-01 finding: previously nothing tracked room occupancy at all,
 * so two practitioners could be booked into the same physical chair).
 * `roomId: null` for every non-room-requiring service, i.e. every shop that
 * has never turned rooms on.
 */
export async function assertSlotBookable(
  shop: string,
  platform: string,
  settings: Settings,
  args: SlotCheckArgs,
  /**
   * Pass the transaction client when re-asserting under the shop's
   * booking-write lock (see slotLock.ts) — every read below has to run on
   * the same connection as the insert that follows it, or it looks at a
   * snapshot taken before the lock was granted.
   */
  db: DbClient = prisma
): Promise<{ roomId: number | null }> {
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

    if (!(await matchesSchedule(shop, resourceId, start, end, db))) {
      const dow = start.weekday % 7;
      const dayRows = await db.schedule.count({ where: { shop, resourceId, dayOfWeek: dow } });
      if (dayRows === 0) {
        throw new GetBooqinError("getbooqin_closed_day", "The business is closed that day.", 400);
      }
      throw new GetBooqinError("getbooqin_outside_hours", "That time is outside business hours.", 400);
    }
  }

  if (await Availability.isBlockedByTimeOff(shop, resourceId, startUtc, endUtc, service, db)) {
    throw new GetBooqinError("getbooqin_time_off", "That time is blocked off (time off).", 409);
  }
  if (await Availability.hasBookingConflict(shop, resourceId, startUtc, endUtc, service, excludeBookingId, db)) {
    throw new GetBooqinError("getbooqin_slot_taken", "That slot is already booked.", 409);
  }

  if (!service.requiresRoom) return { roomId: null };

  const rooms = await Data.roomsForService(shop, platform, service.id, db);
  for (const room of rooms) {
    if (!room.status) continue;
    // Same override semantics as the practitioner check above: "book
    // outside business hours anyway" skips whether the room's own weekly
    // hours cover this time, never whether the room is already occupied or
    // blocked by time off — those aren't policy, they're "this literally
    // can't happen."
    if (!override && !(await matchesSchedule(shop, room.id, start, end, db))) continue;
    if (await Availability.isBlockedByTimeOff(shop, room.id, startUtc, endUtc, service, db)) continue;
    if (await Availability.hasRoomConflict(shop, room.id, startUtc, endUtc, service, excludeBookingId, db)) continue;
    return { roomId: room.id };
  }
  throw new GetBooqinError("getbooqin_no_room", "No room is available for that time.", 409);
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

  const old = booking.status;
  // Moving back onto the calendar (un-cancelling, approving a pending
  // request) re-occupies the slot, so it races the same way a fresh
  // booking does — and it is the one path that can hit the exclusion
  // constraint without going through create() or reschedule(). Under the
  // lock, check and flip together. Every other transition (cancel,
  // complete, no-show) only ever frees a slot and needs no lock at all.
  const reoccupying =
    current !== newStatus &&
    OCCUPYING.includes(newStatus as BookingStatus) &&
    !OCCUPYING.includes(current);

  const updated = reoccupying
    ? await withShopBookingLock(shop, async (tx) => {
        await assertNoSlotConflict(shop, booking, tx);
        return tx.booking.update({ where: { id }, data: { status: newStatus, updatedAt: now() } });
      })
    : await prisma.booking.update({
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
export async function assertNoSlotConflict(shop: string, booking: Booking, db: DbClient = prisma): Promise<void> {
  const service = await Data.catalogService(shop, booking.serviceId);
  if (!service) throw new GetBooqinError("getbooqin_invalid_service", "The service for this booking no longer exists.", 400);

  const start = DateTime.fromJSDate(booking.startUtc, { zone: "utc" });
  const end = DateTime.fromJSDate(booking.endUtc, { zone: "utc" });

  if (!(await Availability.isFree(shop, booking.resourceId, start, end, service, booking.id, db))) {
    throw new GetBooqinError(
      "getbooqin_slot_taken",
      "That slot is no longer available — another booking now occupies it. Reschedule this one instead.",
      409
    );
  }
  if (booking.roomId && !(await Availability.isRoomFree(shop, booking.roomId, start, end, service, booking.id, db))) {
    throw new GetBooqinError(
      "getbooqin_slot_taken",
      "That slot is no longer available — the room is now occupied. Reschedule this one instead.",
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

  // A room-requiring booking is just as capable of drifting out of its own
  // rules as its practitioner is — the room could have been deactivated,
  // had its hours changed, or double-booked by a different practitioner
  // entirely (GetBooqin clinic audit's RS-01 finding).
  if (booking.roomId) {
    const room = await Data.resource(shop, booking.roomId);
    if (!room || !room.status) {
      reasons.push("The room for this booking no longer exists or is inactive.");
    } else {
      if (!(await matchesSchedule(shop, booking.roomId, localStart, localEnd))) {
        reasons.push("This time is outside the room's own hours.");
      }
      if (await Availability.isBlockedByTimeOff(shop, booking.roomId, startUtc, endUtc, service)) {
        reasons.push("This time falls inside the room's time-off block.");
      }
      if (await Availability.hasRoomConflict(shop, booking.roomId, startUtc, endUtc, service, booking.id)) {
        reasons.push("This overlaps another booking in the same room.");
      }
    }
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
 * Why customerCanCancel() came back false, in a sentence a customer on the
 * manage-booking page can actually act on. Before this, the page just
 * hid the cancel control with no explanation at all — including for the
 * one case a business's own settings can produce silently: a minimum
 * notice shorter than the cancellation cutoff means a booking is
 * un-cancellable from the moment it's created (min_notice_hours: 4,
 * cancel_cutoff_hours: 24 booked 9h50m out — legal to book, impossible to
 * then cancel), with "Allow customers to cancel" still switched on and
 * nothing about the 24-hour rule anywhere on the page (GetBooqin clinic
 * audit's PB-01 finding). Returns "" when cancellation is actually
 * available — callers only render this when customerCanCancel() is false.
 */
export function cancelUnavailableReason(booking: Booking, settings: Settings): string {
  if (!settings.allow_cancel) {
    return "This business has turned off online cancellation for bookings.";
  }
  if (!["pending", "confirmed"].includes(booking.status)) {
    return "";
  }
  const cutoffMs = settings.cancel_cutoff_hours * 3600 * 1000;
  if (booking.startUtc.getTime() - Date.now() <= cutoffMs) {
    return `This booking is inside the ${settings.cancel_cutoff_hours}-hour cancellation window, so it can no longer be cancelled online.`;
  }
  return "";
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
  // A first, unlocked pass purely so a rejection reports its real reason
  // (closed day / outside hours / time off / taken) before the slot-grid
  // check below, exactly as it always did. The pass that actually decides
  // the write is the locked one further down.
  await assertSlotBookable(shop, platform, settings, {
    resourceId,
    service,
    start,
    end,
    excludeBookingId: id,
    override: opts.override,
  });

  // assertSlotBookable() checks business hours/notice/time-off/conflict,
  // but never that the new time actually sits on the slot_interval lattice
  // — the reschedule panel's Time field is a bare <input type="time">, not
  // a slot picker, so staff could type e.g. 11:17 on a 15-minute-interval
  // business and it would silently save (GetBooqin clinic audit's AP-01
  // finding). Same override escape hatch as create()'s identical check —
  // a deliberate off-grid reschedule stays possible, it just can't happen
  // by accident.
  if (!opts.override && !(await slotIsPublished(shop, platform, shopTimezone, service.id, resourceId, date, time, id))) {
    throw new GetBooqinError(
      "getbooqin_slot_not_offered",
      "That time isn't one of this resource's normal slots. Check 'Book outside business hours anyway' to force it.",
      400
    );
  }

  const previous = booking;
  // Same race, same fix as create(): the checks above and the write below
  // were separate statements, so a reschedule could land on a slot someone
  // else took in between. Re-assert on the locked connection and move the
  // booking before anyone else can look. `roomId` from the pass above is
  // discarded in favour of whatever the locked pass picks — the room that
  // looked free a moment ago may not be.
  const updated = await withShopBookingLock(shop, async (tx) => {
    const locked = await assertSlotBookable(
      shop,
      platform,
      settings,
      { resourceId, service, start, end, excludeBookingId: id, override: opts.override },
      tx
    );

    return tx.booking.update({
      where: { id },
      data: {
        resourceId,
        roomId: locked.roomId,
        startUtc: sUtc.toJSDate(),
        endUtc: eUtc.toJSDate(),
        timezone: tz,
        reminderSent: false,
        updatedAt: now(),
      },
    });
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
export async function occupyingBetween(
  shop: string,
  platform: string,
  resourceId: number,
  start: Date,
  end: Date,
  opts: { statusIn?: string[] } = {}
) {
  return prisma.booking.findMany({
    where: {
      shop,
      platform,
      ...(resourceId ? { resourceId } : {}),
      status: { in: opts.statusIn ?? OCCUPYING },
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

export function manageUrl(booking: Booking, settings: Settings): string {
  const base = settings.booking_page_url || "/";
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}getbooqin_booking=${booking.uid}`;
}

export function bookingTerm(settings: Settings): string {
  return term(settings, "booking_single");
}

export { money };
