/**
 * Tax identity for an Indian seller selling worldwide. Pure — no DB.
 *
 * The load-bearing rule is the one about non-India customers: requiring
 * a business tax number is what makes every foreign sale a B2B export.
 * Without it, selling to an EU consumer makes us a non-EU supplier of
 * electronically supplied services, which triggers non-Union OSS
 * registration from the first euro with no threshold.
 */
import { describe, expect, it } from "vitest";
import { normalizeCountry, normalizeTaxId, statusForCountry, looksLikeGstin, looksLikeTaxId, validateTaxIdentity, taxNote } from "../tax.js";

describe("country", () => {
  it("normalises to ISO alpha-2", () => {
    expect(normalizeCountry(" in ")).toBe("IN");
    expect(normalizeCountry("nl")).toBe("NL");
  });

  it("rejects anything that isn't two letters rather than guessing", () => {
    for (const bad of ["", "IND", "1N", "india", null, undefined]) {
      expect(normalizeCountry(bad as string), String(bad)).toBe("");
    }
  });

  it("India is a domestic supply, everywhere else is an export", () => {
    expect(statusForCountry("IN")).toBe("india_gst");
    for (const c of ["NL", "US", "GB", "AU", "SG"]) {
      expect(statusForCountry(c), c).toBe("export_zero_rated");
    }
  });
});

describe("identifier shapes", () => {
  it("accepts a well-formed GSTIN", () => {
    expect(looksLikeGstin("27AAPFU0939F1ZV")).toBe(true);
  });

  it("rejects a GSTIN of the wrong shape", () => {
    for (const bad of ["27AAPFU0939F1Z", "AAPFU0939F1ZVX", "27aapfu0939f1zX9", ""]) {
      expect(looksLikeGstin(bad), bad).toBe(false);
    }
  });

  it("accepts an EU-style VAT number and ignores spacing", () => {
    expect(looksLikeTaxId("NL123456789B01")).toBe(true);
    expect(looksLikeTaxId("DE811907980")).toBe(true);
    // Spacing and hyphens are how people actually type these, and are
    // stripped before matching rather than rejected.
    expect(looksLikeTaxId("de 811 907 980")).toBe(true);
    expect(normalizeTaxId(" nl1234-5678 9b01 ")).toBe("NL123456789B01");
  });

  it("accepts the business numbers the rest of the world actually has", () => {
    // This used to require an EU country prefix, applied to every
    // country outside India — so no US, Canadian, Australian,
    // Singaporean or Japanese business could subscribe at all.
    expect(looksLikeTaxId("12-3456789"), "US EIN").toBe(true);
    expect(looksLikeTaxId("51 824 753 556"), "Australian ABN").toBe(true);
    expect(looksLikeTaxId("123456789RT0001"), "Canadian BN").toBe(true);
    expect(looksLikeTaxId("201012345K"), "Singapore UEN").toBe(true);
    expect(looksLikeTaxId("1234567890123"), "Japanese corporate number").toBe(true);
  });

  it("still rejects what is obviously not a tax number", () => {
    // All a shape check can honestly claim: catch the empty gesture,
    // not validate a real registration.
    for (const junk of ["", "n/a", "none", "-", "abc", "12"]) {
      expect(looksLikeTaxId(junk), junk).toBe(false);
    }
  });

  it("requires at least one digit, so a word is never a tax number", () => {
    expect(looksLikeTaxId("NOTAPPLICABLE")).toBe(false);
  });
});

