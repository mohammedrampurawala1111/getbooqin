/** PayPal Orders v2. Redirect to approve, capture server-side on return. */
import type { Booking, Payment } from "@prisma/client";
import { Gateway, type GatewayContext, type StartResult } from "./gateway.js";
import * as Data from "../data.js";
import * as PaymentManager from "../paymentManager.js";
import { GetBooqinError } from "../errors.js";

// In-memory token cache, keyed like the PHP transient was.
const tokenCache = new Map<string, { token: string; expires: number }>();

export class PayPalGateway extends Gateway {
  id() {
    return "paypal";
  }

  label() {
    return "PayPal";
  }

  description() {
    return "Pay with a PayPal account or card.";
  }

  isConfigured(ctx: GatewayContext) {
    return !!this.setting(ctx, "client_id") && !!this.setting(ctx, "client_secret");
  }

  settingsFields() {
    return [
      { key: "client_id", label: "Client ID", type: "text", description: "PayPal Developer Dashboard → Apps & Credentials." },
      { key: "client_secret", label: "Client secret", type: "password" },
      { key: "sandbox", label: "Use sandbox (test) mode", type: "checkbox" },
    ];
  }

  private base(ctx: GatewayContext): string {
    return this.setting(ctx, "sandbox") ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";
  }

  private async token(ctx: GatewayContext): Promise<string> {
    const cacheKey = `${this.setting(ctx, "client_id")}|${this.base(ctx)}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.token;

    const response = await fetch(`${this.base(ctx)}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.setting(ctx, "client_id")}:${this.setting(ctx, "client_secret")}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) {
      throw new GetBooqinError("getbooqin_paypal_auth", "PayPal rejected those credentials.", 502);
    }
    const ttl = Math.max(60, (body.expires_in ?? 300) - 60) * 1000;
    tokenCache.set(cacheKey, { token: body.access_token, expires: Date.now() + ttl });
    return body.access_token;
  }

  private async request(
    ctx: GatewayContext,
    path: string,
    body: Record<string, unknown> | null,
    method: "GET" | "POST" = "POST"
  ): Promise<Record<string, any>> {
    const token = await this.token(ctx);
    const response = await fetch(`${this.base(ctx)}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return response.json() as Promise<Record<string, any>>;
  }

  async start(ctx: GatewayContext, booking: Booking, payment: Payment): Promise<StartResult> {
    const service = await Data.catalogService(ctx.shop, booking.serviceId);

    const order = await this.request(ctx, "/v2/checkout/orders", {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: booking.uid,
          description: service ? service.name.slice(0, 120) : "Booking",
          amount: { currency_code: payment.currency, value: payment.amount.toFixed(2) },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: this.returnUrl(ctx, payment),
            cancel_url: this.cancelUrl(ctx, booking),
            user_action: "PAY_NOW",
          },
        },
      },
    });

    if (!order.id) {
      throw new GetBooqinError("getbooqin_paypal_order", order?.message ?? "PayPal did not create the order.", 502);
    }

    const approve = (order.links ?? []).find((l: any) => l.rel === "payer-action" || l.rel === "approve")?.href;
    if (!approve) {
      throw new GetBooqinError("getbooqin_paypal_link", "PayPal did not return an approval link.", 502);
    }

    await PaymentManager.updatePayment(payment.id, { transactionId: order.id });

    return { type: "redirect", url: approve };
  }

  async handleReturn(ctx: GatewayContext, _params: URLSearchParams, payment: Payment, _booking: Booking): Promise<void> {
    const orderId = payment.transactionId;
    if (!orderId) {
      throw new GetBooqinError("getbooqin_paypal_missing", "No PayPal order is attached to this payment.", 400);
    }

    const capture = await this.request(ctx, `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {});

    if (capture.status !== "COMPLETED") {
      await PaymentManager.markFailed(payment.id, capture.status ?? "unknown");
      throw new GetBooqinError("getbooqin_paypal_incomplete", "PayPal reports this payment as incomplete.", 402);
    }

    await PaymentManager.markPaid(ctx.shop, payment.id, orderId, { capture: capture.status });
  }
}
