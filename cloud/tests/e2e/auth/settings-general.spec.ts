import { test, expect } from "@playwright/test";
import { seedTenant, signInAs, seedBookable, destroyTenant, disconnectFixtures, type SeededTenant } from "../fixtures/tenant";
import { PrismaClient } from "@prisma/client";

/**
 * Settings → General: the two things a merchant configures there and
 * whether configuring them actually does anything.
 *
 * Both of these were reported as "nothing happens", and both were real.
 */
const prisma = new PrismaClient();
let tenant: SeededTenant;

test.beforeAll(async () => {
  tenant = await seedTenant("general");
  const { serviceId, resourceId } = await seedBookable(tenant);

  // One booking, because the Overview renders a setup checklist instead
  // of any cards while allTimeBookingCount is 0 — without this, "the
  // card is gone" passes on a page that never had cards.
  const customer = await prisma.customer.create({
    data: { shop: tenant.shop, platform: tenant.platform, firstName: "E2E", lastName: "Guest", email: "e2e@example.com", phone: "" },
  });
  const start = new Date(Date.now() + 2 * 86_400_000);
  await prisma.booking.create({
    data: {
      shop: tenant.shop,
      platform: tenant.platform,
      uid: `e2e-general-${Date.now()}`,
      serviceId,
      resourceId,
      customerId: customer.id,
      startUtc: start,
      endUtc: new Date(start.getTime() + 30 * 60_000),
      timezone: "Asia/Kolkata",
      status: "confirmed",
    },
  });
});
test.afterAll(async () => {
  await destroyTenant(tenant);
  await prisma.$disconnect();
  await disconnectFixtures();
});

async function openGeneral(page: import("@playwright/test").Page) {
  await page.goto(`/dashboard/${tenant.connectionId}/settings?page=general`);
}

function saveButton(page: import("@playwright/test").Page) {
  return page.locator("form", { has: page.locator("#vocabulary") }).getByRole("button", { name: "Save" });
}

async function hiddenCards(): Promise<string[]> {
  const row = await prisma.shopSettings.findFirst({ where: { shop: tenant.shop, platform: tenant.platform } });
  return JSON.parse(row!.data).hidden_overview_cards ?? [];
}

test.describe("dashboard layout", () => {
  test("switching a card off saves it off and removes it from the Overview", async ({ page }) => {
    // The toggle used to move, highlight, and save nothing: the label
    // both wrapped the checkbox and carried its own onClick, so one
    // click ran the handler twice and the checkbox ended up back where
    // it started.
    await signInAs(page, tenant);
    await openGeneral(page);

    const utilisation = page.locator('input[name="cards"][value="utilisation"]');
    await expect(utilisation).toBeChecked();

    await page.locator("label", { has: utilisation }).click();
    await expect(utilisation).not.toBeChecked();

    await saveButton(page).click();
    await expect.poll(hiddenCards).toContain("utilisation");

    await page.goto(`/dashboard/${tenant.connectionId}`);
    await expect(page.getByRole("heading", { name: /utilisation/i })).toHaveCount(0);
  });

  test("switching it back on brings the card back", async ({ page }) => {
    await signInAs(page, tenant);
    await openGeneral(page);

    const utilisation = page.locator('input[name="cards"][value="utilisation"]');
    const row = page.locator("label", { has: utilisation });

    // Off and saved, from whatever state this test found — self
    // contained, rather than leaning on the test above having run.
    if (await utilisation.isChecked()) {
      await row.click();
      await saveButton(page).click();
      await expect.poll(hiddenCards).toContain("utilisation");
      await openGeneral(page);
    }

    await expect(utilisation).not.toBeChecked();
    await row.click();
    await saveButton(page).click();
    await expect.poll(hiddenCards).not.toContain("utilisation");

    await page.goto(`/dashboard/${tenant.connectionId}`);
    await expect(page.getByRole("heading", { name: /utilisation/i })).toBeVisible();
  });

  test("switching one card off leaves the others alone", async ({ page }) => {
    // The same double-fire could just as easily have saved the wrong
    // set as saved nothing.
    await signInAs(page, tenant);
    await openGeneral(page);

    const noShow = page.locator('input[name="cards"][value="noShow"]');
    if (!(await noShow.isChecked())) {
      await page.locator("label", { has: noShow }).click();
      await saveButton(page).click();
      await openGeneral(page);
    }

    await page.locator("label", { has: noShow }).click();
    await saveButton(page).click();

    await expect.poll(hiddenCards).toEqual(["noShow"]);
  });
});

async function setTerms(terms: Record<string, string>): Promise<void> {
  const row = await prisma.shopSettings.findFirst({ where: { shop: tenant.shop, platform: tenant.platform } });
  const data = JSON.parse(row!.data);
  await prisma.shopSettings.update({
    where: { platform_shop: { platform: tenant.platform, shop: tenant.shop } },
    data: { data: JSON.stringify({ ...data, terms: { ...(data.terms ?? {}), ...terms } }) },
  });
}