describe("validateTaxIdentity()", () => {
  it("refuses without a country — the whole treatment turns on it", () => {
    const { identity, problems } = validateTaxIdentity({ taxId: "NL123456789B01" });
    expect(identity).toBeNull();
    expect(problems[0].field).toBe("country");
  });

  it("an Indian customer needs no GSTIN", () => {
    // Below the registration threshold is normal and must not be a
    // blocker.
    const { identity } = validateTaxIdentity({ country: "IN" });
    expect(identity).toEqual({ country: "IN", taxId: "", status: "india_gst" });
  });

  it("an Indian customer's GSTIN is kept when given, rejected when malformed", () => {
    expect(validateTaxIdentity({ country: "IN", taxId: "27AAPFU0939F1ZV" }).identity?.taxId)
      .toBe("27AAPFU0939F1ZV");
    expect(validateTaxIdentity({ country: "IN", taxId: "not-a-gstin" }).problems[0].field).toBe("taxId");
  });

  it("an EU customer is not required to supply a VAT number", () => {
    // One field, one behaviour everywhere: always shown, never
    // required, accepted when given. A GSTIN has always worked this
    // way, and an EU merchant below their own registration threshold
    // was meeting a wall for no reason the product could act on.
    const { identity, problems } = validateTaxIdentity({ country: "NL" });

    expect(problems).toEqual([]);
    expect(identity).toEqual({ country: "NL", taxId: "", status: "eu_no_vat_id" });
  });

  it("an EU customer with a valid number is a zero-rated export", () => {
    const { identity } = validateTaxIdentity({ country: "NL", taxId: "nl 1234 56789 b01" });
    expect(identity).toEqual({ country: "NL", taxId: "NL123456789B01", status: "export_zero_rated" });
  });

  it.each(["AU", "US", "AE", "SG", "GB"])("does not demand one from %s", (country) => {
    // A plain zero-rated export of services. There is no reverse charge
    // to evidence and often no such number to give — a US company has
    // an EIN, which is not a VAT number and has nothing to do with an
    // Indian export. Demanding it was friction at checkout buying
    // nothing.
    //
    // GB is in this list deliberately: post-Brexit it is an export like
    // any other, and treating it as EU has been wrong since 2020.
    const { identity, problems } = validateTaxIdentity({ country });

    expect(problems).toEqual([]);
    expect(identity).toEqual({ country, taxId: "", status: "export_zero_rated" });
  });

  it("still checks a number that is offered outside the EU", () => {
    // A merchant who types one wants it on their invoice, so a typo is
    // theirs to find now rather than at their own year end.
    const { problems } = validateTaxIdentity({ country: "AU", taxId: "?" });

    expect(problems[0].field).toBe("taxId");
    expect(problems[0].message).toContain("Leave it blank");
  });

  it("accepts a number offered outside the EU", () => {
    expect(validateTaxIdentity({ country: "AU", taxId: "AU12345678901" }).identity?.status)
      .toBe("export_zero_rated");
  });
});

describe("taxNote()", () => {
  it("says GST for India and reverse charge for an export", () => {
    expect(taxNote("india_gst", "IN")).toContain("GST");
    expect(taxNote("export_zero_rated", "NL")).toContain("reverse charge");
    expect(taxNote("export_zero_rated", "NL")).toContain("Zero-rated");
  });

  it("says nothing for an account with no tax identity yet", () => {
    expect(taxNote("", "")).toBe("");
  });
});

describe("an EU sale with no VAT number is its own position", () => {
  it("is accepted, and is not called a reverse-charge supply", () => {
    // The distinction the eu_no_vat_id status exists to preserve: the
    // reverse charge applies because a VAT number was produced, not
    // because the customer is in the EU. Labelling this "VAT accounted
    // for by you under the reverse charge" on an invoice the customer
    // hands to their own accountant would be a false statement.
    const { identity, problems } = validateTaxIdentity({ country: "NL" });

    expect(problems).toEqual([]);
    expect(identity!.status).toBe("eu_no_vat_id");
    expect(taxNote(identity!.status, "NL")).not.toContain("reverse charge");
    expect(taxNote(identity!.status, "NL")).toContain("without a VAT registration number");
  });

  it("still gives a VAT-registered EU customer the reverse charge", () => {
    const { identity } = validateTaxIdentity({ country: "NL", taxId: "NL123456789B01" });

    expect(identity!.status).toBe("export_zero_rated");
    expect(taxNote(identity!.status, "NL")).toContain("reverse charge");
  });

  it("leaves everywhere else alone", () => {
    expect(validateTaxIdentity({ country: "US" }).identity?.status).toBe("export_zero_rated");
    expect(validateTaxIdentity({ country: "IN" }).identity?.status).toBe("india_gst");
  });
});

