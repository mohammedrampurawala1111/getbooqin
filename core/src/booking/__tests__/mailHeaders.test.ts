/**
 * Phase 0 / B3 — email deliverability.
 *
 * Every notification used to go out as `"Business Name" <the merchant's
 * own address>` over our SMTP relay, which isn't authorised to send for a
 * domain we don't control: SPF and DKIM alignment both fail, which is the
 * spoof signature Gmail and Outlook filter on. Pure header logic, so this
 * needs no database and no SMTP server.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromHeaders } from "../mailer.js";
import type { Settings } from "../settings.js";

const settings = (over: Partial<Settings> = {}) =>
  ({ business_name: "Bright Smile Dental", business_email: "hello@brightsmile.example", ...over }) as Settings;

const ORIGINAL = { email: process.env.MAIL_FROM_EMAIL, name: process.env.MAIL_FROM_NAME };

beforeEach(() => {
  delete process.env.MAIL_FROM_EMAIL;
  delete process.env.MAIL_FROM_NAME;
});

afterEach(() => {
  if (ORIGINAL.email === undefined) delete process.env.MAIL_FROM_EMAIL;
  else process.env.MAIL_FROM_EMAIL = ORIGINAL.email;
  if (ORIGINAL.name === undefined) delete process.env.MAIL_FROM_NAME;
  else process.env.MAIL_FROM_NAME = ORIGINAL.name;
});

describe("From / Reply-To headers (B3)", () => {
  it("sends from our own authenticated address, with the merchant in the display name", () => {
    process.env.MAIL_FROM_EMAIL = "notify@getbooqin.com";

    expect(fromHeaders(settings())).toEqual({
      from: '"Bright Smile Dental via GetBooqin" <notify@getbooqin.com>',
      replyTo: "hello@brightsmile.example",
    });
  });

  it("lets the platform name be rebranded", () => {
    process.env.MAIL_FROM_EMAIL = "notify@example.com";
    process.env.MAIL_FROM_NAME = "Acme Bookings";

    expect(fromHeaders(settings()).from).toBe('"Bright Smile Dental via Acme Bookings" <notify@example.com>');
  });

  it("omits Reply-To rather than pointing it at an address nobody reads", () => {
    process.env.MAIL_FROM_EMAIL = "notify@getbooqin.com";

    // No business email at all, and the placeholder the settings default
    // uses — neither is somewhere a customer's reply should go.
    expect(fromHeaders(settings({ business_email: "" })).replyTo).toBeUndefined();
    expect(fromHeaders(settings({ business_email: "not an address" })).replyTo).toBeUndefined();
    expect(fromHeaders(settings({ business_email: "notify@getbooqin.com" })).replyTo).toBeUndefined();
  });

  it("can't have extra headers smuggled in through the business name", () => {
    process.env.MAIL_FROM_EMAIL = "notify@getbooqin.com";

    const { from } = fromHeaders(settings({ business_name: 'Evil"\r\nBcc: attacker@example.com' }));

    expect(from).not.toContain("\r");
    expect(from).not.toContain("\n");
    expect(from).toBe('"Evil Bcc: attacker@example.com via GetBooqin" <notify@getbooqin.com>');
  });

  it("falls back to the old shape, unchanged, when no sending address is configured", () => {
    // Local development, where SMTP usually isn't set up either. Wrong in
    // exactly the way it was before rather than silently dropping mail —
    // getTransporter() warns about this at startup.
    expect(fromHeaders(settings())).toEqual({ from: '"Bright Smile Dental" <hello@brightsmile.example>' });
  });
});
