/**
 * Asking a customer for money, and recording whether it arrived.
 *
 * GetBooqin is not in this transaction. The merchant supplies a UPI ID
 * or a PayPal.me handle, the customer pays them directly, and we store
 * what was asked for and what the merchant says came back. No funds are
 * held, no provider is called, and there is no aggregator status to
 * apply for — which is the whole reason this ships without Razorpay
 * Route and its turnover threshold.
 *
 * The consequence, stated plainly because every screen has to reflect
 * it: **a payment is marked paid by a person, not verified.** The UTR
 * the customer quotes is evidence a merchant can match against their
 * bank statement, not proof. Anywhere the product implies otherwise
 * would be lying to a merchant about their own money.
 */
import QRCode from "qrcode";
import prisma from "../db.js";
import type { Booking, Payment, Prisma } from "@prisma/client";
import { GetBooqinError } from "./errors.js";
import {
  amountDueFor,
  availableMethod,
  paymentLink,
  paymentReference,
  type PaymentMethod,
  type PayeeDetails,
} from "./paymentLinks.js";
import { getSettings } from "./settings.js";
// Static: bookings.ts does not import this module (it takes amountDueFor
// from paymentLinks directly), so there is no cycle to dodge here.
import { setStatus } from "./bookings.js";
import * as Data from "./data.js";

export type { PaymentMethod } from "./paymentLinks.js";

/** Methods a merchant can record without any link being involved. */
const OFFLINE_METHODS: PaymentMethod[] = ["cash", "bank", "other"];

function payeeFrom(settings: { business_name: string; upi_id: string; paypal_me: string }): PayeeDetails {
  return {
    upiId: settings.upi_id,
    payPalMe: settings.paypal_me,
    payeeName: settings.business_name || "Booking",
  };
}

/**
 * What this booking's service asks for up front.
 *
 * Read from the service rather than the booking, because the policy is
 * the merchant's current one and a booking row records what was
 * actually charged.
 */
export async function amountDueForBooking(
  shop: string,
  booking: Pick<Booking, "serviceId" | "price" | "amountDue">
): Promise<number> {
  // The figure frozen on the booking, not a fresh read of the service.
  //
  // bookings.ts computes this at creation precisely so that changing the
  // deposit policy next week does not re-price bookings already taken —
  // and re-deriving here would reintroduce exactly that. A booking made
  // in March at a 25% deposit is owed 25%, even if April's policy says
  // 50%.
  if (booking.amountDue > 0) return booking.amountDue;

  // Only for a booking taken before any deposit policy existed, where
  // there is no frozen figure to honour.
  const config = await prisma.serviceConfig.findFirst({
    where: { shop, id: booking.serviceId },
    select: { paymentRequired: true, depositPercent: true, depositAmount: true },
  });
  if (!config) return 0;
  return amountDueFor(booking.price, config);
}

export interface PaymentRequestView {
  id: number;
  kind: string;
  method: string;
  amount: number;
  currency: string;
  status: string;
  reference: string;
  link: string;
  utr: string;
  paidAt: Date | null;
  createdAt: Date;
}

/**
 * Creates the request a customer is shown, or returns the one that
 * already exists.
 *
 * Deliberately idempotent per booking and kind: a merchant pressing
 * "request payment" twice, or a confirmation email being resent, must
 * not produce two ₹500 requests against one booking — the customer
 * would reasonably pay both.
 */
