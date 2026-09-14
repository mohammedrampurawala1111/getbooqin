/**
 * Requesting a deposit and recording that it arrived.
 *
 * Real Postgres, because the two properties that matter are both about
 * state: a request must not be duplicated (a customer shown two ₹500
 * links for one booking will reasonably pay both), and the booking's
 * own payment status must never disagree with its payments.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import prisma from "../../db.js";
import * as Payments from "../payments.js";
import { setSettings } from "../settings.js";

const RUN = Date.now();
const shop = `pay-${RUN}`;
const platform = "manual";
const userId = `pay-user-${RUN}`;

let serviceId = 0;
let resourceId = 0;
let customerId = 0;
let bookingId = 0;

// Each fixture booking gets its own hour. The Booking_resource_no_overlap
// exclusion constraint is real and correctly refuses two bookings on one
// resource at the same time — so a fixture that reuses a slot fails for
// the right reason and tells you nothing about payments.
let slot = 0;

async function booking(price: number, over: Record<string, unknown> = {}) {
  const start = new Date(Date.now() + 86_400_000 + slot++ * 3_600_000);
  const row = await prisma.booking.create({
    data: {
      shop,
      platform,
      uid: `bk_pay_${RUN}_${Math.random().toString(36).slice(2, 8)}`,
      serviceId,
      resourceId,
      customerId,
      startUtc: start,
      endUtc: new Date(start.getTime() + 1_800_000),
      timezone: "Asia/Kolkata",
      status: "confirmed",
      price,
      // Frozen at creation by bookings.ts in real life; set here so the
      // fixture matches what the product actually stores.
      amountDue: Math.round(price * 0.25 * 100) / 100,
      currency: "INR",
      ...over,
    } as never,
  });
  return row.id;
}

beforeAll(async () => {
  await prisma.productCache.create({
    data: { shop, platform, productId: `p-${RUN}`, productHandle: `h-${RUN}`, title: "Facial", price: 2000 },
  });
  const config = await prisma.serviceConfig.create({
    data: {
      shop, platform, productId: `p-${RUN}`, productHandle: `h-${RUN}`,
      durationMin: 30, status: true, paymentRequired: true, depositPercent: 25, depositAmount: 0,
    },
  });
  serviceId = config.id;

  const resource = await prisma.resource.create({
    data: { shop, platform, name: "Nina", status: true },
  });
  resourceId = resource.id;

  const customer = await prisma.customer.create({
    data: { shop, platform, firstName: "Asha", lastName: "Iyer", email: "asha@example.com", phone: "+919876543210" },
  });
  customerId = customer.id;

  await setSettings(shop, platform, {
    business_name: "Acme Dental",
    currency: "INR",
    upi_id: "acme@okhdfcbank",
  });
});

beforeEach(async () => {
  await prisma.payment.deleteMany({ where: { shop } });
  await prisma.booking.deleteMany({ where: { shop } });
  bookingId = await booking(2000);
});

afterAll(async () => {
  await prisma.payment.deleteMany({ where: { shop } });
  await prisma.booking.deleteMany({ where: { shop } });
  await prisma.customer.deleteMany({ where: { shop } });
  await prisma.resource.deleteMany({ where: { shop } });
  await prisma.serviceConfig.deleteMany({ where: { shop } });
  await prisma.productCache.deleteMany({ where: { shop } });
  await prisma.shopSettings.deleteMany({ where: { shop } });
});

describe("asking for a deposit", () => {
  it("creates a request for the service's share of the price", async () => {
    const payment = await Payments.requestPayment(shop, platform, bookingId);

    expect(payment.amount).toBe(500); // 25% of 2000
    expect(payment.currency).toBe("INR");
    expect(payment.status).toBe("pending");
    expect(payment.method).toBe("upi");
  });

  it("builds a UPI link that pays the merchant, not us", async () => {
    const payment = await Payments.requestPayment(shop, platform, bookingId);

    expect(payment.link).toContain("upi://pay?");
    expect(payment.link).toContain("pa=acme%40okhdfcbank");
    expect(payment.link).toContain("am=500.00");
    // The reference is what lets a bank line be matched to a booking.
    expect(payment.link).toContain(`tr=${payment.reference}`);
  });

  it("does not create a second request for the same booking", async () => {
    // A resent confirmation email, or a merchant pressing the button
    // twice. A customer shown two links will reasonably pay both.
    const first = await Payments.requestPayment(shop, platform, bookingId);
    const second = await Payments.requestPayment(shop, platform, bookingId);

    expect(second.id).toBe(first.id);
    expect(await prisma.payment.count({ where: { shop, bookingId } })).toBe(1);
  });

  it("refuses when the shop has no way to be paid", async () => {
    await setSettings(shop, platform, { upi_id: "", paypal_me: "" });

    await expect(Payments.requestPayment(shop, platform, bookingId)).rejects.toMatchObject({
      code: "getbooqin_no_payment_method",
    });

    await setSettings(shop, platform, { upi_id: "acme@okhdfcbank" });
  });

  it("refuses when there is nothing to collect", async () => {
    const free = await booking(0);

    await expect(Payments.requestPayment(shop, platform, free)).rejects.toMatchObject({
      code: "getbooqin_nothing_due",
    });
  });
});

describe("recording that it arrived", () => {
  it("marks the payment paid and records who said so", async () => {
    // Nothing verifies this — it is a person's assertion, and a merchant
    // asking "who marked this paid?" weeks later deserves an answer.
    const payment = await Payments.requestPayment(shop, platform, bookingId);

    const paid = await Payments.markPaid(shop, platform, payment.id, { userId, utr: "412345678901" });

    expect(paid.status).toBe("paid");
    expect(paid.confirmedByUserId).toBe(userId);
    expect(paid.utr).toBe("412345678901");
    expect(paid.paidAt).toBeInstanceOf(Date);
  });

  it("does not call a booking paid when only the deposit has arrived", async () => {
    // ₹500 of a ₹2,000 service. Counting *pending rows* said "paid"
    // here — so the booking showed a green Paid badge while the Orders
    // screen simultaneously showed ₹1,500 owed. Two screens
    // contradicting each other about the same booking.
    const payment = await Payments.requestPayment(shop, platform, bookingId);
    await Payments.markPaid(shop, platform, payment.id, { userId });

    expect((await prisma.booking.findUnique({ where: { id: bookingId } }))?.paymentStatus).toBe("unpaid");
  });

  it("moves the booking to paid once the price has actually been covered", async () => {
    const deposit = await Payments.requestPayment(shop, platform, bookingId, { kind: "deposit", amount: 500 });
    await Payments.markPaid(shop, platform, deposit.id, { userId });
    const balance = await Payments.requestPayment(shop, platform, bookingId, { kind: "balance", amount: 1500 });
    await Payments.markPaid(shop, platform, balance.id, { userId });

    expect((await prisma.booking.findUnique({ where: { id: bookingId } }))?.paymentStatus).toBe("paid");
  });

  it("is order-independent, so two people confirming at once cannot strand it", async () => {
    // Counting pending rows was also racy: under read-committed each
    // transaction saw the other's row still pending, both wrote
    // "unpaid", and a fully-settled booking stayed unpaid forever.
    const deposit = await Payments.requestPayment(shop, platform, bookingId, { kind: "deposit", amount: 500 });
    const balance = await Payments.requestPayment(shop, platform, bookingId, { kind: "balance", amount: 1500 });

    await Promise.all([
      Payments.markPaid(shop, platform, balance.id, { userId }),
      Payments.markPaid(shop, platform, deposit.id, { userId }),
    ]);

    expect((await prisma.booking.findUnique({ where: { id: bookingId } }))?.paymentStatus).toBe("paid");
  });

  it("leaves the booking unpaid while a balance is still outstanding", async () => {
    // A deposit arriving on a booking that also owes a balance is not a
    // paid booking, and treating it as one is how a balance goes
    // uncollected.
    const deposit = await Payments.requestPayment(shop, platform, bookingId, { kind: "deposit", amount: 500 });
    await Payments.requestPayment(shop, platform, bookingId, { kind: "balance", amount: 1500 });

    await Payments.markPaid(shop, platform, deposit.id, { userId });

    expect((await prisma.booking.findUnique({ where: { id: bookingId } }))?.paymentStatus).toBe("unpaid");
  });

  it("is idempotent — marking it twice does not move the date", async () => {
    const payment = await Payments.requestPayment(shop, platform, bookingId);
    const first = await Payments.markPaid(shop, platform, payment.id, { userId });
    const second = await Payments.markPaid(shop, platform, payment.id, { userId });

    expect(second.paidAt?.getTime()).toBe(first.paidAt?.getTime());
  });
});

describe("the amount asked for", () => {
  it("never exceeds the price, even when the merchant types it", async () => {
    // The Orders screen passes merchant free text straight through.
    // Unclamped, "1000.555" on an ₹800 service stored a non-2dp ledger
    // entry above the price — and `outstanding` then read as 0, hiding
    // the overpayment completely.
    const payment = await Payments.requestPayment(shop, platform, bookingId, { amount: 99_999 });

    expect(payment.amount).toBe(2000);
  });

  it("rounds a typed amount to two decimals", async () => {
    const payment = await Payments.requestPayment(shop, platform, bookingId, { amount: 100.555 });

    expect(payment.amount).toBe(100.56);
  });

  it("honours the deposit frozen on the booking, not today's policy", async () => {
    // bookings.ts freezes amountDue at creation precisely so a policy
    // change cannot re-price bookings already taken. Re-deriving here
    // reintroduced exactly that: a March booking at 25% was asked for
    // 50% in April.
    await prisma.serviceConfig.update({ where: { id: serviceId }, data: { depositPercent: 50 } });

    const payment = await Payments.requestPayment(shop, platform, bookingId);

    expect(payment.amount).toBe(500); // the booking's own amountDue, not 1000
    await prisma.serviceConfig.update({ where: { id: serviceId }, data: { depositPercent: 25 } });
  });
});

describe("withdrawing a request", () => {
  it("cancels rather than deletes, so the record survives", async () => {
    const payment = await Payments.requestPayment(shop, platform, bookingId);

    const cancelled = await Payments.cancelRequest(shop, platform, payment.id);

    expect(cancelled.status).toBe("cancelled");
    expect(await prisma.payment.count({ where: { shop, bookingId } })).toBe(1);
  });

  it("refuses to cancel something already paid", async () => {
    const payment = await Payments.requestPayment(shop, platform, bookingId);
    await Payments.markPaid(shop, platform, payment.id, { userId });

    await expect(Payments.cancelRequest(shop, platform, payment.id)).rejects.toMatchObject({
      code: "getbooqin_already_paid",
    });
  });

  it("frees the booking to be asked again", async () => {
    const first = await Payments.requestPayment(shop, platform, bookingId);
    await Payments.cancelRequest(shop, platform, first.id);

    const second = await Payments.requestPayment(shop, platform, bookingId);

    expect(second.id).not.toBe(first.id);
  });

  it("settles the booking when the last outstanding request is withdrawn", async () => {
    // Nothing but markPaid ever wrote this column, so withdrawing a
    // mistaken request left the booking "unpaid" permanently with no
    // payment left to mark.
    const request = await Payments.requestPayment(shop, platform, bookingId);
    expect((await prisma.booking.findUnique({ where: { id: bookingId } }))?.paymentStatus).toBe("unpaid");

    await Payments.cancelRequest(shop, platform, request.id);

    expect((await prisma.booking.findUnique({ where: { id: bookingId } }))?.paymentStatus).toBe("not_required");
  });
});

describe("the orders view", () => {
  it("shows a booking nobody has asked to pay yet", async () => {
    // The row a merchant most needs to see. Built from bookings rather
    // than payments precisely so this one exists.
    const rows = await Payments.orders(shop, platform);
    const row = rows.find((r) => r.bookingId === bookingId);

    expect(row).toBeTruthy();
    expect(row?.requested).toBe(0);
    expect(row?.paid).toBe(0);
    expect(row?.outstanding).toBe(2000);
  });

  it("counts outstanding against the price, not against what was requested", async () => {
    // A merchant who took a ₹500 deposit on a ₹2000 service is still
    // owed ₹1500.
    const payment = await Payments.requestPayment(shop, platform, bookingId);
    await Payments.markPaid(shop, platform, payment.id, { userId });

    const row = (await Payments.orders(shop, platform)).find((r) => r.bookingId === bookingId);

    expect(row?.paid).toBe(500);
    expect(row?.outstanding).toBe(1500);
  });

  it("carries the customer's details, which is half of why the screen exists", async () => {
    const row = (await Payments.orders(shop, platform)).find((r) => r.bookingId === bookingId);

    expect(row?.customerName).toBe("Asha Iyer");
    expect(row?.customerEmail).toBe("asha@example.com");
    expect(row?.customerPhone).toBe("+919876543210");
    expect(row?.serviceName).toBe("Facial");
  });

  it("ignores a cancelled booking", async () => {
    await booking(1500, { status: "cancelled" });

    const rows = await Payments.orders(shop, platform);

    expect(rows.every((r) => r.status !== "cancelled")).toBe(true);
  });

  it("filters to what is still owed", async () => {
    const other = await booking(800);
    const payment = await Payments.requestPayment(shop, platform, other, { amount: 800 });
    await Payments.markPaid(shop, platform, payment.id, { userId });

    const outstanding = await Payments.orders(shop, platform, { status: "outstanding" });
    const settled = await Payments.orders(shop, platform, { status: "paid" });

    expect(outstanding.map((r) => r.bookingId)).toContain(bookingId);
    expect(outstanding.map((r) => r.bookingId)).not.toContain(other);
    expect(settled.map((r) => r.bookingId)).toContain(other);
  });
});

describe("the QR", () => {
  it("renders a scannable image for a link", async () => {
    const payment = await Payments.requestPayment(shop, platform, bookingId);

    const qr = await Payments.paymentQr(payment.link);

    expect(qr.startsWith("data:image/png;base64,")).toBe(true);
    // Small enough to inline into an email without anyone noticing.
    expect(Buffer.byteLength(qr)).toBeLessThan(20_000);
  });

  it("renders nothing for a method with nothing to scan", async () => {
    // Cash is a real way to be paid and belongs in the record, but an
    // empty QR would be worse than none.
    expect(await Payments.paymentQr("")).toBe("");
  });
});
