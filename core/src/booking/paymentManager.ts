/** Payment orchestration. Ported from shopify-openslot/app/lib/paymentManager.server.ts. */
import type { Booking, Payment } from "@prisma/client";
import type { CatalogService } from "./data.js";
import prisma from "../db.js";
import { Gateway, type GatewayContext } from "./gateways/gateway.js";
export type { GatewayContext };
import { OfflineGateway } from "./gateways/offline.js";
import { RazorpayGateway } from "./gateways/razorpay.js";
import { StripeGateway } from "./gateways/stripe.js";
import { PayPalGateway } from "./gateways/paypal.js";
import type { Settings } from "./settings.js";
import { getSettings, setSettings } from "./settings.js";
import { GetBooqinError } from "./errors.js";
import { now } from "./ids.js";
import events from "./events.js";
import * as Bookings from "./bookings.js";
import { PAYMENTS_ENABLED } from "./featureFlags.js";

const REGISTRY: Record<string, Gateway> = {
  offline: new OfflineGateway(),
  razorpay: new RazorpayGateway(),
  stripe: new StripeGateway(),
  paypal: new PayPalGateway(),
};

export function gateways(): Record<string, Gateway> {
  return REGISTRY;
}

export function gateway(id: string): Gateway | null {
  return REGISTRY[id] ?? null;
}

/** Gateways that are both switched on and correctly configured. */
export function activeGateways(settings: Settings): Array<[string, Gateway]> {
  if (!PAYMENTS_ENABLED) return [];
  const enabled = settings.enabled_gateways ?? [];
  const ctx = fakeCtxFor(settings);
  return Object.entries(REGISTRY).filter(([id, g]) => enabled.includes(id) && g.isConfigured(ctx));
}

// isConfigured only reads settings, so a minimal context is fine here.
function fakeCtxFor(settings: Settings): GatewayContext {
  return { shop: "", settings, appProxyBase: "", manageUrl: () => "" };
}

export function paymentsAvailable(settings: Settings): boolean {
  return activeGateways(settings).length > 0;
}

/** Active gateways that can actually take money and tell us about it. */
export function settlingGateways(settings: Settings): Array<[string, Gateway]> {
  return activeGateways(settings).filter(([, g]) => g.canSettle());
}

export function canSettleOnline(settings: Settings): boolean {
  return settlingGateways(settings).length > 0;
}

export async function saveGatewaySettings(shop: string, platform: string, gatewayId: string, values: Record<string, string | boolean>) {
  const current = await getSettings(shop, platform);
  const merged = { ...current.gateways, [gatewayId]: { ...current.gateways[gatewayId], ...values } };
  return setSettings(shop, platform, { gateways: merged });
}

/* -------------------------------------------------------- Amount policy */

/** What the customer owes online for this booking, honouring the service's deposit percentage. */
export function amountDue(service: CatalogService): number {
  const price = service.price;
  if (price <= 0) return 0;
  const percent = service.depositPercent > 0 ? service.depositPercent : 100;
  const clamped = Math.max(1, Math.min(100, percent));
  return Math.round(price * (clamped / 100) * 100) / 100;
}

/** Does this booking block confirmation until it is paid? */
export async function paymentBlocksConfirmation(shop: string, settings: Settings, service: CatalogService): Promise<boolean> {
  void shop;
  // Only block on a gateway that can actually settle — otherwise Pending would be a deadlock.
  return service.paymentRequired && canSettleOnline(settings) && amountDue(service) > 0;
}

/* --------------------------------------------------------- Payment rows */

export function get(id: number) {
  return prisma.payment.findUnique({ where: { id } });
}

export function forBooking(shop: string, bookingId: number) {
  return prisma.payment.findMany({ where: { shop, bookingId }, orderBy: { id: "desc" } });
}