export async function requestPayment(
  shop: string,
  platform: string,
  bookingId: number,
  opts: { kind?: string; method?: PaymentMethod; amount?: number } = {}
): Promise<Payment> {
  const booking = await prisma.booking.findFirst({ where: { shop, platform, id: bookingId } });
  if (!booking) throw new GetBooqinError("getbooqin_not_found", "Booking not found.", 404);

  const kind = opts.kind ?? "deposit";
  const existing = await prisma.payment.findFirst({
    where: { shop, platform, bookingId, kind, status: "pending" },
  });
  if (existing) return existing;

  const settings = await getSettings(shop, platform);
  // A merchant-supplied amount goes through the same rounding and
  // ceiling as a policy-derived one. Passed straight through, a typed
  // "1000.555" on an ₹800 service became a non-2dp ledger entry asking
  // for ₹1000.56 — and `outstanding` then read as 0, hiding the
  // overpayment entirely.
  const requested = opts.amount ?? (await amountDueForBooking(shop, booking));
  const amount = clampToPrice(requested ?? 0, booking.price);
  if (amount <= 0) {
    throw new GetBooqinError("getbooqin_nothing_due", "There's nothing to collect for this booking.", 400);
  }

  const payee = payeeFrom(settings);
  const method = opts.method ?? availableMethod(payee, settings.currency);
  if (!method) {
    throw new GetBooqinError(
      "getbooqin_no_payment_method",
      "Add a UPI ID or PayPal link under Settings → Payments first.",
      400
    );
  }

  const reference = paymentReference(booking.uid);
  const service = await Data.catalogService(shop, booking.serviceId);
  const link = OFFLINE_METHODS.includes(method)
    ? ""
    : paymentLink(method, {
        payee,
        amount,
        currency: settings.currency,
        reference,
        note: `${service?.name ?? "Booking"} ${reference}`.slice(0, 50),
      });

  // A request is a debt. Without this a booking created before any
  // deposit policy existed stayed "not_required" after the merchant
  // asked for money by hand, so it was invisible to every
  // paymentStatus query and badge until somebody marked it paid.
  const created = await prisma.payment.create({
    data: {
      shop,
      platform,
      bookingId,
      kind,
      method,
      reference,
      link,
      amount,
      currency: settings.currency,
      status: "pending",
    },
  });

  await prisma.$transaction((tx) => recomputeBookingPaymentStatus(tx, shop, platform, bookingId));
  return created;
}

/**
 * The QR for a payment link.
 *
 * A data URL rather than a file, for the same reason the branding logo
 * is: it goes into an email and onto a page, both of which can inline
 * it, and neither of which is worth an object store. ~4KB.
 *
 * Returns "" for a method with no link — cash has nothing to scan, and
 * rendering an empty QR would be worse than rendering none.
 */
export async function paymentQr(link: string): Promise<string> {
  if (!link) return "";
  try {
    return await QRCode.toDataURL(link, { margin: 1, width: 320, errorCorrectionLevel: "M" });
  } catch (err) {
    console.error("[getbooqin payments] could not render a QR code:", err);
    return "";
  }
}

/**
 * Records that a payment arrived.
 *
 * Takes the user id because this is an assertion by a person, and a
 * merchant asking "who marked this paid?" three weeks later deserves an
 * answer. Writes `Booking.paymentStatus` in the same transaction so the
 * booking list and the payment record cannot disagree.
 */
export async function markPaid(
  shop: string,
  platform: string,
  paymentId: number,
  by: { userId: string; utr?: string }
): Promise<Payment> {
  const payment = await prisma.payment.findFirst({ where: { shop, platform, id: paymentId } });
  if (!payment) throw new GetBooqinError("getbooqin_not_found", "Payment not found.", 404);
  if (payment.status === "paid") return payment;

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.payment.update({
      where: { id: paymentId },
      data: {
        status: "paid",
        paidAt: new Date(),
        confirmedByUserId: by.userId,
        utr: (by.utr ?? "").trim().slice(0, 40),
      },
    });

    await recomputeBookingPaymentStatus(tx, shop, platform, payment.bookingId);
    return row;
  });

  // Payment-before-confirmation's other half (10-01-2026 review, item
  // 13). bookings.ts holds a deposit-bearing booking at `pending`
  // whatever auto_confirm says; this is what lets it go.
  //
  // Outside the transaction above, and after it: setStatus() emits
  // booking_status_changed, which sends the customer their confirmation.
  // Emitting that from inside a transaction that might still roll back
  // would send a confirmation for a payment that was never recorded.
  //
  // Only when the booking is fully settled, and only from `pending` —
  // a part-payment is not a confirmation, and a cancelled booking must
  // not be resurrected by someone reconciling an old bank statement.
  await confirmIfSettled(shop, platform, payment.bookingId);

  return updated;
}

/**
 * Confirms a pending booking once nothing is outstanding on it.
 *
 * Separate from recomputeBookingPaymentStatus because that runs inside
 * the payment transaction and this must not: it emits the event that
 * emails the customer.
 */
