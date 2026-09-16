/**
 * The public endpoint Meta posts to.
 *
 * Two properties carry everything. The signature check is the only
 * thing standing between a stranger and a merchant's message log — the
 * URL is public and its shape is documented. And the parser must be
 * *total*: Meta adds fields and event types without warning, and a
 * handler that throws answers 500, which makes Meta retry, which throws
 * again — and after enough of those Meta disables the subscription for
 * the whole app. One unfamiliar payload would cost every merchant their
 * delivery receipts.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseEvent, verificationChallenge, verifySignature } from "../webhook.js";

const SECRET = "app-secret";
const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;

describe("verifySignature", () => {
  const body = JSON.stringify({ entry: [] });

  it("accepts Meta's own signature", () => {
    expect(verifySignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a signature over different bytes", () => {
    // Why the route must hand this the raw body: re-serialising parsed
    // JSON produces different bytes and would fail every time.
    expect(verifySignature(body, sign('{"entry":[ ]}'), SECRET)).toBe(false);
  });

  it("rejects a body that was tampered with after signing", () => {
    expect(verifySignature(`${body} `, sign(body), SECRET)).toBe(false);
  });

  it("tolerates a header without the sha256= prefix", () => {
    expect(verifySignature(body, sign(body).slice("sha256=".length), SECRET)).toBe(true);
  });

  it.each([
    ["no header", null],
    ["empty", ""],
    ["not hex", "sha256=zzzz"],
    ["truncated", "sha256=ab"],
  ])("refuses rather than throwing: %s", (_label, header) => {
    expect(verifySignature(body, header, SECRET)).toBe(false);
  });

  it("refuses when no app secret is configured", () => {
    // Otherwise an unconfigured deployment accepts everything.
    expect(verifySignature(body, sign(body), "")).toBe(false);
  });
});

describe("verificationChallenge", () => {
  const params = (over: Record<string, string> = {}) =>
    new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": "our-token",
      "hub.challenge": "12345",
      ...over,
    });

  it("echoes the challenge when the token matches", () => {
    expect(verificationChallenge(params(), "our-token")).toBe("12345");
  });

  it("refuses a wrong token", () => {
    expect(verificationChallenge(params({ "hub.verify_token": "guess" }), "our-token")).toBeNull();
  });

  it("refuses when no token is configured, rather than accepting any", () => {
    expect(verificationChallenge(params(), "")).toBeNull();
  });

  it("refuses a mode other than subscribe", () => {
    expect(verificationChallenge(params({ "hub.mode": "unsubscribe" }), "our-token")).toBeNull();
  });
});

describe("parseEvent", () => {
  function messages(value: Record<string, unknown>) {
    return JSON.stringify({
      entry: [{ id: "waba-1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "pn-1" }, ...value } }] }],
    });
  }

  it("reads a delivery status", () => {
    const [event] = parseEvent(messages({ statuses: [{ id: "wamid.1", status: "delivered" }] }));

    expect(event).toMatchObject({ kind: "status", providerMessageId: "wamid.1", status: "delivered", phoneNumberId: "pn-1" });
  });

  it("carries the failure reason, which is the only actionable part", () => {
    const [event] = parseEvent(
      messages({ statuses: [{ id: "wamid.1", status: "failed", errors: [{ code: 131026, title: "Receiver is incapable" }] }] })
    );

    expect(event).toMatchObject({ kind: "status", status: "failed", errorCode: "131026", errorTitle: "Receiver is incapable" });
  });

  it("ignores a status word it does not know", () => {
    // Rather than writing it to the row and making an unknown state
    // look like a delivery.
    expect(parseEvent(messages({ statuses: [{ id: "wamid.1", status: "teleported" }] }))).toEqual([]);
  });

  it("reads an inbound reply", () => {
    const [event] = parseEvent(
      messages({ messages: [{ id: "wamid.in", from: "919876543210", text: { body: "can I move this?" } }] })
    );

    expect(event).toMatchObject({ kind: "inbound", fromPhone: "919876543210", text: "can I move this?" });
  });

  it("reads a template approval", () => {
    const [event] = parseEvent(
      JSON.stringify({
        entry: [
          {
            id: "waba-1",
            changes: [
              {
                field: "message_template_status_update",
                value: { message_template_name: "getbooqin_booking_reminder", message_template_language: "en", event: "APPROVED", reason: "NONE" },
              },
            ],
          },
        ],
      })
    );

    expect(event).toMatchObject({ kind: "template_status", name: "getbooqin_booking_reminder", status: "APPROVED", reason: null });
  });

  it("handles a batch carrying several events at once", () => {
    const events = parseEvent(
      messages({
        statuses: [{ id: "a", status: "sent" }, { id: "b", status: "read" }],
        messages: [{ id: "c", from: "91999", text: { body: "ok" } }],
      })
    );

    expect(events).toHaveLength(3);
  });

  it.each([
    ["not JSON", "<html>502</html>"],
    ["empty", ""],
    ["an empty envelope", "{}"],
    ["a field we don't handle", JSON.stringify({ entry: [{ id: "w", changes: [{ field: "flows", value: {} }] }] })],
    ["null values", JSON.stringify({ entry: [{ changes: null }] })],
    ["a status with no id", JSON.stringify({ entry: [{ id: "w", changes: [{ field: "messages", value: { metadata: { phone_number_id: "p" }, statuses: [{ status: "sent" }] } }] }] })],
  ])("returns nothing and never throws for %s", (_label, body) => {
    expect(() => parseEvent(body)).not.toThrow();
    expect(parseEvent(body)).toEqual([]);
  });
});
