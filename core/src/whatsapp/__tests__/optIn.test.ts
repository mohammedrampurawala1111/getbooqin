/**
 * Consent, which is the one part of this feature with legal weight.
 *
 * Meta requires *demonstrable* opt-in before a business sends a
 * customer a template message — demonstrable meaning you can say when
 * it was given and where. So it is three columns, and the field is
 * three-state rather than a boolean: `undefined` means "this surface
 * never asked", which is not the same as "they said no" and must not
 * overwrite an earlier yes.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import prisma from "../../db.js";
import * as Data from "../../booking/data.js";

const RUN = Date.now();
const shop = `wa-optin-${RUN}`;
const platform = "manual";

async function customerNamed(email: string) {
  return prisma.customer.findUnique({ where: { platform_shop_email: { platform, shop, email } } });
}

beforeEach(async () => {
  await prisma.customer.deleteMany({ where: { shop } });
});

afterAll(async () => {
  await prisma.customer.deleteMany({ where: { shop } });
});

describe("capturing consent", () => {
  it("defaults to no consent for a customer nobody asked", async () => {
    // An existing customer who gave an email address years ago did not
    // consent to WhatsApp, and a backfill to true would be exactly what
    // the rule exists to prevent.
    await Data.findOrCreateCustomer(shop, platform, { email: "a@example.com", first_name: "A" });

    const row = await customerNamed("a@example.com");
    expect(row?.whatsappOptIn).toBe(false);
    expect(row?.whatsappOptInAt).toBeNull();
  });

  it("records when and where consent was given, not just that it was", async () => {
    await Data.findOrCreateCustomer(shop, platform, {
      email: "b@example.com",
      whatsapp_opt_in: true,
      whatsapp_opt_in_source: "booking_form",
    });

    const row = await customerNamed("b@example.com");
    expect(row?.whatsappOptIn).toBe(true);
    expect(row?.whatsappOptInAt).toBeInstanceOf(Date);
    expect(row?.whatsappOptInSource).toBe("booking_form");
  });

  it("leaves an existing answer alone when the surface never asked", async () => {
    // A staff member adding a walk-in from the dashboard must not
    // silently revoke consent the customer gave on the booking form.
    await Data.findOrCreateCustomer(shop, platform, { email: "c@example.com", whatsapp_opt_in: true });
    await Data.findOrCreateCustomer(shop, platform, { email: "c@example.com", first_name: "Updated" });

    const row = await customerNamed("c@example.com");
    expect(row?.whatsappOptIn).toBe(true);
    expect(row?.firstName).toBe("Updated");
  });

  it("lets an explicit no overwrite an earlier yes", async () => {
    // Withdrawal has to be possible, and it is a different fact from
    // "never asked" — which is the whole reason the field is three-state.
    await Data.findOrCreateCustomer(shop, platform, { email: "d@example.com", whatsapp_opt_in: true });
    await Data.findOrCreateCustomer(shop, platform, { email: "d@example.com", whatsapp_opt_in: false });

    const row = await customerNamed("d@example.com");
    expect(row?.whatsappOptIn).toBe(false);
    // The record of having asked survives the answer changing.
    expect(row?.whatsappOptInAt).toBeInstanceOf(Date);
  });

  it("keeps consent attached to the same record across repeat bookings", async () => {
    // findOrCreateCustomer resolves a repeat customer by email, so a
    // second booking must not produce a fresh row that has lost consent.
    const first = await Data.findOrCreateCustomer(shop, platform, {
      email: "e@example.com",
      whatsapp_opt_in: true,
    });
    const second = await Data.findOrCreateCustomer(shop, platform, { email: "e@example.com" });

    expect(second).toBe(first);
    expect((await customerNamed("e@example.com"))?.whatsappOptIn).toBe(true);
  });
});