test.describe("vocabulary", () => {
  // A known baseline, so no test inherits the words another one left
  // behind — the irregular-plural test below deliberately writes some.
  test.beforeEach(async () => {
    await setTerms({
      booking_single: "Booking", booking_plural: "Bookings",
      service_single: "Service", service_plural: "Services",
      resource_single: "Staff", resource_plural: "Staff members",
      customer_single: "Customer", customer_plural: "Customers",
    });
  });

  test("asks for each word once, and shows the plural it derived", async ({ page }) => {
    // It used to be two text boxes per row, and since the plural is the
    // singular plus an s almost every time, four questions took eight
    // fields.
    await signInAs(page, tenant);
    await openGeneral(page);

    await expect(page.locator('input[name="term_customer_single"]')).toBeVisible();
    await expect(page.locator('input[name="term_customer_plural"]')).toBeHidden();
    await expect(page.getByText(/^Plural:/).first()).toBeVisible();
  });

  test("a suggestion sets the word and its plural", async ({ page }) => {
    await signInAs(page, tenant);
    await openGeneral(page);

    const chip = page.getByRole("button", { name: "Patient", exact: true });
    await expect(chip).toHaveCount(1);
    await chip.click();

    await expect(page.locator('input[name="term_customer_single"]')).toHaveValue("Patient");
    await expect(page.locator('input[name="term_customer_plural"]')).toHaveValue("Patients");
  });

  test("typing a singular keeps the plural in step", async ({ page }) => {
    await signInAs(page, tenant);
    await openGeneral(page);

    const single = page.locator('input[name="term_customer_single"]');
    await single.fill("Guest");

    await expect(page.locator('input[name="term_customer_plural"]')).toHaveValue("Guests");
    await expect(page.getByText("Plural: Guests")).toBeVisible();
  });

  test("handles the plurals a bare s gets wrong", async ({ page }) => {
    await signInAs(page, tenant);
    await openGeneral(page);

    await page.locator('input[name="term_service_single"]').fill("Class");
    await expect(page.locator('input[name="term_service_plural"]')).toHaveValue("Classes");

    await page.locator('input[name="term_service_single"]').fill("Therapy");
    await expect(page.locator('input[name="term_service_plural"]')).toHaveValue("Therapies");
  });

  test("Change reveals the plural field and stops deriving over it", async ({ page }) => {
    // The escape hatch for the words the rule cannot get right.
    await signInAs(page, tenant);
    await openGeneral(page);

    const single = page.locator('input[name="term_customer_single"]');
    const plural = page.locator('input[name="term_customer_plural"]');

    await single.fill("Guest");
    await page.getByRole("button", { name: "Change the plural of customers are called" }).click();
    await expect(plural).toBeVisible();

    await plural.fill("People");
    await single.fill("Person");

    await expect(plural).toHaveValue("People");
  });

  test("an account whose plural is already irregular gets the field open, not a guess", async ({ page }) => {
    // Never silently replace a word someone chose with a derived one.
    await setTerms({ customer_single: "Person", customer_plural: "People" });

    await signInAs(page, tenant);
    await openGeneral(page);

    await expect(page.locator('input[name="term_customer_plural"]')).toBeVisible();
    await expect(page.locator('input[name="term_customer_plural"]')).toHaveValue("People");
  });

  test("saves both words", async ({ page }) => {
    await signInAs(page, tenant);
    await openGeneral(page);

    await page.locator('input[name="term_customer_single"]').fill("Guest");
    await saveButton(page).click();

    await expect
      .poll(async () => {
        const row = await prisma.shopSettings.findFirst({ where: { shop: tenant.shop, platform: tenant.platform } });
        return JSON.parse(row!.data).terms;
      })
      .toMatchObject({ customer_single: "Guest", customer_plural: "Guests" });
  });

  test("the live preview follows what is typed", async ({ page }) => {
    await signInAs(page, tenant);
    await openGeneral(page);

    // The card's own description line names the four words back.
    await page.locator('input[name="term_service_single"]').fill("Lesson");

    await expect(page.getByText(/lessons/i).first()).toBeVisible();
  });
});

test.describe("one card's Save never wipes another's fields", () => {
  /**
   * The Branding card posted `_section="general"` while holding only two
   * of that section's twelve fields, so the action read the other ten as
   * empty strings and wrote them. One click on Save blanked the business
   * name, address and phone and reset the currency to USD and the
   * timezone to UTC — and a wrong timezone silently re-bases every
   * availability calculation and every displayed booking time.
   */
  test("saving branding leaves business details and timezone alone", async ({ page }) => {
    await setTerms({});
    const before = await prisma.shopSettings.findFirst({
      where: { shop: tenant.shop, platform: tenant.platform },
    });
    const original = JSON.parse(before!.data);

    await signInAs(page, tenant);
    await openGeneral(page);

    // Branding is a paid feature; the seeded tenant is on a Growth trial.
    // By a control only this card has — "Your booking page" also appears
    // in the General card's own copy.
    const card = page.locator(".card").filter({ has: page.getByLabel("Accent colour") });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Save" }).click();

    await expect
      .poll(async () => {
        const row = await prisma.shopSettings.findFirst({
          where: { shop: tenant.shop, platform: tenant.platform },
        });
        return JSON.parse(row!.data);
      })
      .toMatchObject({
        business_name: original.business_name,
        currency: original.currency,
        timezone: original.timezone,
      });
  });
});
