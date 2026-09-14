/**
 * The link a customer pays through.
 *
 * This is the one piece of the payments feature where a mistake moves
 * money to the wrong place. A malformed UPI link fails in the payer's
 * app, which is annoying; a well-formed one with the wrong amount or
 * the wrong payee does not fail at all.
 */
import { describe, expect, it } from "vitest";
import {
  paymentLink,
  isUpiId,
  payPalMeHandle,
  availableMethod,
  amountDueFor,
  paymentReference,
  upiAppLinks,
} from "../paymentLinks.js";

const payee = { upiId: "acme@okhdfcbank", payPalMe: "acmedental", payeeName: "Acme Dental" };
const req = { payee, amount: 500, currency: "INR", reference: "BK-4821", note: "Deposit BK-4821" };

describe("the UPI link", () => {
  it("carries payee, amount, currency, note and reference", () => {
    const link = paymentLink("upi", req);
    const params = new URLSearchParams(link.replace("upi://pay?", ""));

    expect(link.startsWith("upi://pay?")).toBe(true);
    expect(params.get("pa")).toBe("acme@okhdfcbank");
    expect(params.get("pn")).toBe("Acme Dental");
    expect(params.get("cu")).toBe("INR");
    // The reference is what lets a merchant match a bank line to a booking.
    expect(params.get("tr")).toBe("BK-4821");
  });

  it("always states the amount to two decimals", () => {
    // A payment app shows exactly what it is handed. "500" and "500.5"
    // both read as wrong to someone checking an invoice.
    expect(new URLSearchParams(paymentLink("upi", req).replace("upi://pay?", "")).get("am")).toBe("500.00");
    expect(
      new URLSearchParams(paymentLink("upi", { ...req, amount: 500.5 }).replace("upi://pay?", "")).get("am")
    ).toBe("500.50");
  });

  it("encodes spaces as %20, not +", () => {
    // Some UPI apps pass "+" through into the note literally rather than
    // decoding it, so the customer sees "Deposit+BK-4821".
    const link = paymentLink("upi", req);

    expect(link).not.toContain("+");
    expect(link).toContain("%20");
  });

  it("refuses to build a link for an address that is not a VPA", () => {
    // Better no link than a link that silently pays nobody.
    for (const bad of ["", "acme", "acme@", "@bank", "acme bank", "acme@@bank"]) {
      expect(paymentLink("upi", { ...req, payee: { ...payee, upiId: bad } }), bad).toBe("");
    }
  });

  it("accepts the shapes real PSPs actually issue", () => {
    for (const good of [
      "acme@okhdfcbank",
      "9876543210@paytm",
      "acme.dental@ybl",
      "acme-dental@okaxis",
      "ACME@OKICICI",
    ]) {
      expect(isUpiId(good), good).toBe(true);
    }
  });
});

describe("the PayPal link", () => {
  it("puts the amount and currency in the path", () => {
    expect(paymentLink("paypal", { ...req, currency: "EUR", amount: 25 })).toBe(
      "https://paypal.me/acmedental/25.00EUR"
    );
  });

  it("accepts a handle, an @handle or a pasted full URL", () => {
    // Merchants paste whatever their app showed them.
    for (const input of ["acmedental", "@acmedental", "https://paypal.me/acmedental", "paypal.me/acmedental"]) {
      expect(payPalMeHandle(input), input).toBe("acmedental");
    }
  });

  it("rejects a handle with characters PayPal does not allow", () => {
    expect(payPalMeHandle("acme dental")).toBe("");
    expect(payPalMeHandle("acme/dental")).toBe("");
    expect(paymentLink("paypal", { ...req, payee: { ...payee, payPalMe: "acme dental" } })).toBe("");
  });
});

describe("choosing a method", () => {
  it("offers UPI only to a shop billing in rupees", () => {
    // A euro-priced shop given a UPI link would either fail or quietly
    // ask for rupees.
    expect(availableMethod(payee, "INR")).toBe("upi");
    expect(availableMethod(payee, "EUR")).toBe("paypal");
    expect(availableMethod(payee, "USD")).toBe("paypal");
  });

  it("falls back to PayPal for an Indian shop with no UPI set", () => {
    expect(availableMethod({ ...payee, upiId: "" }, "INR")).toBe("paypal");
  });

  it("offers nothing when nothing is configured", () => {
    expect(availableMethod({ payeeName: "Acme" }, "INR")).toBeNull();
  });
});

