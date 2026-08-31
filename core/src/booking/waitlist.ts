/**
 * Waitlist: join by service (+ optional specific resource) and either a
 * preferred date window or one exact slot time; when a booking's slot
 * frees up early, offer it to the longest-waiting matching entry with a
 * time-boxed claim window instead of silently reopening the slot. See
 * core/prisma/schema.prisma's Waitlist model and events.ts's
 * booking_slot_freed for the trigger.
 *
 * Two join shapes, both landing in the same windowStartUtc/windowEndUtc
 * columns:
 *  - Whole-day: window_start (+ optional window_end) alone — "notify me of
 *    anything this day/range". Used when a day has zero slots at all
 *    (extensions/getbooqin-widgets/assets/booking.js's renderWaitlistJoin).
 *  - One exact slot: window_start + time together collapse windowStart and
 *    windowEnd to the same instant, so matchAndOffer() below only ever
 *    matches a freed slot starting at exactly that moment. Used when a
 *    specific already-taken time is blocked but the day otherwise has
 *    openings (booking.js's per-slot "join waitlist for this time").
 */
import { DateTime } from "luxon";
import type { Booking, Waitlist } from "@prisma/client";
import type { CatalogService } from "./data.js";
import prisma from "../db.js";
import * as Data from "./data.js";
import * as Availability from "./availability.js";
import * as Bookings from "./bookings.js";
import { getSettings } from "./settings.js";
import { isEmail, validDate, validTime } from "./bookingsShared.js";
import { uid, now } from "./ids.js";
import { GetBooqinError } from "./errors.js";
import events, { type FreedSlot } from "./events.js";

export interface JoinWaitlistArgs {
  service_id: number;
  resource_id?: number; // 0/omitted = any resource for the service
  window_start?: string; // yyyy-MM-dd, defaults to today (shop-local)
  window_end?: string; // yyyy-MM-dd, optional — omitted = no upper bound. Ignored when time is given.
  time?: string; // HH:mm, shop/resource-local — with window_start, narrows to that one exact slot instead of the whole day
  first_name: string;
  last_name?: string;
  email: string;
  phone?: string;
  notes?: string;
}

/**
 * A waitlist join is only meaningful for a slot/day that the schedule
 * itself would actually withdraw or leave empty — otherwise the entry can
 * never fire, because no cancellation ever frees something that was never
 * bookable. Reuses the exact same slot generation and day-state
 * classification the booking path and calendar already render from, so
 * this can never drift into disagreeing with what a customer was shown.
 */
