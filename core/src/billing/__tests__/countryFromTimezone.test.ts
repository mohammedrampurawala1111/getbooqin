/**
 * Pre-filling "which country is your business registered in?".
 *
 * The field decides a tax position — IN charges GST, an EU country
 * demands a VAT number and applies reverse charge, everything else is
 * zero-rated export. So the bar is not "usually right". A confident
 * wrong answer puts the wrong treatment on a real invoice, which is
 * worse than an empty select.
 */
import { describe, expect, it } from "vitest";
import { countryFromTimezone, statusForCountry, isEuCountry } from "../tax.js";

describe("what it knows", () => {
  it.each([
    ["Asia/Kolkata", "IN"],
    ["Asia/Calcutta", "IN"],
    ["Europe/Amsterdam", "NL"],
    ["Europe/London", "GB"],
    ["America/New_York", "US"],
    ["Australia/Sydney", "AU"],
  ])("%s → %s", (zone, country) => {
    expect(countryFromTimezone(zone)).toBe(country);
  });

  it("gets the India case right, which is the one that charges tax", () => {
    expect(statusForCountry(countryFromTimezone("Asia/Kolkata"))).toBe("india_gst");
  });

  it("gets an EU case right, which is the one that demands a VAT number", () => {
    expect(isEuCountry(countryFromTimezone("Europe/Amsterdam"))).toBe(true);
  });

  it("does not treat the UK as EU", () => {
    // Post-Brexit, and the difference is reverse charge versus a plain
    // zero-rated export.
    expect(isEuCountry(countryFromTimezone("Europe/London"))).toBe(false);
  });
});

describe("what it refuses to guess", () => {
  it.each([
    ["", "empty"],
    ["   ", "blank"],
    ["Not/AZone", "nonsense"],
    ["Europe/Busingen", "a real zone nobody mapped"],
    ["UTC", "no country at all"],
    ["Etc/GMT+5", "an offset"],
  ])("returns nothing for %p (%s)", (zone) => {
    // Blank means the merchant picks from the list. Being unhelpful is
    // cheaper than being wrong about someone's tax.
    expect(countryFromTimezone(zone)).toBe("");
  });

  it.each([null, undefined])("survives %p", (zone) => {
    expect(countryFromTimezone(zone as never)).toBe("");
  });
});

describe("the table itself", () => {
  it("only ever yields two-letter ISO codes", () => {
    for (const zone of ["Asia/Kolkata", "Europe/Paris", "America/Toronto", "Africa/Lagos"]) {
      expect(countryFromTimezone(zone)).toMatch(/^[A-Z]{2}$/);
    }
  });

  it("maps every Australian zone to one country, not to a state", () => {
    // Four zones, one tax jurisdiction — the kind of detail that is
    // easy to get wrong when a table is written from city names.
    const zones = ["Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane", "Australia/Perth"];
    expect(new Set(zones.map(countryFromTimezone))).toEqual(new Set(["AU"]));
  });
});
