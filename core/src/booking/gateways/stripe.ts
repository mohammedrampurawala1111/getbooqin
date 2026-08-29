/** Stripe Checkout. Hosted page, verified server-side on return. */
import type { Booking, Payment } from "@prisma/client";
import { Gateway, type GatewayContext, type StartResult } from "./gateway.js";
import * as Data from "../data.js";
import * as PaymentManager from "../paymentManager.js";
import { GetBooqinError } from "../errors.js";

const API = "https://api.stripe.com/v1/";

export class StripeGateway extends Gateway {
  id() {
    return "stripe";
  }

  label() {
    return "Card (Stripe)";
  }

  description() {
    return "You will be taken to Stripe to pay, then brought back here.";
  }

  isConfigured(ctx: GatewayContext) {
    return !!this.setting(ctx, "secret_key");
  }

  settingsFields() {
    return [
      {
        key: "secret_key",
        label: "Secret key",
        type: "password",
        description: "Starts with sk_live_ or sk_test_. Stripe Dashboard → Developers → API keys.",
      },
    ];
  }

  private async request(
    ctx: GatewayContext,
    path: string,
    body: URLSearchParams | null,
    method: "GET" | "POST" = "POST"
  ): Promise<Record<string, any>> {
    const response = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.setting(ctx, "secret_key")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body ?? undefined,
    });
    return response.json() as Promise<Record<string, any>>;
  }

  async start(ctx: GatewayContext, booking: Booking, payment: Payment): Promise<StartResult> {
    const service = await Data.catalogService(ctx.shop, booking.serviceId);
    const customer = await Data.customer(ctx.shop, booking.customerId);

    const body = new URLSearchParams({
      mode: "payment",
      success_url: `${this.returnUrl(ctx, payment)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: this.cancelUrl(ctx, booking),
      client_reference_id: booking.uid,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": payment.currency.toLowerCase(),
      "line_items[0][price_data][unit_amount]": String(this.minorUnits(payment.amount)),
      "line_items[0][price_data][product_data][name]": service ? service.name : "Booking",
    });
    if (customer?.email) body.set("customer_email", customer.email);

    const session = await this.request(ctx, "checkout/sessions", body);

    if (!session.url) {
      throw new GetBooqinError(
        "getbooqin_stripe_session",
        session?.error?.message ?? "Stripe did not create a checkout session.",
        502
      );
    }

    await PaymentManager.updatePayment(payment.id, { transactionId: session.id });

    return { type: "redirect", url: session.url };
  }

  async handleReturn(ctx: GatewayContext, params: URLSearchParams, payment: Payment, _booking: Booking): Promise<void> {
    const sessionId = params.get("session_id") ?? "";
    if (!sessionId || sessionId !== payment.transactionId) {
      throw new GetBooqinError("getbooqin_stripe_mismatch", "That payment does not match this booking.", 400);
    }

    // Never trust the redirect — ask Stripe directly.
    const session = await this.request(ctx, `checkout/sessions/${encodeURIComponent(sessionId)}`, null, "GET");

    if (session.payment_status !== "paid") {
      await PaymentManager.markFailed(payment.id, "not_paid");
      throw new GetBooqinError("getbooqin_stripe_unpaid", "Stripe reports this payment as incomplete.", 402);
    }

    await PaymentManager.markPaid(ctx.shop, payment.id, session.payment_intent ?? sessionId, { session_id: sessionId });
  }
}
