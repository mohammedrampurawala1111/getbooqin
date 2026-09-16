/**
 * The five templates, and the positional-parameter trap.
 *
 * Meta's variables are `{{1}}`, `{{2}}` — position, not name. Reorder
 * `variables` without resubmitting the template and the time lands
 * where the service name should be, silently, in a message a customer
 * receives. These tests are mostly about making that impossible to do
 * by accident.
 */
import { describe, expect, it } from "vitest";
import {
  TEMPLATE_KEYS,
  WHATSAPP_TEMPLATES,
  keyFromMetaName,
  metaName,
  orderedParameters,
  previewBody,
  templateFor,
} from "../templates.js";
import { toWhatsAppNumber, urlSuffix } from "../send.js";

const FULL = {
  customer_name: "Priya",
  business_name: "Sunrise Dental",
  service: "Cleaning",
  date: "Mon 3 Mar",
  time: "10:30",
  resource: "Dr Rao",
  manage_url: "https://app.getbooqin.com/book/sunrise?getbooqin_booking=abc",
  claim_url: "https://app.getbooqin.com/book/sunrise?getbooqin_claim=abc",
  expires_at: "18:00",
};

describe("the catalogue", () => {
  it("is the five we agreed to get approved, and no more", () => {
    // Each extra template is another per-merchant Meta approval that can
    // sit in PENDING on the day it is needed.
    expect(TEMPLATE_KEYS).toHaveLength(5);
  });

  it("is UTILITY throughout — every message follows something the customer did", () => {
    // A reminder submitted as MARKETING is rejected, and rightly.
    expect(WHATSAPP_TEMPLATES.every((t) => t.category === "UTILITY")).toBe(true);
  });

  it("numbers every placeholder in its body against a real variable", () => {
    for (const def of WHATSAPP_TEMPLATES) {
      const positions = [...def.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
      for (const position of positions) {
        expect(def.variables[position - 1], `${def.key} uses {{${position}}} with no variable behind it`).toBeDefined();
      }
    }
  });

  it("declares no variable its body never uses", () => {
    // An unused variable still consumes a position, which shifts every
    // one after it.
    for (const def of WHATSAPP_TEMPLATES) {
      const used = new Set([...def.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])));
      def.variables.forEach((name, index) => {
        if (def.button?.urlVariable === name) return;
        expect(used.has(index + 1), `${def.key} declares ${name} at {{${index + 1}}} and never uses it`).toBe(true);
      });
    }
  });

  it("namespaces every name, because these live in the merchant's own WABA", () => {
    // A template called plainly "booking_reminder" would collide with
    // one a merchant created themselves.
    for (const key of TEMPLATE_KEYS) expect(metaName(key)).toBe(`getbooqin_${key}`);
  });

  it("round-trips a name back to its key", () => {
    for (const key of TEMPLATE_KEYS) expect(keyFromMetaName(metaName(key))).toBe(key);
  });

  it("does not claim a merchant's own template as ours", () => {
    expect(keyFromMetaName("appointment_reminder")).toBeNull();
    expect(keyFromMetaName("getbooqin_something_else")).toBeNull();
  });
});

describe("orderedParameters", () => {
  it("returns values in the declared order, not the order they were passed", () => {
    const params = orderedParameters("booking_confirmed", FULL);

    expect(params).toEqual(["Priya", "Sunrise Dental", "Cleaning", "Mon 3 Mar", "10:30", "Dr Rao"]);
  });

  it.each(["", "   ", undefined])("refuses a blank parameter (%p) instead of letting Meta reject it", (value) => {
    // Meta answers a blank parameter with an opaque 132000, and the
    // message would have read "your booking with  on  at ".
    expect(() => orderedParameters("booking_confirmed", { ...FULL, service: value as string })).toThrow(/service/);
  });

  it("collapses whitespace, which Meta rejects outright", () => {
    // "Cut, colour\n& finish" is a thing a merchant can genuinely type
    // into a service name.
    const params = orderedParameters("booking_confirmed", { ...FULL, service: "Cut,\n colour\t& finish" });

    expect(params[2]).toBe("Cut, colour & finish");
  });

  it("names the token in the error, so the failure is actionable", () => {
    expect(() => orderedParameters("waitlist_offered", { ...FULL, expires_at: "" })).toThrow(/expires_at/);
  });

  it("builds every template in the catalogue from one full value set", () => {
    // Guards against a template declaring a variable nothing populates.
    for (const key of TEMPLATE_KEYS) {
      expect(() => orderedParameters(key, FULL)).not.toThrow();
    }
  });
});

describe("previewBody", () => {
  it("shows a merchant real words rather than {{1}}", () => {
    const preview = previewBody("booking_reminder", FULL);

    expect(preview).toContain("Priya");
    expect(preview).toContain("Sunrise Dental");
    expect(preview).not.toContain("{{");
  });
});

describe("templateFor", () => {
  it("throws for a key that isn't in the catalogue", () => {
    expect(() => templateFor("nonsense" as never)).toThrow(/nonsense/);
  });
});

describe("toWhatsAppNumber", () => {
  it.each([
    ["+91 98765 43210", "919876543210"],
    ["919876543210", "919876543210"],
    ["0091 98765 43210", "919876543210"],
    ["+1 (555) 010-0200", "15550100200"],
  ])("normalises %s", (input, expected) => {
    expect(toWhatsAppNumber(input)).toBe(expected);
  });

  it.each(["", "call the front desk", "12345", "0000000000", "+" ])("refuses %p rather than letting Meta fail the send", (input) => {
    // A failed send counts against the merchant's quality rating, and a
    // number that was never a number is knowable here.
    expect(toWhatsAppNumber(input)).toBeNull();
  });
});

describe("urlSuffix", () => {
  it("reduces a link to what Meta appends to the registered base", () => {
    // A dynamic URL button cannot point anywhere it likes — the fixed
    // base is exactly why Meta allows a variable link at all.
    expect(urlSuffix("https://app.getbooqin.com/book/x?getbooqin_booking=abc")).toBe("book/x?getbooqin_booking=abc");
  });

  it("survives something that isn't a URL", () => {
    expect(() => urlSuffix("not a url")).not.toThrow();
  });
});
