/**
 * isInternalShopKey — the guard that stops a tenant's internal key being
 * rendered as its name (10-01-2026 review, item 14).
 *
 * Worth its own tests because both failure directions are user-visible
 * and neither throws: too narrow and a UUID goes back on the public
 * booking page, too broad and it silently renames a business that
 * legitimately calls itself "manual-something".
 */
import { describe, expect, it } from "vitest";
import { isInternalShopKey } from "../settingsShared.js";
import { defaultSettings } from "../settings.js";

describe("isInternalShopKey", () => {
  it("matches the key createManualConnection actually mints", () => {
    // Exactly the shape of `manual-${randomUUID()}` — this is the string
    // that reached the bookings table and the confirmation email.
    expect(isInternalShopKey("manual-77cd2e49-85b3-4068-b629-1902edb8bc34")).toBe(true);
  });

  it("is case-insensitive, since nothing guarantees the UUID's case", () => {
    expect(isInternalShopKey("manual-77CD2E49-85B3-4068-B629-1902EDB8BC34")).toBe(true);
  });

  it("leaves a Shopify domain alone — it is a reasonable placeholder name", () => {
    expect(isInternalShopKey("trevor-hayes.myshopify.com")).toBe(false);
  });

  it("does not match a business that merely starts with the prefix", () => {
    // The backfill renames whatever this returns true for, so a real
    // business called "Manual Therapy" must never match.
    expect(isInternalShopKey("manual-therapy")).toBe(false);
    expect(isInternalShopKey("manual-77cd2e49")).toBe(false);
    expect(isInternalShopKey("Manual Therapy Clinic")).toBe(false);
  });

  it("does not match a UUID with the prefix embedded rather than leading", () => {
    expect(isInternalShopKey("x-manual-77cd2e49-85b3-4068-b629-1902edb8bc34")).toBe(false);
    expect(isInternalShopKey("manual-77cd2e49-85b3-4068-b629-1902edb8bc34-extra")).toBe(false);
  });

  it("handles the empty string without matching", () => {
    expect(isInternalShopKey("")).toBe(false);
  });
});

describe("defaultSettings business_name", () => {
  it("is empty for a manual account, not the UUID", () => {
    const settings = defaultSettings("manual-77cd2e49-85b3-4068-b629-1902edb8bc34", "owner@example.com");
    expect(settings.business_name).toBe("");
  });

  it("still falls back to the shop domain for a real platform store", () => {
    expect(defaultSettings("trevor-hayes.myshopify.com", "owner@example.com").business_name)
      .toBe("trevor-hayes.myshopify.com");
  });
});