async function confirmIfSettled(shop: string, platform: string, bookingId: number): Promise<void> {
  const booking = await prisma.booking.findFirst({
    where: { shop, platform, id: bookingId },
    select: { id: true, status: true, paymentStatus: true },
  });
  if (!booking || booking.status !== "pending" || booking.paymentStatus !== "paid") return;

  await setStatus(shop, bookingId, "confirmed", "payment received");
}

/** Withdraws a request that should not have been sent. Never deletes: the record is the audit trail. */
export async function cancelRequest(shop: string, platform: string, paymentId: number): Promise<Payment> {
  const payment = await prisma.payment.findFirst({ where: { shop, platform, id: paymentId } });
  if (!payment) throw new GetBooqinError("getbooqin_not_found", "Payment not found.", 404);
  if (payment.status === "paid") {
    throw new GetBooqinError("getbooqin_already_paid", "That payment is already marked as paid.", 409);
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.payment.update({ where: { id: paymentId }, data: { status: "cancelled" } });
    // Withdrawing the only outstanding request settles the booking.
    // Without this the booking stayed "unpaid" forever, because nothing
    // but markPaid ever wrote that column and there was no payment left
    // to mark.
    await recomputeBookingPaymentStatus(tx, shop, platform, payment.bookingId);
    return updated;
  });
}

/**
 * Sets a booking's payment status from the money, not from the number of
 * outstanding requests.
 *
 * Counting pending rows was wrong in both directions. A ₹500 deposit
 * paid on a ₹2,000 service left zero pending rows, so the booking read
 * "paid" while the Orders screen simultaneously showed ₹1,500 owed —
 * two screens contradicting each other about the same booking. And two
 * people confirming a deposit and a balance at the same instant could
 * each see the other's row still pending and both write "unpaid",
 * stranding a fully-settled booking.
 *
 * Comparing totals has neither problem: it is the same arithmetic the
 * Orders screen does, so the two cannot disagree, and it is
 * order-independent under concurrency.
 */
async function recomputeBookingPaymentStatus(
  tx: Prisma.TransactionClient,
  shop: string,
  platform: string,
  bookingId: number
): Promise<void> {
  const booking = await tx.booking.findUnique({ where: { id: bookingId }, select: { price: true } });
  if (!booking) return;

  const rows = await tx.payment.findMany({
    where: { shop, platform, bookingId, status: { in: ["paid", "pending"] } },
    select: { amount: true, status: true },
  });

  const paid = round2(rows.filter((r) => r.status === "paid").reduce((a, b) => a + b.amount, 0));
  const pending = rows.some((r) => r.status === "pending");

  // Against the price, so a part-payment is never mistaken for a whole
  // one. A booking with nothing owed and nothing outstanding is simply
  // not a payment matter.
  const status = paid >= booking.price ? "paid" : pending || paid > 0 ? "unpaid" : "not_required";

  await tx.booking.update({ where: { id: bookingId }, data: { paymentStatus: status } });
}

/** Two decimals, never negative, never more than the booking is worth. */
function clampToPrice(amount: number, price: number): number {
  return Math.min(round2(Math.max(amount, 0)), round2(price));
}

/**
 * How many bookings match a filter, regardless of the page size.
 *
 * The screen needs this to say "showing 100 of 240" instead of
 * implying the page is the whole truth.
 */
export function countOrders(
  shop: string,
  platform: string,
  status: "outstanding" | "paid" | "all" = "outstanding"
): Promise<number> {
  const paymentStatus =
    status === "outstanding"
      ? { in: ["unpaid", "not_required"] }
      : status === "paid"
        ? { in: ["paid"] }
        : undefined;

  return prisma.booking.count({
    where: {
      shop,
      platform,
      price: { gt: 0 },
      status: { notIn: ["cancelled", "declined"] },
      ...(paymentStatus ? { paymentStatus } : {}),
    },
  });
}

export function listForBooking(shop: string, platform: string, bookingId: number) {
  return prisma.payment.findMany({
    where: { shop, platform, bookingId },
    orderBy: { createdAt: "desc" },
  });
}

