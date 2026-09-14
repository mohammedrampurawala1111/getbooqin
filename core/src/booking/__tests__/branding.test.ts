/**
 * Booking-page branding.
 *
 * Two things matter here and neither is cosmetic. A logo is stored as a
 * data URL and then inlined into a public page on our own origin, which
 * makes "what counts as an image" a security question rather than a
 * formatting one. And the size cap is what keeps a settings row from
 * quietly becoming a four-megabyte column.
 */
import { describe, expect, it } from "vitest";
import { validateBranding, BRAND_LOGO_MAX_BYTES } from "../settingsShared.js";

const png = (bytes: number) => `data:image/png;base64,${"A".repeat(Math.max(0, bytes))}`;

describe("what counts as a logo", () => {
  it("accepts the formats every browser renders", () => {
    for (const type of ["png", "jpeg", "webp"]) {
      expect(validateBranding({ logo: `data:image/${type};base64,AAAA` }), type).toEqual([]);
    }
  });

  it("refuses SVG", () => {
    // An SVG is an image format that can contain script, and this value
    // is inlined into a page served from our origin. Accepting one is a
    // stored-XSS hole dressed up as a logo upload.
    const problems = validateBranding({ logo: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" });

    expect(problems).toHaveLength(1);
    expect(problems[0].field).toBe("brand_logo");
  });

  it("refuses anything that is not a data URL at all", () => {
    // A remote URL would make the booking page fetch from somewhere we
    // don't control, on every render, for every visitor.
    expect(validateBranding({ logo: "https://example.com/logo.png" })).toHaveLength(1);
    expect(validateBranding({ logo: "javascript:alert(1)" })).toHaveLength(1);
  });

  it("refuses an image past the cap", () => {
    expect(validateBranding({ logo: png(BRAND_LOGO_MAX_BYTES + 100) })).toHaveLength(1);
  });

  it("accepts one just inside it", () => {
    expect(validateBranding({ logo: png(BRAND_LOGO_MAX_BYTES - 200) })).toEqual([]);
  });

  it("treats no logo as fine", () => {
    // Clearing branding has to work on any plan — a merchant whose
    // trial ended must be able to take their logo back off.
    expect(validateBranding({ logo: "" })).toEqual([]);
    expect(validateBranding({})).toEqual([]);
  });
});

describe("the accent colour", () => {
  it("accepts a six-digit hex", () => {
    expect(validateBranding({ accent: "#8f3aa9" })).toEqual([]);
    expect(validateBranding({ accent: "#FFFFFF" })).toEqual([]);
  });

  it("refuses anything else, however valid it is as CSS", () => {
    // The value is interpolated into a style attribute. Named colours
    // and rgb() are legitimate CSS; the narrow form is the one that
    // cannot carry anything besides a colour.
    for (const bad of ["red", "rgb(1,2,3)", "#fff", "#8f3aa", "8f3aa9", "#8f3aa9; background:url(x)"]) {
      expect(validateBranding({ accent: bad }), bad).toHaveLength(1);
    }
  });

  it("treats no colour as fine", () => {
    expect(validateBranding({ accent: "" })).toEqual([]);
  });
});

describe("both at once", () => {
  it("reports each problem separately", () => {
    const problems = validateBranding({ logo: "data:image/svg+xml;base64,AA", accent: "red" });

    expect(problems.map((p) => p.field).sort()).toEqual(["brand_accent", "brand_logo"]);
  });
});
