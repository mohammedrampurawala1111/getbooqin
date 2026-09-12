/**
 * Metrics for the standalone dashboard's overview screen. New in Prompt 4 —
 * the embedded admin's Dashboard (shopify-openslot/app/routes/app._index.tsx)
 * only ever computed four ad-hoc counters (next-7-days count, pending count,
 * a `prisma.booking.findMany` + JS `.reduce` over `amountDue` for "revenue
 * this month", and two raw counts for services/resources) — no time-series
 * or breakdown query exists anywhere to port, so this is built fresh.
 *
 * The revenue and payment-status aggregates came out with merchant
 * deposits in Phase 1's trim: nothing in the product can settle a payment
 * any more, so both would only ever report zeroes. The `Payment` table
 * and `Booking.paymentStatus` stay (no destructive migrations), so
 * whatever re-introduces deposits can bring the queries back with them.
 */
import { DateTime } from "luxon";
import prisma from "../db.js";

export interface DateRange {
  from: Date;
  to: Date;
}

export async function bookingsOverTime(shop: string, platform: string, range: DateRange): Promise<Array<{ date: string; count: number }>> {
  const rows = await prisma.booking.findMany({
    where: { shop, platform, startUtc: { gte: range.from, lte: range.to } },
    select: { startUtc: true },
  });

  const byDay = new Map<string, number>();
  for (const row of rows) {
    const key = DateTime.fromJSDate(row.startUtc, { zone: "utc" }).toFormat("yyyy-MM-dd");
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }

  const out: Array<{ date: string; count: number }> = [];
  let day = DateTime.fromJSDate(range.from, { zone: "utc" }).startOf("day");
  const end = DateTime.fromJSDate(range.to, { zone: "utc" }).startOf("day");
  while (day <= end) {
    const key = day.toFormat("yyyy-MM-dd");
    out.push({ date: key, count: byDay.get(key) ?? 0 });
    day = day.plus({ days: 1 });
  }
  return out;
}

export async function topServices(
  shop: string,
  platform: string,
  range: DateRange,
  limit = 5
): Promise<Array<{ serviceId: number; name: string; bookings: number }>> {
  const grouped = await prisma.booking.groupBy({
    by: ["serviceId"],
    where: { shop, platform, startUtc: { gte: range.from, lte: range.to } },
    _count: { serviceId: true },
    orderBy: { _count: { serviceId: "desc" } },
    take: limit,
  });
  if (grouped.length === 0) return [];

  const configs = await prisma.serviceConfig.findMany({ where: { id: { in: grouped.map((g) => g.serviceId) } } });
  const products = await prisma.productCache.findMany({
    where: { shop, platform, productId: { in: configs.map((c) => c.productId) } },
  });
  const productByProductId = new Map(products.map((p) => [p.productId, p]));
  const nameByServiceId = new Map(configs.map((c) => [c.id, productByProductId.get(c.productId)?.title ?? ""]));

  return grouped.map((g) => ({
    serviceId: g.serviceId,
    name: nameByServiceId.get(g.serviceId) ?? "",
    bookings: g._count.serviceId,
  }));
}

/** Booked-minutes ÷ available-minutes per resource, walking each day in range against its weekly schedule. */
export interface UtilizationHalf {
  bookedMinutes: number;
  availableMinutes: number;
  utilization: number;
}

function makeHalf(bookedMinutes: number, availableMinutes: number): UtilizationHalf {
  return { bookedMinutes, availableMinutes, utilization: availableMinutes > 0 ? Math.min(1, bookedMinutes / availableMinutes) : 0 };
}

/**
 * Split at `now` rather than reporting one number for the whole range —
 * a range that's entirely in the future (a business's very next few
 * consultations, all still ahead of it) made the elapsed-only fix read as
 * a permanent, confident 0.0% with no way to tell "nothing happened yet"
 * apart from "nothing was ever booked" (Defect Dossier's R2-07 finding,
 * the direct follow-on from BQ-35's own elapsed-time fix). `soFar` is
 * `null` when no part of the range has elapsed yet, so the card can hide
 * that half instead of showing a 0.0% that means nothing.
 */