describe("what is owed", () => {
  const full = { paymentRequired: true, depositPercent: 100, depositAmount: 0 };

  it("asks for nothing when the service doesn't require payment", () => {
    expect(amountDueFor(2000, { ...full, paymentRequired: false })).toBe(0);
  });

  it("takes a percentage of the price", () => {
    expect(amountDueFor(2000, { ...full, depositPercent: 25 })).toBe(500);
    expect(amountDueFor(999, { ...full, depositPercent: 20 })).toBe(199.8);
  });

  it("takes a fixed amount in preference to a percentage", () => {
    // A merchant who typed an amount meant the amount.
    expect(amountDueFor(2000, { paymentRequired: true, depositPercent: 25, depositAmount: 300 })).toBe(300);
  });

  it("asks for the full price at 100 percent", () => {
    expect(amountDueFor(2000, full)).toBe(2000);
  });

  it("never asks for more than the service costs", () => {
    // A fixed deposit larger than the price is a typo, and charging it
    // would be worse than ignoring it.
    expect(amountDueFor(500, { paymentRequired: true, depositPercent: 0, depositAmount: 5000 })).toBe(500);
    expect(amountDueFor(500, { paymentRequired: true, depositPercent: 300, depositAmount: 0 })).toBe(500);
  });

  it("asks for nothing on a free service", () => {
    expect(amountDueFor(0, full)).toBe(0);
  });

  it("rounds to whole currency units", () => {
    // 33% of 1000 is 330.00000000000006 in binary floating point, and
    // that is what would end up in the link.
    expect(amountDueFor(1000, { ...full, depositPercent: 33 })).toBe(330);
  });
});

describe("the reference", () => {
  it("is short enough to read out over the phone", () => {
    const ref = paymentReference("bk_9f2a4c7d1e8b");

    expect(ref).toBe("BK7D1E8B");
    expect(ref.length).toBeLessThanOrEqual(10);
  });

  it("contains nothing a UPI app would reject", () => {
    // NPCI's `tr` field is alphanumeric. A hyphen or underscore in it
    // makes the link fail on some phones and work on others, with
    // nothing on screen saying why — `bk_test_0001` used to yield
    // "BK-T_0001".
    for (const uid of ["bk_test_0001", "bk-9f2a-4c7d", "bk_9f2a4c7d1e8b", "____", "a"]) {
      expect(paymentReference(uid), uid).toMatch(/^[A-Z0-9]+$/);
    }
  });

  it("stays usable for a uid that is mostly punctuation", () => {
    expect(paymentReference("bk_-_-_-")).toMatch(/^BK[A-Z0-9]{6}$/);
  });
});

describe("choosing which UPI app opens", () => {
  /**
   * `upi://` is handled by every certified app, so Android sends it to
   * whichever holds the default — and WhatsApp registers as one. A
   * customer with WhatsApp Pay as default was taken there with no
   * chooser, and no way to pay with the app they actually use.
   */
  it("offers the generic link plus one per major app", () => {
    const links = upiAppLinks(req);

    expect(links.map((l) => l.id)).toEqual(["any", "phonepe", "gpay", "paytm", "bhim"]);
  });

  it("gives every app the identical payment, only a different door", () => {
    const links = upiAppLinks(req);
    const query = links[0].url.slice(links[0].url.indexOf("?"));

    for (const link of links.slice(1)) {
      expect(link.url.endsWith(query), link.id).toBe(true);
      expect(link.url).toContain("pa=acme%40okhdfcbank");
      expect(link.url).toContain("am=500.00");
    }
  });

  it("uses each app's published scheme", () => {
    const byId = Object.fromEntries(upiAppLinks(req).map((l) => [l.id, l.url]));

    expect(byId.phonepe.startsWith("phonepe://upi/pay?")).toBe(true);
    expect(byId.gpay.startsWith("gpay://upi/pay?")).toBe(true);
    expect(byId.paytm.startsWith("paytm://upi/pay?")).toBe(true);
    expect(byId.bhim.startsWith("bhim://upi/pay?")).toBe(true);
  });

  it("offers nothing when there is no payable UPI request", () => {
    // So a caller can render the list without guarding first.
    expect(upiAppLinks({ ...req, payee: { ...payee, upiId: "" } })).toEqual([]);
  });
});
