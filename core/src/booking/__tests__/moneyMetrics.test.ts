/**
 * What the merchant has been paid, as far as anybody has told us.
 *
 * The arithmetic is easy; the judgements are not. These tests pin the
 * four that would each produce a number that looks right and is wrong:
 * which date a payment belongs to, whether a debt ages out, what
 * happens to a cancelled request, and what happens when two currencies
 * meet.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import prisma from "../../db.js";
import * as Metrics from "../metrics.js";

const RUN = Date.now();
const shop = `money-${RUN}`;
const platform = "manual";
const INR = "INR";

const RANGE = {
  from: new Date("2026-03-01T00:00:00Z"),
  to: new Date("2026-03-31T23:59:59Z"),
};

// Payment has a real foreign key to Booking, so every figure here is
// anchored to one. Its own fields are irrelevant to the aggregates —
// money() reads Payment rows only — so this is the cheapest booking
// that satisfies the constraint.
let bookingId = 0;

beforeAll(async () => {
  const customer = await prisma.customer.create({
    data: { shop, platform, email: `money-${RUN}@example.com`, firstName: "Test" },
  });
  const booking = await prisma.booking.create({
    data: {
      shop,
      platform,
      uid: `money-${RUN}`,
      serviceId: 1,
      resourceId: 1,
      customerId: customer.id,
      startUtc: new Date("2026-03-15T09:00:00Z"),
      endUtc: new Date("2026-03-15T09:30:00Z"),
    },
  });
  bookingId = booking.id;
});

async function payment(over: Partial<{
  amount: number; currency: string; method: string; status: string;
  paidAt: Date | null; createdAt: Date;
}> = {}) {
  return prisma.payment.create({
    data: {
      shop,
      platform,
      bookingId,
      amount: over.amount ?? 500,
      currency: over.currency ?? INR,
      method: over.method ?? "upi",
      status: over.status ?? "paid",
      paidAt: over.paidAt === undefined ? new Date("2026-03-15T10:00:00Z") : over.paidAt,
      createdAt: over.createdAt ?? new Date("2026-03-10T10:00:00Z"),
    },
  });
}

const read = () => Metrics.money(shop, platform, RANGE, INR);

beforeEach(async () => {
  await prisma.payment.deleteMany({ where: { shop } });
});

afterAll(async () => {
  await prisma.payment.deleteMany({ where: { shop } });
  await prisma.booking.deleteMany({ where: { shop } });
  await prisma.customer.deleteMany({ where: { shop } });
});

describe("collected", () => {
  it("counts what was marked received inside the range", async () => {
    await payment({ amount: 500 });
    await payment({ amount: 250 });

    const money = await read();
    expect(money.collected).toBe(750);
    expect(money.collectedCount).toBe(2);
  });

  it("belongs to the month the money landed, not the month it was asked for", async () => {
    // A deposit requested in February and paid in March is March's.
    // Keying this on createdAt would move it, and the merchant's own
    // bank statement would disagree with us.
    await payment({ createdAt: new Date("2026-02-20T10:00:00Z"), paidAt: new Date("2026-03-02T10:00:00Z") });

    expect((await read()).collected).toBe(500);
  });

  it("excludes a payment received after the range closed", async () => {
    await payment({ paidAt: new Date("2026-04-02T10:00:00Z") });

    expect((await read()).collected).toBe(0);
  });

  it("excludes refunds — money that came back is not money collected", async () => {
    await payment({ amount: 500 });
    await payment({ amount: 500, status: "refunded" });

    expect((await read()).collected).toBe(500);
  });
});

describe("outstanding", () => {
  it("is all-time, because a debt does not age out of being owed", async () => {
    // Requested long before the range and still unpaid. A merchant
    // chasing money wants every rupee owed, not the ones owed recently.
    await payment({ status: "pending", paidAt: null, createdAt: new Date("2025-11-01T10:00:00Z") });

    const money = await read();
    expect(money.outstanding).toBe(500);
    expect(money.outstandingCount).toBe(1);
  });

  it("drops out once it is marked paid", async () => {
    await payment({ status: "paid" });

    expect((await read()).outstanding).toBe(0);
  });
});

describe("the collection rate's denominator", () => {
  it("counts what was asked for in the range", async () => {
    await payment({ amount: 500, status: "paid" });
    await payment({ amount: 300, status: "pending", paidAt: null });

    const money = await read();
    expect(money.requested).toBe(800);
    expect(money.collected).toBe(500);
  });

  it("ignores a cancelled request", async () => {
    // Nobody was ever asked to pay it, so counting it would make the
    // rate look worse than the merchant's customers actually behaved.
    await payment({ amount: 500, status: "paid" });
    await payment({ amount: 900, status: "cancelled", paidAt: null });

    expect((await read()).requested).toBe(500);
  });
});

describe("by method — what the dashboard adapts to", () => {
  it("splits by the method actually used, not by what settings say", async () => {
    // A merchant who switched from PayPal.me to UPI still has the old
    // bookings, and they do not move.
    await payment({ method: "upi", amount: 500 });
    await payment({ method: "upi", amount: 250 });
    await payment({ method: "paypal", amount: 900 });

    const money = await read();
    expect(money.byMethod).toEqual([
      { method: "paypal", collected: 900, count: 1 },
      { method: "upi", collected: 750, count: 2 },
    ]);
  });

  it("returns a single method for a merchant who only uses one", async () => {
    await payment({ method: "upi" });

    expect((await read()).byMethod).toHaveLength(1);
  });

  it("includes methods recorded by hand, like cash", async () => {
    await payment({ method: "cash", amount: 200 });

    expect((await read()).byMethod[0]).toMatchObject({ method: "cash", collected: 200 });
  });
});

describe("currencies are never summed together", () => {
  it("counts only the shop's own currency", async () => {
    // ₹500 + $500 = 1000 of nothing.
    await payment({ amount: 500, currency: "INR" });
    await payment({ amount: 500, currency: "USD" });

    const money = await read();
    expect(money.collected).toBe(500);
  });

  it("names the currency it left out, so the screen can say so", async () => {
    await payment({ amount: 500, currency: "USD" });

    expect((await read()).otherCurrencies).toEqual(["USD"]);
  });

  it("says nothing when every row agrees", async () => {
    await payment({ currency: "INR" });

    expect((await read()).otherCurrencies).toEqual([]);
  });
});

describe("used — whether the card appears at all", () => {
  it("is false for a merchant who has never asked for money", async () => {
    // The overwhelming majority. A row of zeroes on their Overview
    // would be noise about a feature they have not switched on.
    expect((await read()).used).toBe(false);
  });

  it("is true once anything has been requested, even if nothing was paid", async () => {
    // Asked and unpaid is exactly when a merchant needs this screen.
    await payment({ status: "pending", paidAt: null });

    expect((await read()).used).toBe(true);
  });
});
