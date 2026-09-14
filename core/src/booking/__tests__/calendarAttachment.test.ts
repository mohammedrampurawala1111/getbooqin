/**
 * The .ics attachment on confirmation emails.
 *
 * Generation itself is covered in calendar.test.ts; what this covers is
 * the wiring, which is the part that fails quietly. An attachment that
 * never gets attached, or gets attached to the wrong email, looks
 * exactly like a working send from every log line we have.
 *
 * nodemailer and the data layer are mocked — no SMTP server, no
 * database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Booking } from "@prisma/client";

const sendMail = vi.fn().mockResolvedValue({ messageId: "1", accepted: [], rejected: [], response: "ok" });

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail }) },
}));

const booking = (over: Partial<Booking> = {}) =>
  ({
    id: 1,
    shop: "shop-1",
    platform: "cloud",
    uid: "bk_xyz789",
    serviceId: 10,
    resourceId: 20,
    customerId: 30,
    startUtc: new Date("2026-10-02T13:30:00.000Z"),
    endUtc: new Date("2026-10-02T14:15:00.000Z"),
    timezone: "Europe/London",
    status: "confirmed",
    meetingUrl: "",
    notes: "",
    customFields: null,
    source: "form",
    price: 0,
    ...over,
  }) as unknown as Booking;

const service = { id: 10, name: "Cut, colour & finish" };
const resource = { id: 20, name: "Jamie Rivera" };
const customer = { id: 30, firstName: "Jordan", lastName: "Lee", email: "jordan@example.com", phone: "" };

vi.mock("../data.js", () => ({
  catalogService: vi.fn(async () => service),
  resource: vi.fn(async () => resource),
  customer: vi.fn(async () => customer),
  bookingAddons: vi.fn(async () => []),
}));

const settings = {
  business_name: "Salon Élysée",
  business_email: "hello@salon.example",
  business_address: "12 High Street, Bristol",
  timezone: "Europe/London",
  booking_page_url: "https://getbooqin.com/book/abc",
  notify_customer: true,
  notify_admin: false,
};

vi.mock("../settings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../settings.js")>();
  return { ...actual, getSettings: vi.fn(async () => settings) };
});

let current = booking();
vi.mock("../bookings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bookings.js")>();
  return { ...actual, get: vi.fn(async () => current) };
});

const { resendConfirmation } = await import("../mailer.js");

function sent() {
  expect(sendMail).toHaveBeenCalledTimes(1);
  return sendMail.mock.calls[0][0] as { attachments?: { filename: string; content: string; contentType: string }[] };
}

beforeEach(() => {
  sendMail.mockClear();
  current = booking();
  process.env.SMTP_HOST = "smtp.example.com";
  process.env.MAIL_FROM_EMAIL = "notify@getbooqin.com";
});

describe("attaching the calendar file", () => {
  it("attaches exactly one .ics to a confirmed booking's email", async () => {
    await resendConfirmation("shop-1", "cloud", 1);
    const { attachments } = sent();

    expect(attachments).toHaveLength(1);
    expect(attachments![0].filename).toBe("cut-colour-finish.ics");
    expect(attachments![0].contentType).toBe("text/calendar; charset=utf-8; method=PUBLISH");
  });

  it("attaches the booking's own times, not a re-derived guess at them", async () => {
    await resendConfirmation("shop-1", "cloud", 1);
    const ics = sent().attachments![0].content;

    expect(ics).toContain("DTSTART:20261002T133000Z");
    expect(ics).toContain("DTEND:20261002T141500Z");
    // The booking uid, so a later re-send updates the calendar entry
    // rather than leaving the customer holding two of them.
    expect(ics).toContain("UID:bk_xyz789@getbooqin");
    expect(ics).toContain("SUMMARY:Cut\\, colour & finish with Jamie Rivera");
  });

  it("prefers the meeting link over the street address when the booking is remote", async () => {
    current = booking({ meetingUrl: "https://meet.example.com/xyz" });
    await resendConfirmation("shop-1", "cloud", 1);

    expect(sent().attachments![0].content).toContain("LOCATION:https://meet.example.com/xyz");
  });

  it("falls back to the business address for an in-person booking", async () => {
    await resendConfirmation("shop-1", "cloud", 1);

    expect(sent().attachments![0].content).toContain("LOCATION:12 High Street\\, Bristol");
  });
});

describe("when a calendar entry would be wrong", () => {
  it("attaches nothing to a pending request", async () => {
    // The business has not agreed to this time yet. Putting it in the
    // customer's diary would make a request look like an appointment.
    current = booking({ status: "pending" });
    await resendConfirmation("shop-1", "cloud", 1);

    expect(sent().attachments).toBeUndefined();
  });

  it("attaches nothing to a cancelled booking", async () => {
    current = booking({ status: "cancelled" });
    await resendConfirmation("shop-1", "cloud", 1);

    expect(sent().attachments).toBeUndefined();
  });
});

describe("failure is never worse than no attachment", () => {
  it("still sends the email when the .ics cannot be built", async () => {
    // A calendar file is a convenience. Losing the confirmation itself
    // because one date on the row is unusable is a real failure, so the
    // builder swallows its own errors.
    current = booking({ endUtc: new Date("not a date") });

    await resendConfirmation("shop-1", "cloud", 1);
    const call = sent() as unknown as { attachments?: unknown[]; text: string };

    expect(call.attachments).toBeUndefined();
    expect(call.text).toContain("Jordan");
  });
});
