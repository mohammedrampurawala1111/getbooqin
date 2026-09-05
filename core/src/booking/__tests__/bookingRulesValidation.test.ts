/**
 * Server-side booking-rule validation added in response to the GetBooqin
 * clinic audit (findings BR-01, BR-02, PB-01, PB-03) — before this, the
 * settings action's only guard was each <input>'s own HTML `min`
 * attribute, which a direct POST bypasses entirely. Pure functions, no DB
 * needed.
 */
import { describe, expect, it } from "vitest";
import {
  validateBookingRules,
  bookingWindowIsClosed,
  cancelCutoffExceedsNotice,
} from "../settingsShared.js";
import { cancelUnavailableReason, normalizePhone } from "../bookings.js";
import type { Booking } from "@prisma/client";
import { defaultSettings } from "../settings.js";

const validRules = {
  slot_interval: 15,
  min_notice_hours: 4,
  max_advance_days: 90,
  cancel_cutoff_hours: 24,
  waitlist_offer_window_hours: 3,
};

describe("validateBookingRules (BR-01)", () => {
  it("accepts a value in range for every field", () => {
    expect(validateBookingRules(validRules)).toEqual({});
  });

  it("rejects out-of-range values the form's own HTML attributes would have blocked client-side, with a field-level error each", () => {
    const errors = validateBookingRules({
      slot_interval: -5,
      min_notice_hours: -100,
      max_advance_days: 0,
      cancel_cutoff_hours: 24,
      waitlist_offer_window_hours: 3,
    });
    expect(errors.slot_interval).toBeDefined();
    expect(errors.min_notice_hours).toBeDefined();
    expect(errors.max_advance_days).toBeDefined();
    expect(errors.cancel_cutoff_hours).toBeUndefined();
  });

  it("rejects a value above the new upper bound — no field had one before this", () => {
    const errors = validateBookingRules({ ...validRules, slot_interval: 100000 });
    expect(errors.slot_interval).toBeDefined();
  });

  it("rejects non-finite input", () => {
    const errors = validateBookingRules({ ...validRules, min_notice_hours: NaN });
    expect(errors.min_notice_hours).toBe("Enter a number.");
  });
});

describe("validateBookingRules min_notice/max_advance collision (BR-02)", () => {
  it("blocks the audit's reproduction shape — minimum notice landing at or past the advance window in hours — for values that individually still pass the plain range check", () => {
    // 700h (~29 days) minimum notice is in-range on its own (max 720h);
    // 25 days' advance is in-range on its own too — the failure here is
    // purely the cross-field collision, not either field individually,
    // same mechanism as the audit's own 3000h-notice-vs-90-day-advance
    // reproduction (that exact pair is now also caught by the plain range
    // check alone, since min_notice_hours got a real upper bound it never
    // had before).
    const errors = validateBookingRules({ ...validRules, min_notice_hours: 700, max_advance_days: 25 });
    expect(errors.min_notice_hours).toBeDefined();
    expect(errors.max_advance_days).toBeDefined();
  });

  it("does not false-positive when the window is merely tight, not empty", () => {
    // 600h (25 days) of notice against a 30-day window still leaves 5
    // bookable days.
    const errors = validateBookingRules({ ...validRules, min_notice_hours: 600, max_advance_days: 30 });
    expect(errors.min_notice_hours).toBeUndefined();
    expect(errors.max_advance_days).toBeUndefined();
  });

  it("flags the boundary itself (exactly equal) as closed, matching availability.ts's own earliest > latest arithmetic", () => {
    const errors = validateBookingRules({ ...validRules, min_notice_hours: 720, max_advance_days: 30 });
    expect(errors.min_notice_hours).toBeDefined();
  });

  it("range-checks min_notice_hours on its own too — the audit's literal 3000h reproduction is now simply out of range", () => {
    const errors = validateBookingRules({ ...validRules, min_notice_hours: 3000, max_advance_days: 90 });
    expect(errors.min_notice_hours).toBeDefined();
  });
});

describe("bookingWindowIsClosed (BR-02 standing check)", () => {
  it("is false for the live default settings", () => {
    const settings = defaultSettings("example.myshopify.com", "owner@example.com");
    expect(bookingWindowIsClosed(settings)).toBe(false);
  });

  it("is true once minimum notice reaches the advance window in hours", () => {
    expect(bookingWindowIsClosed({ min_notice_hours: 2160, max_advance_days: 90 })).toBe(true);
  });
});

describe("cancelCutoffExceedsNotice (PB-01 warning)", () => {
  it("warns when the cutoff is longer than minimum notice — the exact un-cancellable-from-birth reproduction", () => {
    expect(cancelCutoffExceedsNotice({ allow_cancel: true, cancel_cutoff_hours: 24, min_notice_hours: 4 })).toBe(true);
  });

  it("does not warn when cancellation is already turned off entirely", () => {
    expect(cancelCutoffExceedsNotice({ allow_cancel: false, cancel_cutoff_hours: 24, min_notice_hours: 4 })).toBe(false);
  });

  it("does not warn when the cutoff fits inside the notice window", () => {
    expect(cancelCutoffExceedsNotice({ allow_cancel: true, cancel_cutoff_hours: 4, min_notice_hours: 24 })).toBe(false);
  });
});

describe("cancelUnavailableReason (PB-01 manage-page explanation)", () => {
  const settings = { ...defaultSettings("example.myshopify.com", "owner@example.com"), min_notice_hours: 4, cancel_cutoff_hours: 24, allow_cancel: true };

  function bookingIn(hoursFromNow: number, status: Booking["status"] = "confirmed"): Booking {
    return {
      startUtc: new Date(Date.now() + hoursFromNow * 3600_000),
      status,
    } as Booking;
  }

  it("explains the exact PB-01 reproduction: booked 9h50m out under a 24h cutoff", () => {
    const reason = cancelUnavailableReason(bookingIn(9.83), settings);
    expect(reason).toContain("24-hour");
  });

  it("is empty once the booking is safely outside the cutoff", () => {
    expect(cancelUnavailableReason(bookingIn(48), settings)).toBe("");
  });

  it("names the business's own policy, not the cutoff, when cancellation is switched off entirely", () => {
    const reason = cancelUnavailableReason(bookingIn(48), { ...settings, allow_cancel: false });
    expect(reason.toLowerCase()).toContain("turned off");
  });

  it("is empty for a status cancellation was never available for anyway (already cancelled)", () => {
    expect(cancelUnavailableReason(bookingIn(1, "cancelled"), settings)).toBe("");
  });
});

describe("normalizePhone (PB-03)", () => {
  it("prepends the configured default country code to a bare local number", () => {
    expect(normalizePhone("9325705315", "+91")).toBe("+919325705315");
  });

  it("leaves a number that already has a country code untouched", () => {
    expect(normalizePhone("+19325705315", "+91")).toBe("+19325705315");
  });

  it("does nothing when no default country code is configured", () => {
    expect(normalizePhone("9325705315", "")).toBe("9325705315");
  });

  it("strips a leading trunk zero before prepending the country code", () => {
    expect(normalizePhone("09325705315", "+91")).toBe("+919325705315");
  });
});