async function assertJoinable(
  shop: string,
  platform: string,
  shopTimezone: string,
  service: CatalogService,
  resourceIdInput: number,
  date: string,
  time: string | undefined
): Promise<void> {
  const [year, month] = date.split("-").map(Number);
  const monthDays = await Availability.daysInMonth(shop, platform, shopTimezone, service.id, resourceIdInput, year, month);
  const day = monthDays.find((d) => d.date === date);

  if (!day || day.state === "past" || day.state === "out_of_range") {
    throw new GetBooqinError("getbooqin_date_past", "That date is not open for booking.", 400);
  }
  if (day.state === "closed") {
    throw new GetBooqinError("getbooqin_day_closed", "The business is not open that day.", 400);
  }

  if (!time) {
    // Whole-day join: "full" (a real working day, currently nothing open)
    // is the only state a waitlist makes sense for — "open" means slots
    // exist and the customer should book one directly instead of queuing.
    if (day.state === "open") {
      throw new GetBooqinError(
        "getbooqin_slot_available",
        "This day still has open times — please book one directly instead of joining the waitlist.",
        400
      );
    }
    return;
  }

  // Per-slot join: resolve to one concrete resource the same way
  // Availability.slots' includeBlocked does — a "this exact slot is
  // blocked" answer only means one thing when exactly one resource is in
  // play. With more than one candidate and none specified, there's no
  // single coherent answer (busy for A, free for B is just available).
  const candidates = resourceIdInput
    ? [await Data.resource(shop, resourceIdInput)].filter((r): r is NonNullable<typeof r> => !!r)
    : await Data.resourcesForService(shop, platform, service.id);
  const resourceId = candidates.length === 1 ? candidates[0].id : resourceIdInput;
  if (!resourceId) {
    throw new GetBooqinError(
      "getbooqin_slot_not_offered",
      "Please choose a specific staff member to join the waitlist for one time.",
      400
    );
  }

  const daySlots = await Availability.slots(shop, platform, shopTimezone, service.id, resourceId, date, 0, 0, true);
  const match = daySlots.find((s) => s.time === time);
  if (!match) {
    throw new GetBooqinError("getbooqin_slot_not_offered", "That is not a bookable time for this service.", 400);
  }
  if (match.available) {
    throw new GetBooqinError(
      "getbooqin_slot_available",
      "That time is currently available — please book it directly instead of joining the waitlist.",
      400
    );
  }
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

export async function join(shop: string, platform: string, shopTimezone: string, args: JoinWaitlistArgs): Promise<Waitlist> {
  const service = await Data.catalogService(shop, args.service_id);
  if (!service || !service.status) throw new GetBooqinError("getbooqin_invalid_service", "That service is not available.", 400);
  if (!isEmail(args.email)) throw new GetBooqinError("getbooqin_invalid_email", "Please provide a valid email address.", 400);
  if (!args.first_name) throw new GetBooqinError("getbooqin_missing_name", "Please provide the customer's name.", 400);

  const tz = shopTimezone || "UTC";
  let windowStart: DateTime;
  let windowEnd: DateTime | null;
  const isPerSlot = !!(args.window_start && validDate(args.window_start) && args.time && validTime(args.time));

  if (isPerSlot) {
    const exact = DateTime.fromISO(`${args.window_start}T${args.time}:00`, { zone: tz });
    if (!exact.isValid) throw new GetBooqinError("getbooqin_invalid_slot", "Please choose a valid date and time.", 400);
    windowStart = exact;
    windowEnd = exact;
  } else {
    if (args.window_start && !validDate(args.window_start)) {
      throw new GetBooqinError("getbooqin_invalid_slot", "Please choose a valid date.", 400);
    }
    windowStart = args.window_start
      ? DateTime.fromISO(args.window_start, { zone: tz }).startOf("day")
      : DateTime.now().setZone(tz).startOf("day");
    windowEnd = args.window_end && validDate(args.window_end) ? DateTime.fromISO(args.window_end, { zone: tz }).endOf("day") : null;
  }

  await assertJoinable(shop, platform, shopTimezone, service, args.resource_id || 0, windowStart.toFormat("yyyy-MM-dd"), isPerSlot ? args.time : undefined);

  const customerId = await Data.findOrCreateCustomer(shop, platform, {
    first_name: args.first_name,
    last_name: args.last_name,
    email: args.email,
    phone: args.phone,
    timezone: shopTimezone,
  });

  const dedupeWhere = {
    shop,
    platform,
    serviceId: args.service_id,
    resourceId: args.resource_id || 0,
    windowStartUtc: windowStart.toUTC().toJSDate(),
    customerId,
    status: { in: ["waiting", "offered"] as string[] },
  };

  // A repeat join (same person, same service/resource/slot) satisfies the
  // customer's intent exactly as well as a fresh row would — surfacing it
  // as a duplicate-key error, or silently creating a second entry that
  // means the same person gets offered the same slot twice, are both worse
  // than just handing back what they already have.
  const existing = await prisma.waitlist.findFirst({ where: dedupeWhere });
  if (existing) return existing;

  try {
    return await prisma.waitlist.create({
      data: {
        shop,
        platform,
        uid: uid(),
        serviceId: args.service_id,
        resourceId: args.resource_id || 0,
        customerId,
        windowStartUtc: windowStart.toUTC().toJSDate(),
        windowEndUtc: windowEnd ? windowEnd.toUTC().toJSDate() : null,
        notes: args.notes ?? "",
      },
    });
  } catch (err) {
    // Lost a race against another request for the same join between the
    // check above and this insert — the partial unique index (see the
    // add_waitlist_dedupe migration) is what actually guarantees no
    // duplicate, this is just resolving the resulting conflict the same
    // way the pre-check would have.
    if (isUniqueConstraintViolation(err)) {
      const raced = await prisma.waitlist.findFirst({ where: dedupeWhere });
      if (raced) return raced;
    }
    throw err;
  }
}

export interface WaitlistQueryArgs {
  status?: string;
  serviceId?: number;
}

export function list(shop: string, platform: string, args: WaitlistQueryArgs = {}) {
  return prisma.waitlist.findMany({
    where: {
      shop,
      platform,
      ...(args.status ? { status: args.status } : {}),
      ...(args.serviceId ? { serviceId: args.serviceId } : {}),
    },
    include: { service: true, customer: true },
    orderBy: { createdAt: "desc" },
  });
}

/** Withdraw a still-active entry. Silently a no-op if it's already claimed/expired/cancelled. */
export async function leave(shop: string, id: number): Promise<void> {
  await prisma.waitlist.updateMany({
    where: { shop, id, status: { in: ["waiting", "offered"] } },
    data: { status: "cancelled", updatedAt: now() },
  });
}

/** Powers the public claim page's loader. */
export function getByToken(shop: string, token: string) {
  return prisma.waitlist.findFirst({ where: { shop, offerToken: token }, include: { service: true, customer: true } });
}

/**
 * FIFO-matches a freed slot against waiting entries for that service
 * (resourceId 0 = any resource, otherwise must match) whose preferred
 * window covers it, and makes a time-boxed offer to the first one that
 * still checks out. Optimistic (waiting -> offered) claim on the row itself
 * is what makes this race-safe against a concurrent offer for the same
 * entry — Postgres's row lock on that single UPDATE is the only
 * synchronization needed, no explicit locking.
 */
export async function matchAndOffer(shop: string, platform: string, freed: FreedSlot): Promise<Waitlist | null> {
  if (freed.startUtc.getTime() <= Date.now()) return null;

  const settings = await getSettings(shop, platform);
  if (!settings.waitlist_enabled) return null;

  const service = await Data.catalogService(shop, freed.serviceId);
  if (!service) return null;

  // Deliberately broad at the SQL level — a per-slot entry's own
  // [windowStart, windowStart+duration) can overlap the freed window
  // without windowStart itself falling inside it. Freeing an 11:00-11:45
  // booking (45-minute service) also clears a 10:30 start (runs to 11:15)
  // and an 11:30 start (runs to 12:15); an entry waiting on either of those
  // exact times has windowStartUtc outside [11:00, 11:45) and would never
  // have matched the old windowStartUtc<=freed.start<=windowEndUtc filter.
  // Precise overlap is computed per-candidate below instead.
  const candidates = await prisma.waitlist.findMany({
    where: {
      shop,
      platform,
      serviceId: freed.serviceId,
      status: "waiting",
      OR: [{ resourceId: 0 }, { resourceId: freed.resourceId }],
    },
    orderBy: { createdAt: "asc" },
  });

  for (const candidate of candidates) {
    const isPerSlot = !!candidate.windowEndUtc && candidate.windowStartUtc.getTime() === candidate.windowEndUtc.getTime();

    let offerStartJs: Date;
    let offerEndJs: Date;
    if (isPerSlot) {
      // Their own requested slot, not necessarily the freed booking's own
      // span — offer what they actually asked for.
      offerStartJs = candidate.windowStartUtc;
      offerEndJs = new Date(candidate.windowStartUtc.getTime() + service.durationMin * 60_000);
      const overlaps = offerStartJs.getTime() < freed.endUtc.getTime() && offerEndJs.getTime() > freed.startUtc.getTime();
      if (!overlaps) continue;
    } else {
      // Whole-day/range entry: didn't ask for one specific time, just that
      // something in range opened up — the freed slot itself is the offer.
      if (candidate.windowStartUtc.getTime() > freed.startUtc.getTime()) continue;
      if (candidate.windowEndUtc && candidate.windowEndUtc.getTime() < freed.startUtc.getTime()) continue;
      offerStartJs = freed.startUtc;
      offerEndJs = freed.endUtc;
    }

    const startUtc = DateTime.fromJSDate(offerStartJs, { zone: "utc" });
    const endUtc = DateTime.fromJSDate(offerEndJs, { zone: "utc" });
    if (startUtc.toMillis() <= Date.now()) continue;
    if (!(await Availability.isFree(shop, freed.resourceId, startUtc, endUtc, service))) continue;

    const offerExpiresAt = DateTime.utc().plus({ hours: Math.max(0.1, settings.waitlist_offer_window_hours) }).toJSDate();
    const claimedLock = await prisma.waitlist.updateMany({
      where: { id: candidate.id, status: "waiting" },
      data: {
        status: "offered",
        offerToken: uid(),
        offeredResourceId: freed.resourceId,
        offeredStartUtc: offerStartJs,
        offeredEndUtc: offerEndJs,
        offerExpiresAt,
        offerCount: { increment: 1 },
        updatedAt: now(),
      },
    });
    if (claimedLock.count === 0) continue; // lost the race — another process already moved this entry

    const offered = await prisma.waitlist.findUniqueOrThrow({ where: { id: candidate.id } });
    events.emitEvent("waitlist_offered", offered);
    return offered;
  }

  return null;
}

/** Re-offers the same freed slot to the next matching candidate — used when an offer expires or a claim loses a race. */
async function cascade(shop: string, platform: string, entry: Waitlist): Promise<void> {
  if (entry.offeredResourceId == null || !entry.offeredStartUtc || !entry.offeredEndUtc) return;
  await matchAndOffer(shop, platform, {
    shop,
    platform,
    serviceId: entry.serviceId,
    resourceId: entry.offeredResourceId,
    startUtc: entry.offeredStartUtc,
    endUtc: entry.offeredEndUtc,
  });
}

/** Turns an active offer into a real booking. Throws GetBooqinError on an expired/already-resolved offer or a lost slot race. */
export async function claim(shop: string, platform: string, shopTimezone: string, token: string): Promise<Booking> {
  const entry = await prisma.waitlist.findFirst({ where: { shop, offerToken: token } });
  if (!entry) throw new GetBooqinError("getbooqin_not_found", "This waitlist offer was not found.", 404);
  if (entry.status !== "offered") {
    throw new GetBooqinError(
      "getbooqin_waitlist_unavailable",
      "This offer is no longer available — it may already have been claimed or withdrawn.",
      409
    );
  }
  if (!entry.offerExpiresAt || entry.offerExpiresAt.getTime() < Date.now()) {
    throw new GetBooqinError("getbooqin_waitlist_expired", "This offer has expired.", 410);
  }

  const service = await Data.catalogService(shop, entry.serviceId);
  if (!service) throw new GetBooqinError("getbooqin_invalid_service", "That service is no longer available.", 400);

  const resourceId = entry.offeredResourceId!;
  const startUtc = DateTime.fromJSDate(entry.offeredStartUtc!, { zone: "utc" });
  const endUtc = DateTime.fromJSDate(entry.offeredEndUtc!, { zone: "utc" });

  if (!(await Availability.isFree(shop, resourceId, startUtc, endUtc, service))) {
    await prisma.waitlist.updateMany({ where: { id: entry.id, status: "offered" }, data: { status: "expired", updatedAt: now() } });
    await cascade(shop, platform, entry);
    throw new GetBooqinError("getbooqin_slot_taken", "Sorry, that slot was just taken. We've offered it to the next person on the list.", 409);
  }

  const claimedLock = await prisma.waitlist.updateMany({
    where: { id: entry.id, status: "offered" },
    data: { status: "claimed", updatedAt: now() },
  });
  if (claimedLock.count === 0) {
    throw new GetBooqinError("getbooqin_waitlist_unavailable", "This offer was just claimed or withdrawn.", 409);
  }

  const customer = await prisma.customer.findFirst({ where: { shop, id: entry.customerId } });
  if (!customer) throw new GetBooqinError("getbooqin_not_found", "Customer no longer exists.", 404);

  const resource = await Data.resource(shop, resourceId);
  const tz = Availability.businessTz(shopTimezone, resource);
  const local = startUtc.setZone(tz);

  try {
    const booking = await Bookings.create(shop, platform, shopTimezone, {
      service_id: entry.serviceId,
      resource_id: resourceId,
      date: local.toFormat("yyyy-MM-dd"),
      time: local.toFormat("HH:mm"),
      first_name: customer.firstName || "Guest",
      last_name: customer.lastName,
      email: customer.email,
      phone: customer.phone,
      source: "waitlist",
    });

    await prisma.waitlist.update({ where: { id: entry.id }, data: { resultingBookingId: booking.id } });
    const fresh = await prisma.waitlist.findUniqueOrThrow({ where: { id: entry.id } });
    events.emitEvent("waitlist_claimed", fresh, booking);
    return booking;
  } catch (err) {
    // Bookings.create() re-checks availability itself and lost a genuine
    // race (e.g. a direct booking grabbed it between our check above and
    // this call) — this is the same TOCTOU exposure ordinary bookings
    // already have, not a new one. Release this entry and cascade.
    await prisma.waitlist.update({ where: { id: entry.id }, data: { status: "expired" } });
    await cascade(shop, platform, entry);
    throw err;
  }
}

/** Expiry sweep for a scheduler to call periodically — see shopify-openslot's cron.waitlist.tsx. */
export async function expireStaleOffers(limit = 100): Promise<{ expired: number; cascaded: number }> {
  const stale = await prisma.waitlist.findMany({
    where: { status: "offered", offerExpiresAt: { lt: now() } },
    take: limit,
    orderBy: { offerExpiresAt: "asc" },
  });

  let expired = 0;
  let cascaded = 0;

  for (const entry of stale) {
    const claimedLock = await prisma.waitlist.updateMany({
      where: { id: entry.id, status: "offered" },
      data: { status: "expired", updatedAt: now() },
    });
    if (claimedLock.count === 0) continue; // claimed or withdrawn concurrently — nothing to expire

    expired++;
    const fresh = await prisma.waitlist.findUniqueOrThrow({ where: { id: entry.id } });
    events.emitEvent("waitlist_expired", fresh);

    if (entry.offeredResourceId != null && entry.offeredStartUtc && entry.offeredEndUtc) {
      const next = await matchAndOffer(entry.shop, entry.platform, {
        shop: entry.shop,
        platform: entry.platform,
        serviceId: entry.serviceId,
        resourceId: entry.offeredResourceId,
        startUtc: entry.offeredStartUtc,
        endUtc: entry.offeredEndUtc,
      });
      if (next) cascaded++;
    }
  }

  return { expired, cascaded };
}

export function init() {
  events.onEvent("booking_slot_freed", (freed) => {
    matchAndOffer(freed.shop, freed.platform, freed).catch((err) =>
      console.error(`[getbooqin waitlist] matchAndOffer failed for shop ${freed.shop}:`, err)
    );
  });
}