export interface OrderRow {
  bookingId: number;
  bookingUid: string;
  when: Date;
  status: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  serviceName: string;
  price: number;
  currency: string;
  requested: number;
  paid: number;
  outstanding: number;
  payments: PaymentRequestView[];
}

/**
 * The orders view: one row per booking that involves money.
 *
 * Built from bookings rather than from payments, so a booking with a
 * price and no request yet still appears — "nobody has asked this
 * customer for anything" is the row a merchant most needs to see.
 */
export async function orders(
  shop: string,
  platform: string,
  opts: { status?: "outstanding" | "paid" | "all"; limit?: number } = {}
): Promise<OrderRow[]> {
  const limit = opts.limit ?? 100;

  // The payment filter goes into the query, not into a post-filter of
  // the latest N.
  //
  // Taking the newest 100 bookings and *then* filtering meant the "Owed"
  // view could render "Nothing outstanding. Every priced booking has
  // been paid for." while older unpaid bookings sat invisible behind the
  // window — a false statement on the one screen whose whole purpose is
  // telling a merchant who owes them money.
  //
  // `Booking.paymentStatus` is maintained by recomputeBookingPaymentStatus
  // from the money actually collected, so it is the same answer the rows
  // below compute rather than a second source of truth.
  const paymentStatus =
    opts.status === "outstanding"
      ? { in: ["unpaid", "not_required"] }
      : opts.status === "paid"
        ? { in: ["paid"] }
        : undefined;

  const bookings = await prisma.booking.findMany({
    where: {
      shop,
      platform,
      price: { gt: 0 },
      status: { notIn: ["cancelled", "declined"] },
      ...(paymentStatus ? { paymentStatus } : {}),
    },
    orderBy: { startUtc: "desc" },
    take: limit,
  });
  if (bookings.length === 0) return [];

  const [payments, customers, services] = await Promise.all([
    prisma.payment.findMany({
      where: { shop, platform, bookingId: { in: bookings.map((b) => b.id) } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.customer.findMany({ where: { shop, id: { in: bookings.map((b) => b.customerId) } } }),
    Data.catalogServices(shop, platform, false),
  ]);

  const byCustomer = new Map(customers.map((c) => [c.id, c]));
  const byService = new Map(services.map((s) => [s.id, s]));

  const rows = bookings.map((booking) => {
    const own = payments.filter((p) => p.bookingId === booking.id);
    const paid = sum(own.filter((p) => p.status === "paid").map((p) => p.amount));
    const requested = sum(own.filter((p) => p.status !== "cancelled").map((p) => p.amount));
    const customer = byCustomer.get(booking.customerId);

    return {
      bookingId: booking.id,
      bookingUid: booking.uid,
      when: booking.startUtc,
      status: booking.status,
      customerName: customer ? `${customer.firstName} ${customer.lastName}`.trim() : "",
      customerEmail: customer?.email ?? "",
      customerPhone: customer?.phone ?? "",
      serviceName: byService.get(booking.serviceId)?.name ?? "",
      price: booking.price,
      currency: booking.currency,
      requested,
      paid,
      // Against the price, not against what was requested — a merchant
      // who has asked for a ₹500 deposit on a ₹2000 service is still
      // owed ₹1500, and hiding that is how a balance goes uncollected.
      outstanding: round2(Math.max(booking.price - paid, 0)),
      payments: own.map(view),
    };
  });

  // A second pass on the money, because paymentStatus is a summary and
  // `outstanding` is the figure actually shown. They agree — this only
  // catches a row mid-transition.
  if (opts.status === "paid") return rows.filter((r) => r.outstanding === 0);
  if (opts.status === "outstanding") return rows.filter((r) => r.outstanding > 0);
  return rows;
}

function view(p: Payment): PaymentRequestView {
  return {
    id: p.id,
    kind: p.kind,
    method: p.method,
    amount: p.amount,
    currency: p.currency,
    status: p.status,
    reference: p.reference,
    link: p.link,
    utr: p.utr,
    paidAt: p.paidAt,
    createdAt: p.createdAt,
  };
}

function sum(values: number[]): number {
  return round2(values.reduce((a, b) => a + b, 0));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