export async function createPayment(shop: string, platform: string, booking: Booking, gatewayId: string): Promise<Payment> {
  return prisma.payment.create({
    data: {
      shop,
      platform,
      bookingId: booking.id,
      gateway: gatewayId,
      amount: booking.amountDue,
      currency: booking.currency,
      status: "pending",
      createdAt: now(),
      updatedAt: now(),
    },
  });
}

export async function updatePayment(id: number, values: Partial<Payment>) {
  await prisma.payment.update({ where: { id }, data: { ...values, updatedAt: now() } });
}

export interface StartOutcome {
  payment_id: number;
  type: string;
  url?: string;
  params?: Record<string, unknown>;
  message?: string;
}

/** Start (or restart) a payment for a booking. */
export async function start(ctx: GatewayContext, platform: string, booking: Booking, gatewayId: string): Promise<StartOutcome> {
  const g = gateway(gatewayId);
  const active = activeGateways(ctx.settings).map(([id]) => id);

  if (!g || !active.includes(gatewayId)) {
    throw new GetBooqinError("getbooqin_gateway_unavailable", "That payment method is not available.", 400);
  }
  if (booking.paymentStatus === "paid") {
    throw new GetBooqinError("getbooqin_already_paid", "This booking is already paid.", 400);
  }
  if (booking.amountDue <= 0) {
    throw new GetBooqinError("getbooqin_nothing_due", "There is nothing to pay for this booking.", 400);
  }

  const payment = await createPayment(ctx.shop, platform, booking, gatewayId);

  try {
    const result = await g.start(ctx, booking, payment);
    return { payment_id: payment.id, ...result };
  } catch (err) {
    await updatePayment(payment.id, { status: "failed" });
    throw err;
  }
}

/* ------------------------------------------------------------ Outcomes */

export async function markPaid(
  shop: string,
  paymentId: number,
  transactionId = "",
  payload: Record<string, unknown> = {}
): Promise<void> {
  const payment = await get(paymentId);
  if (!payment || payment.status === "paid") return;

  await updatePayment(payment.id, {
    status: "paid",
    transactionId,
    payload: JSON.stringify(payload),
  });

  const booking = await Bookings.get(shop, payment.bookingId);
  if (!booking) return;

  await prisma.booking.update({
    where: { id: booking.id },
    data: { paymentStatus: "paid", updatedAt: now() },
  });

  // A booking held only for payment can now be confirmed.
  if (booking.status === "pending") {
    await Bookings.setStatus(shop, booking.id, "confirmed", "payment_received");
  }

  const fresh = await Bookings.get(shop, booking.id);
  if (fresh) events.emitEvent("payment_completed", fresh, payment.id);
}

export async function markFailed(paymentId: number, _reason = ""): Promise<void> {
  const payment = await get(paymentId);
  if (!payment) return;
  await updatePayment(payment.id, { status: "failed", payload: JSON.stringify({ reason: _reason }) });

  const booking = await prisma.booking.findUnique({ where: { id: payment.bookingId } });
  if (booking && booking.paymentStatus !== "paid") {
    await prisma.booking.update({ where: { id: booking.id }, data: { paymentStatus: "unpaid" } });
  }
}

export async function markRefunded(paymentId: number): Promise<void> {
  const payment = await get(paymentId);
  if (!payment) return;
  await updatePayment(paymentId, { status: "refunded" });
  await prisma.booking.update({ where: { id: payment.bookingId }, data: { paymentStatus: "refunded" } });
}

export function onBookingCancelled(booking: Booking, reason = ""): void {
  // Record intent only — automated refunds are deliberately not attempted.
  if (booking.paymentStatus === "paid") {
    events.emitEvent("paid_booking_cancelled", booking, reason);
  }
}

/** Payment options offered to the customer for a booking. */
export function optionsFor(ctx: GatewayContext): Array<{ id: string; label: string; description: string }> {
  return activeGateways(ctx.settings).map(([id, g]) => ({
    id,
    label: g.label(ctx),
    description: g.description(ctx),
  }));
}

export function init() {
  events.onEvent("booking_cancelled", (booking, reason) => onBookingCancelled(booking, reason));
}
