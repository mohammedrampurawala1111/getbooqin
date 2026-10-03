/**
 * The pure half of the Razorpay partner adapter.
 *
 * Covered here because these three are where a mistake is both silent
 * and expensive: a signature check that falls open lets anyone on the
 * internet confirm any booking, an event parser that throws turns a
 * captured payment into a 500 and a retry storm, and a minor-units
 * conversion that drifts undercharges every customer by a paisa.
 *
 * The network calls are deliberately not covered — they cannot be
 * exercised without a live partner account, which is exactly why the
 * whole feature sits behind an entitlement granted by no plan.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  authorizeUrl,
  parsePaymentEvent,
  toMinorUnits,
  verifyWebhookSignature,
} from "../razorpayPartner.js";

const SECRET = "whsec_test_secret";
const sign = (body: string, secret = SECRET) => createHmac("sha256", secret).update(body).digest("hex");

describe("verifyWebhookSignature", () => {
  const body = JSON.stringify({ event: "payment.captured" });

  it("accepts a signature over the exact bytes received", () => {
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a body altered after signing", () => {
    expect(verifyWebhookSignature(`${body} `, sign(body), SECRET)).toBe(false);
  });

  it("rejects a signature made with a different account's secret", () => {
    // The per-account secret is the whole reason one merchant's webhook
    // cannot confirm another merchant's bookings.
    expect(verifyWebhookSignature(body, sign(body, "someone_elses_secret"), SECRET)).toBe(false);
  });

  it("fails closed on a missing signature or secret", () => {
    expect(verifyWebhookSignature(body, "", SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, sign(body), "")).toBe(false);
  });

  it("returns false rather than throwing on a wrong-length signature", () => {
    // timingSafeEqual throws on a length mismatch, and a truncated or
    // junk signature is the commonest malformed input there is — a
    // throw here would be a 500 instead of a clean 400.
    expect(() => verifyWebhookSignature(body, "abc", SECRET)).not.toThrow();
    expect(verifyWebhookSignature(body, "abc", SECRET)).toBe(false);
  });
});

describe("parsePaymentEvent", () => {
  const captured = (notes: Record<string, string> = { getbooqin_booking_uid: "bk_123" }) =>
    JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_1", order_id: "order_1", amount: 50000, notes } } },
    });

  it("pulls out what the handler acts on", () => {
    const event = parsePaymentEvent(captured());
    expect(event).toMatchObject({
      event: "payment.captured",
      paymentId: "pay_1",
      orderId: "order_1",
      amountMinor: 50000,
    });
    expect(event?.notes.getbooqin_booking_uid).toBe("bk_123");
  });

  it("recognises payment.failed, which the handler treats differently", () => {
    const body = captured().replace("payment.captured", "payment.failed");
    expect(parsePaymentEvent(body)?.event).toBe("payment.failed");
  });

  it("ignores events we do not handle rather than guessing", () => {
    expect(parsePaymentEvent(JSON.stringify({ event: "order.paid", payload: {} }))).toBeNull();
    expect(parsePaymentEvent(JSON.stringify({ event: "refund.created", payload: {} }))).toBeNull();
  });

  it("returns null on malformed input instead of throwing", () => {
    // A throw here becomes a 500, which makes Razorpay retry forever
    // against a body that will never parse.
    expect(parsePaymentEvent("not json")).toBeNull();
    expect(parsePaymentEvent("")).toBeNull();
    expect(parsePaymentEvent(JSON.stringify({ event: "payment.captured" }))).toBeNull();
    expect(parsePaymentEvent(JSON.stringify({ event: "payment.captured", payload: {} }))).toBeNull();
  });

  it("drops non-string notes rather than passing them through", () => {
    const body = JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { id: "p", order_id: "o", amount: 1, notes: { n: 5, ok: "yes" } } } },
    });
    expect(parsePaymentEvent(body)?.notes).toEqual({ ok: "yes" });
  });

  it("survives an entity with nothing on it", () => {
    const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: {} } } });
    expect(parsePaymentEvent(body)).toMatchObject({ paymentId: "", orderId: "", amountMinor: 0 });
  });
});

describe("toMinorUnits", () => {
  it("converts whole and fractional amounts", () => {
    expect(toMinorUnits(500)).toBe(50000);
    expect(toMinorUnits(0.5)).toBe(50);
  });

  it("rounds rather than truncating the float error", () => {
    // 1234.56 * 100 is 123455.99999999999 — a truncating conversion
    // undercharges by a paisa on a large share of real amounts.
    expect(toMinorUnits(1234.56)).toBe(123456);
    expect(toMinorUnits(19.99)).toBe(1999);
    expect(toMinorUnits(8.29)).toBe(829);
  });
});

describe("authorizeUrl", () => {
  it("carries the state through, since it is the only CSRF defence the callback has", () => {
    const url = new URL(authorizeUrl("nonce-123", "https://app.example/cb"));
    expect(url.searchParams.get("state")).toBe("nonce-123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example/cb");
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("asks for no scope beyond what the integration uses", () => {
    // A scope we never exercise can only ever be a liability — we have
    // no business reading where a merchant's money settles.
    expect(new URL(authorizeUrl("s", "https://app.example/cb")).searchParams.get("scope")).toBe("read_write");
  });
});
