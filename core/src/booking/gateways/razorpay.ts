/** Razorpay (India). Orders API + in-page Checkout, verified by HMAC-SHA256. */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Booking, Payment } from "@prisma/client";
import { Gateway, type GatewayContext, type StartResult } from "./gateway.js";
import * as Data from "../data.js";
import * as PaymentManager from "../paymentManager.js";
import { GetBooqinError } from "../errors.js";

const API = "https://api.razorpay.com/v1/";

export class RazorpayGateway extends Gateway {
  id() {
    return "razorpay";
  }

  label() {
    return "Card / UPI / Netbanking (Razorpay)";
  }

  description() {
    return "Pay securely without leaving this page.";
  }

  isConfigured(ctx: GatewayContext) {
    return !!this.setting(ctx, "key_id") && !!this.setting(ctx, "key_secret");
  }

  settingsFields() {
    return [
      { key: "key_id", label: "Key ID", type: "text", description: "Razorpay Dashboard → Account & Settings → API Keys." },
      { key: "key_secret", label: "Key Secret", type: "password" },
    ];
  }

  async start(ctx: GatewayContext, booking: Booking, payment: Payment): Promise<StartResult> {
    const response = await fetch(`${API}orders`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.setting(ctx, "key_id")}:${this.setting(ctx, "key_secret")}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: this.minorUnits(payment.amount),
        currency: payment.currency,
        receipt: `getbooqin-${payment.id}`,
        notes: { booking_uid: booking.uid },
      }),
    });
    const body = (await response.json()) as { id?: string; error?: { description?: string } };

    if (!body.id) {
      throw new GetBooqinError(
        "getbooqin_razorpay_order",
        body?.error?.description ?? "Razorpay did not create the order.",
        502
      );
    }

    await PaymentManager.updatePayment(payment.id, { transactionId: body.id });

    const customer = await Data.customer(ctx.shop, booking.customerId);

    return {
      type: "razorpay",
      params: {
        key: this.setting(ctx, "key_id"),
        order_id: body.id,
        amount: this.minorUnits(payment.amount),
        currency: payment.currency,
        name: ctx.settings.business_name,
        prefill: {
          name: customer ? `${customer.firstName} ${customer.lastName}`.trim() : "",
          email: customer?.email ?? "",
          contact: customer?.phone ?? "",
        },
      },
    };
  }

  /** Verify the signature Checkout hands back. This is the only thing that proves payment. */
  async handleVerify(
    ctx: GatewayContext,
    body: Record<string, unknown>,
    payment: Payment,
    _booking: Booking
  ): Promise<void> {
    const orderId = String(body.razorpay_order_id ?? "");
    const paymentId = String(body.razorpay_payment_id ?? "");
    const signature = String(body.razorpay_signature ?? "");

    if (!orderId || !paymentId || !signature) {
      throw new GetBooqinError("getbooqin_razorpay_missing", "Payment confirmation was incomplete.", 400);
    }
    if (orderId !== payment.transactionId) {
      throw new GetBooqinError("getbooqin_razorpay_mismatch", "Payment does not match this booking.", 400);
    }

    const expected = createHmac("sha256", this.setting(ctx, "key_secret"))
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    const expectedBuf = Buffer.from(expected);
    const signatureBuf = Buffer.from(signature);
    const valid =
      expectedBuf.length === signatureBuf.length && timingSafeEqual(expectedBuf, signatureBuf);

    if (!valid) {
      await PaymentManager.markFailed(payment.id, "signature_mismatch");
      throw new GetBooqinError("getbooqin_razorpay_signature", "We could not verify that payment.", 400);
    }

    await PaymentManager.markPaid(ctx.shop, payment.id, paymentId, { order_id: orderId });
  }
}
