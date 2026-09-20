/**
 * Metrics for the standalone dashboard's overview screen. New in Prompt 4 —
 * the embedded admin's Dashboard (shopify-openslot/app/routes/app._index.tsx)
 * only ever computed four ad-hoc counters (next-7-days count, pending count,
 * a `prisma.booking.findMany` + JS `.reduce` over `amountDue` for "revenue
 * this month", and two raw counts for services/resources) — no time-series
 * or breakdown query exists anywhere to port, so this is built fresh.
 *
 * The revenue and payment-status aggregates came out with merchant
 * deposits in Phase 1's trim, because nothing in the product could
 * settle a payment any more and both would have reported zeroes for
 * ever. They are back as `money()` below, against the lighter
 * direct-to-merchant collection that replaced deposits — and they are
 * deliberately not called revenue. See that function.
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

/* ------------------------------------------------------------------ */
/* Money                                                               */
/* ------------------------------------------------------------------ */

/**
 * What the merchant has been paid, as far as anybody has told us.
 *
 * ## It is not revenue and must never be labelled as one
 *
 * GetBooqin is not in these transactions. The customer pays the
 * merchant directly over UPI or PayPal.me, and `Payment.status` becomes
 * `paid` because **a person clicked a button** — the UTR a customer
 * quotes is evidence to match against a bank statement, not proof
 * anything arrived.
 *
 * Two things follow, and both belong on the screen rather than only
 * here. The figure is a *floor*, not a total: a customer who pays cash
 * and is never recorded is invisible to us. And it is not an accounting
 * number — the moment a merchant takes it to their accountant, the gap
 * between "someone ticked this" and "money arrived" becomes their
 * problem and our fault.
 *
 * ## Which method is not a setting we read — it is what happened
 *
 * `availableMethod()` routes by region: an Indian merchant with a UPI
 * id collects over UPI, everyone else over PayPal.me. But a merchant
 * can change that, and bookings taken under the old arrangement do not
 * move. So the breakdown is built from the methods actually recorded,
 * which is what lets the dashboard show a UPI merchant UPI, a PayPal
 * merchant PayPal, and a merchant mid-switch both.
 *
 * ## Currencies are never summed together
 *
 * `Payment.currency` is per row. A shop that changed currency, or took
 * one booking in USD, would otherwise produce a total that is the sum
 * of two different things and means neither. Rows in the shop's own
 * currency are counted; anything else is reported by name so the screen
 * can say so instead of quietly being wrong.
 */
export interface MoneyByMethod {
  method: string;
  collected: number;
  count: number;
}

export interface MoneyMetrics {
  /** The shop's own currency — the one every figure here is in. */
  currency: string;
  /** Marked received within the range, by when it was received. */
  collected: number;
  collectedCount: number;
  /** Asked for within the range, whether or not it arrived. The denominator of the collection rate. */
  requested: number;
  requestedCount: number;
  /**
   * Still owed, across all time rather than the range — a debt does not
   * stop being a debt because the date filter moved.
   */
  outstanding: number;
  outstandingCount: number;
  /** Built from what was actually used, not from what settings say. */
  byMethod: MoneyByMethod[];
  /** Present but not counted, because summing currencies would be meaningless. */
  otherCurrencies: string[];
  /** False when nothing has ever been requested — the card hides itself rather than showing zeroes. */
  used: boolean;
}

export async function money(
  shop: string,
  platform: string,
  range: DateRange,
  shopCurrency: string
): Promise<MoneyMetrics> {
  const currency = (shopCurrency || "").toUpperCase();

  const [inRange, everRequested, outstandingRows] = await Promise.all([
    // Received *in* the range, keyed on paidAt — when the money landed,
    // not when it was asked for. A deposit requested in March and paid
    // in April belongs to April.
    prisma.payment.findMany({
      where: { shop, platform, status: "paid", paidAt: { gte: range.from, lte: range.to } },
      select: { amount: true, currency: true, method: true },
    }),
    prisma.payment.findMany({
      where: { shop, platform, createdAt: { gte: range.from, lte: range.to } },
      select: { amount: true, currency: true, status: true },
    }),
    // Deliberately unbounded by the range.
    prisma.payment.findMany({
      where: { shop, platform, status: "pending" },
      select: { amount: true, currency: true },
    }),
  ]);

  const others = new Set<string>();
  const matches = (rowCurrency: string) => {
    const code = (rowCurrency || "").toUpperCase();
    if (code === currency) return true;
    if (code) others.add(code);
    return false;
  };

  const collectedRows = inRange.filter((row) => matches(row.currency));
  const byMethod = new Map<string, { collected: number; count: number }>();
  for (const row of collectedRows) {
    const entry = byMethod.get(row.method) ?? { collected: 0, count: 0 };
    entry.collected += row.amount;
    entry.count += 1;
    byMethod.set(row.method, entry);
  }

  const requestedRows = everRequested.filter((row) => matches(row.currency));
  // Cancelled requests are not something anyone was ever asked to pay,
  // so counting them would make the collection rate look worse than the
  // merchant's customers actually behaved.
  const liveRequests = requestedRows.filter((row) => row.status !== "cancelled");
  const outstanding = outstandingRows.filter((row) => matches(row.currency));

  return {
    currency,
    collected: round2(collectedRows.reduce((sum, row) => sum + row.amount, 0)),
    collectedCount: collectedRows.length,
    requested: round2(liveRequests.reduce((sum, row) => sum + row.amount, 0)),
    requestedCount: liveRequests.length,
    outstanding: round2(outstanding.reduce((sum, row) => sum + row.amount, 0)),
    outstandingCount: outstanding.length,
    byMethod: [...byMethod.entries()]
      .map(([method, totals]) => ({ method, collected: round2(totals.collected), count: totals.count }))
      .sort((a, b) => b.collected - a.collected),
    otherCurrencies: [...others].sort(),
    // Asked of requests rather than of receipts: a merchant who has
    // asked for money and been paid none still needs the screen, and
    // that is exactly when they need it most.
    used: requestedRows.length > 0 || outstanding.length > 0,
  };
}

/** Money, to the minor unit. Float columns accumulate error over a few hundred rows. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
