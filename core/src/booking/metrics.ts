/**
 * Metrics for the standalone dashboard's overview screen. New in Prompt 4 —
 * the embedded admin's Dashboard (shopify-openslot/app/routes/app._index.tsx)
 * only ever computed four ad-hoc counters (next-7-days count, pending count,
 * a `prisma.booking.findMany` + JS `.reduce` over `amountDue` for "revenue
 * this month", and two raw counts for services/resources) — no time-series
 * or breakdown query exists anywhere to port, so this is built fresh.
 *
 * Revenue is aggregated from `Payment` rows (grouped by currency), not by
 * summing `Booking.amountDue` for `paymentStatus === "paid"` bookings the
 * way the embedded admin's stat does — that shortcut silently mixes
 * currencies together and only reflects what a booking *owed*, not what a
 * gateway actually reported as settled.
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

/** Settled revenue, grouped by currency since a shop can take payments in more than one. */
export async function revenue(shop: string, platform: string, range: DateRange): Promise<Array<{ currency: string; amount: number }>> {
  const rows = await prisma.payment.groupBy({
    by: ["currency"],
    where: { shop, platform, status: "paid", createdAt: { gte: range.from, lte: range.to } },
    _sum: { amount: true },
  });
  return rows.map((r) => ({ currency: r.currency, amount: r._sum.amount ?? 0 }));
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
export async function resourceUtilization(
  shop: string,
  platform: string,
  range: DateRange
): Promise<Array<{ resourceId: number; resourceName: string; bookedMinutes: number; availableMinutes: number; utilization: number }>> {
  const resources = await prisma.resource.findMany({ where: { shop, platform, status: true } });
  if (resources.length === 0) return [];

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

  const bookedMinutesByResource = new Map<number, number>();
  for (const b of bookingRows) {
    const minutes = (b.endUtc.getTime() - b.startUtc.getTime()) / 60_000;
    bookedMinutesByResource.set(b.resourceId, (bookedMinutesByResource.get(b.resourceId) ?? 0) + minutes);
  }

  return resources.map((r) => {
    const windows = scheduleByResource.get(r.id) ?? [];
    let availableMinutes = 0;
    let day = DateTime.fromJSDate(range.from, { zone: "utc" }).startOf("day");
    const end = DateTime.fromJSDate(range.to, { zone: "utc" }).startOf("day");
    while (day <= end) {
      const dow = day.weekday % 7;
      for (const w of windows) {
        if (w.dayOfWeek !== dow) continue;
        const [sh, sm] = w.startTime.split(":").map(Number);
        const [eh, em] = w.endTime.split(":").map(Number);
        availableMinutes += eh * 60 + em - (sh * 60 + sm);
      }
      day = day.plus({ days: 1 });
    }

    const bookedMinutes = bookedMinutesByResource.get(r.id) ?? 0;
    return {
      resourceId: r.id,
      resourceName: r.name,
      bookedMinutes,
      availableMinutes,
      utilization: availableMinutes > 0 ? Math.min(1, bookedMinutes / availableMinutes) : 0,
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

export async function paymentStatusBreakdown(shop: string, platform: string, range: DateRange): Promise<Array<{ status: string; count: number }>> {
  const rows = await prisma.booking.groupBy({
    by: ["paymentStatus"],
    where: { shop, platform, startUtc: { gte: range.from, lte: range.to } },
    _count: { paymentStatus: true },
  });
  return rows.map((r) => ({ status: r.paymentStatus, count: r._count.paymentStatus }));
}

/** Everything the dashboard's overview screen needs for one render, so metrics are visible on first login without N separate round trips from the route. */
export async function overview(shop: string, platform: string, range: DateRange) {
  const [bookingsSeries, revenueByCurrency, top, utilization, noShow, paymentBreakdown] = await Promise.all([
    bookingsOverTime(shop, platform, range),
    revenue(shop, platform, range),
    topServices(shop, platform, range),
    resourceUtilization(shop, platform, range),
    noShowRate(shop, platform, range),
    paymentStatusBreakdown(shop, platform, range),
  ]);
  return { bookingsSeries, revenueByCurrency, topServices: top, resourceUtilization: utilization, noShow, paymentBreakdown };
}
