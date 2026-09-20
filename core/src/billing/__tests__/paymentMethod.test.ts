/**
 * "Which card is this coming off?"
 *
 * The answer is read from the provider rather than stored at checkout,
 * because the instrument changes without us — a card replaced on
 * expiry, a UPI mandate moved to another app. What these tests pin down
 * is the shape of the answer: a label a merchant recognises, never the
 * full instrument, and never a crash on a payload shape the vendor
 * added since.
 */
import { describe, expect, it } from "vitest";
import { describePayment } from "../providers/razorpay.js";

describe("Razorpay payment → something a merchant recognises", () => {
  it("names the network and the last four for a card", () => {
    const method = describePayment({ method: "card", card: { network: "Visa", last4: "4526" } });

    expect(method).toEqual({ kind: "card", label: "Visa ending 4526" });
  });

  it("shows the VPA for UPI, which is how a merchant thinks about their mandate", () => {
    // There is no last-four equivalent for UPI — the VPA is the
    // recognisable thing.
    const method = describePayment({ method: "upi", vpa: "priya@okhdfcbank" });

    expect(method).toEqual({ kind: "upi", label: "UPI · priya@okhdfcbank" });
  });

  it("names the bank for an e-mandate", () => {
    expect(describePayment({ method: "emandate", bank: "HDFC" })).toEqual({
      kind: "emandate",
      label: "Bank mandate · HDFC",
    });
  });

  it("names the bank for net banking", () => {
    expect(describePayment({ method: "netbanking", bank: "ICICI" })?.label).toBe("Net banking · ICICI");
  });

  it("names the wallet", () => {
    expect(describePayment({ method: "wallet", wallet: "Paytm" })?.label).toBe("Paytm");
  });
});

describe("what it does when the vendor is unhelpful", () => {
  it("still says 'Card' when the card details have been purged", () => {
    // Razorpay does occasionally return a payment whose card object is
    // gone. "Card" beats a blank row.
    expect(describePayment({ method: "card", card: {} })?.label).toBe("Card");
  });

  it("falls back to the network alone when there is no last four", () => {
    expect(describePayment({ method: "card", card: { network: "Mastercard" } })?.label).toBe("Mastercard");
  });

  it("says UPI AutoPay when the VPA is missing", () => {
    expect(describePayment({ method: "upi" })?.label).toBe("UPI AutoPay");
  });

  it("passes through a method it has never heard of rather than guessing", () => {
    // A method Razorpay adds after this was written. Its own word for
    // it beats inventing one, and beats showing nothing.
    expect(describePayment({ method: "cardless_emi" })).toEqual({
      kind: "cardless_emi",
      label: "cardless_emi",
    });
  });

  it.each([{}, { method: "" }, { method: 42 }])("returns null for %p rather than throwing", (payload) => {
    // This renders a card on a settings page and must never be why that
    // page fails.
    expect(describePayment(payload as Record<string, unknown>)).toBeNull();
  });
});

describe("what must never appear in a label", () => {
  it("never carries a full card number, even when the vendor sends one", () => {
    // Belt and braces: Razorpay does not return a PAN, and if a future
    // payload ever did, it must not reach a rendered string.
    const method = describePayment({
      method: "card",
      card: { network: "Visa", last4: "4526", number: "4111111111111111" },
    });

    expect(method!.label).not.toContain("4111");
    expect(method!.label).toBe("Visa ending 4526");
  });

  it("is short enough to sit on one line", () => {
    const method = describePayment({ method: "card", card: { network: "Mastercard", last4: "0001" } });
    expect(method!.label.length).toBeLessThan(40);
  });
});
