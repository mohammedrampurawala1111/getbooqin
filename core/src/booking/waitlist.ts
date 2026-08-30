/**
 * Waitlist: join by service (+ optional specific resource) and a preferred
 * date window; when a booking's slot frees up early, offer it to the
 * longest-waiting matching entry with a time-boxed claim window instead of
 * silently reopening the slot. See core/prisma/schema.prisma's Waitlist
 * model and events.ts's booking_slot_freed for the trigger.
 *
 * v1 is admin-entered join (a staff member adds a customer, same as taking
 * a waitlist request by phone) + a public claim link — no self-service
 * "join the waitlist" button on the storefront widget yet (that's a
 * separate follow-up touching extensions/getbooqin-widgets).
 */
import { DateTime } from "luxon";
import type { Booking, Waitlist } from "@prisma/client";
import prisma from "../db.js";
import * as Data from "./data.js";
import * as Availability from "./availability.js";
import * as Bookings from "./bookings.js";
import { getSettings } from "./settings.js";
import { isEmail, validDate } from "./bookingsShared.js";
import { uid, now } from "./ids.js";
import { GetBooqinError } from "./errors.js";
import events, { type FreedSlot } from "./events.js";

export interface JoinWaitlistArgs {
  service_id: number;
  resource_id?: number; // 0/omitted = any resource for the service
  window_start?: string; // yyyy-MM-dd, defaults to today (shop-local)
  window_end?: string; // yyyy-MM-dd, optional — omitted = no upper bound
  first_name: string;
  last_name?: string;
  email: string;
  phone?: string;
  notes?: string;
}

export async function join(shop: string, platform: string, shopTimezone: string, args: JoinWaitlistArgs): Promise<Waitlist> {
  const service = await Data.catalogService(shop, args.service_id);
  if (!service || !service.status) throw new GetBooqinError("getbooqin_invalid_service", "That service is not available.", 400);
  if (!isEmail(args.email)) throw new GetBooqinError("getbooqin_invalid_email", "Please provide a valid email address.", 400);
  if (!args.first_name) throw new GetBooqinError("getbooqin_missing_name", "Please provide the customer's name.", 400);

  const tz = shopTimezone || "UTC";
  const windowStart =
    args.window_start && validDate(args.window_start)
      ? DateTime.fromISO(args.window_start, { zone: tz }).startOf("day")
      : DateTime.now().setZone(tz).startOf("day");
  const windowEnd =
    args.window_end && validDate(args.window_end) ? DateTime.fromISO(args.window_end, { zone: tz }).endOf("day") : null;

  const customerId = await Data.findOrCreateCustomer(shop, platform, {
    first_name: args.first_name,
    last_name: args.last_name,
    email: args.email,
    phone: args.phone,
    timezone: shopTimezone,
  });

  return prisma.waitlist.create({
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

  const candidates = await prisma.waitlist.findMany({
    where: {
      shop,
      platform,
      serviceId: freed.serviceId,
      status: "waiting",
      windowStartUtc: { lte: freed.startUtc },
      AND: [
        { OR: [{ resourceId: 0 }, { resourceId: freed.resourceId }] },
        { OR: [{ windowEndUtc: null }, { windowEndUtc: { gte: freed.startUtc } }] },
      ],
    },
    orderBy: { createdAt: "asc" },
  });

  for (const candidate of candidates) {
    const startUtc = DateTime.fromJSDate(freed.startUtc, { zone: "utc" });
    const endUtc = DateTime.fromJSDate(freed.endUtc, { zone: "utc" });
    if (!(await Availability.isFree(shop, freed.resourceId, startUtc, endUtc, service))) continue;

    const offerExpiresAt = DateTime.utc().plus({ hours: Math.max(0.1, settings.waitlist_offer_window_hours) }).toJSDate();
    const claimedLock = await prisma.waitlist.updateMany({
      where: { id: candidate.id, status: "waiting" },
      data: {
        status: "offered",
        offerToken: uid(),
        offeredResourceId: freed.resourceId,
        offeredStartUtc: freed.startUtc,
        offeredEndUtc: freed.endUtc,
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