export async function resourceUtilization(
  shop: string,
  platform: string,
  range: DateRange
): Promise<Array<{ resourceId: number; resourceName: string; soFar: UtilizationHalf | null; bookedAhead: UtilizationHalf }>> {
  // kind: "practitioner" — Overview's own heading reads "{Practitioner}
  // utilisation", a claim a room's own hours would confuse rather than
  // support (GetBooqin clinic audit's RS-01 finding). Room utilization
  // would be a real, separate metric worth adding later, not this one.
  const resources = await prisma.resource.findMany({ where: { shop, platform, status: true, kind: "practitioner" } });
  if (resources.length === 0) return [];

  const now = new Date();
  const hasElapsed = range.from < now;
  const hasFuture = range.to > now;

  const resourceIds = resources.map((r) => r.id);
  const [scheduleRows, bookingRows] = await Promise.all([
    prisma.schedule.findMany({ where: { shop, resourceId: { in: resourceIds } } }),
    prisma.booking.findMany({
      where: {
        shop,
        platform,
        resourceId: { in: resourceIds },
        status: { in: ["confirmed", "completed"] },
        startUtc: { gte: range.from },
        endUtc: { lte: range.to },
      },
      select: { resourceId: true, startUtc: true, endUtc: true },
    }),
  ]);

  const scheduleByResource = new Map<number, typeof scheduleRows>();
  for (const row of scheduleRows) {
    const list = scheduleByResource.get(row.resourceId) ?? [];
    list.push(row);
    scheduleByResource.set(row.resourceId, list);
  }

  const bookedByResource = new Map<number, { soFar: number; bookedAhead: number }>();
  for (const b of bookingRows) {
    const minutes = (b.endUtc.getTime() - b.startUtc.getTime()) / 60_000;
    const bucket = bookedByResource.get(b.resourceId) ?? { soFar: 0, bookedAhead: 0 };
    if (b.startUtc < now) bucket.soFar += minutes;
    else bucket.bookedAhead += minutes;
    bookedByResource.set(b.resourceId, bucket);
  }

  const availableByResource = new Map<number, { soFar: number; bookedAhead: number }>();
  for (const r of resources) {
    const windows = scheduleByResource.get(r.id) ?? [];
    const bucket = { soFar: 0, bookedAhead: 0 };
    let day = DateTime.fromJSDate(range.from, { zone: "utc" }).startOf("day");
    const end = DateTime.fromJSDate(range.to, { zone: "utc" }).startOf("day");
    const nowDay = DateTime.fromJSDate(now, { zone: "utc" }).startOf("day");
    while (day <= end) {
      const dow = day.weekday % 7;
      let dayMinutes = 0;
      for (const w of windows) {
        if (w.dayOfWeek !== dow) continue;
        const [sh, sm] = w.startTime.split(":").map(Number);
        const [eh, em] = w.endTime.split(":").map(Number);
        dayMinutes += eh * 60 + em - (sh * 60 + sm);
      }
      if (day < nowDay) bucket.soFar += dayMinutes;
      else bucket.bookedAhead += dayMinutes;
      day = day.plus({ days: 1 });
    }
    availableByResource.set(r.id, bucket);
  }

  return resources.map((r) => {
    const booked = bookedByResource.get(r.id) ?? { soFar: 0, bookedAhead: 0 };
    const available = availableByResource.get(r.id) ?? { soFar: 0, bookedAhead: 0 };
    return {
      resourceId: r.id,
      resourceName: r.name,
      soFar: hasElapsed ? makeHalf(booked.soFar, available.soFar) : null,
      bookedAhead: makeHalf(booked.bookedAhead, hasFuture ? available.bookedAhead : 0),
    };
  });
}

/** No-shows as a fraction of appointments that actually happened (completed + no_show) — not of every booking ever made, since pending/cancelled bookings were never a "show" opportunity. */
export async function noShowRate(shop: string, platform: string, range: DateRange): Promise<{ noShow: number; total: number; rate: number }> {
  const [noShow, total] = await Promise.all([
    prisma.booking.count({ where: { shop, platform, status: "no_show", startUtc: { gte: range.from, lte: range.to } } }),
    prisma.booking.count({
      where: { shop, platform, status: { in: ["completed", "no_show"] }, startUtc: { gte: range.from, lte: range.to } },
    }),
  ]);
  return { noShow, total, rate: total > 0 ? noShow / total : 0 };
}

/** Everything the dashboard's overview screen needs for one render, so metrics are visible on first login without N separate round trips from the route. */
export async function overview(shop: string, platform: string, range: DateRange) {
  const [bookingsSeries, top, utilization, noShow] = await Promise.all([
    bookingsOverTime(shop, platform, range),
    topServices(shop, platform, range),
    resourceUtilization(shop, platform, range),
    noShowRate(shop, platform, range),
  ]);
  return { bookingsSeries, topServices: top, resourceUtilization: utilization, noShow };
}
