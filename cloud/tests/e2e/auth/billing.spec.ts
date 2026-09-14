import { test, expect } from "@playwright/test";
import { seedTenant, destroyTenant, disconnectFixtures, signInAs, type SeededTenant } from "../fixtures/tenant";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Settings → Billing, signed in as a real merchant.
 *
 * This is the half the public suite can't see, and the half most likely
 * to be wrong: it went through three deploys before it stopped
 * answering "We couldn't start that subscription" for every account.
 */
let tenant: SeededTenant;

test.beforeAll(async () => {
  tenant = await seedTenant("billing");
});

test.afterAll(async () => {
  await destroyTenant(tenant);
  await prisma.$disconnect();
  await disconnectFixtures();
});

test.beforeEach(async ({ page }) => {
  await signInAs(page, tenant);
});

test("shows the trial, the usage meters and prices in the shop's own currency", async ({ page }) => {
  await page.goto(`/dashboard/${tenant.connectionId}/settings?page=billing`);

  await expect(page.getByRole("heading", { name: "Your plan" })).toBeVisible();
  await expect(page.getByText(/free trial of/i)).toBeVisible();

  // INR, because the seeded shop prices in ₹ — the derivation that was
  // silently defaulting every account to USD and breaking checkout.
  await expect(page.getByText("Prices in INR")).toBeVisible();
  await expect(page.getByText("₹799").first()).toBeVisible();

  // Scoped to the usage card: the same limit labels also appear in every
  // plan card's comparison list, so an unscoped match finds four.
  const usage = page.locator(".card").filter({ hasText: "What you're using" });
  await expect(usage.getByText("Resources (staff / rooms)")).toBeVisible();
  await expect(usage.getByText("Customer bookings per month")).toBeVisible();
});

test("offers an upgrade, and asks for the tax identity it legally needs", async ({ page }) => {
  await page.goto(`/dashboard/${tenant.connectionId}/settings?page=billing`);

  // A trial is a trial *of Growth*, so Growth is the current plan and
  // Starter is a step down — the button says "Switch", not "Upgrade".
  // Asserting the real label rather than the one I assumed is the point:
  // for three deploys this button rendered for currencies with no plan
  // behind them and its only possible outcome was an error.
  await expect(page.getByRole("button", { name: /Switch to Starter/i })).toBeVisible();
  await expect(page.locator(".card").filter({ hasText: "Plans" }).getByText("Current")).toBeVisible();

  await expect(page.getByLabel("Country code")).toHaveValue("IN");
  await expect(page.getByText(/GSTIN \(optional\)/i)).toBeVisible();
});

test("switching to yearly quotes the yearly price, not the monthly one", async ({ page }) => {
  await page.goto(`/dashboard/${tenant.connectionId}/settings?page=billing`);
  await page.getByRole("button", { name: /Yearly/i }).click();
  await expect(page.getByText("₹7,990").first()).toBeVisible();
});

test.describe("two rails — India on Razorpay, everywhere else on PayPal", () => {
  /**
   * Which vendor a merchant is sent to is decided by their currency,
   * and it is named on screen before they click. Being handed to a
   * payment provider you weren't expecting is a moment people abandon a
   * checkout, and an Indian merchant being sent to PayPal (or a Dutch
   * one to an Indian gateway) is exactly that moment.
   */
  async function setShopCurrency(t: SeededTenant, currency: string, timezone: string) {
    const row = await prisma.shopSettings.findFirst({ where: { shop: t.shop, platform: t.platform } });
    await prisma.shopSettings.update({
      where: { platform_shop: { platform: t.platform, shop: t.shop } },
      data: { data: JSON.stringify({ ...JSON.parse(row!.data), currency, timezone }) },
    });
  }

  test("an Indian merchant is told they're going to Razorpay", async ({ page }) => {
    // Already signed in by the beforeEach above.
    await setShopCurrency(tenant, "INR", "Asia/Kolkata");
    await page.goto(`/dashboard/${tenant.connectionId}/settings?page=billing`);

    await expect(page.getByText(/taken to Razorpay/)).toBeVisible();
    await expect(page.getByText(/taken to PayPal/)).toHaveCount(0);
  });

  test("a European merchant is told they're going to PayPal", async ({ page }) => {
    await setShopCurrency(tenant, "EUR", "Europe/Amsterdam");
    await page.goto(`/dashboard/${tenant.connectionId}/settings?page=billing`);

    await expect(page.getByText(/taken to PayPal/)).toBeVisible();
    await expect(page.getByText(/taken to Razorpay/)).toHaveCount(0);

    await setShopCurrency(tenant, "INR", "Asia/Kolkata");
  });
});

test.describe("billing details can actually be saved", () => {
  /**
   * These four fields lived only as hidden inputs on each plan card, so
   * the copy beside them — "asked once, and nothing is issued until
   * they exist" — described a form with no way to submit it. A merchant
   * who filled them in and navigated away lost all of it, and an
   * invoice can't be issued without them.
   */
  test("saves the registered name, address and tax identity on their own", async ({ page }) => {
    await page.goto(`/dashboard/${tenant.connectionId}/settings?page=billing`);

    await page.getByLabel("Registered business name").fill("Acme Dental Pvt Ltd");
    await page.getByLabel("Billing address").fill("204 MG Road\nBengaluru 560001");
    await page.getByLabel("Country code").fill("IN");
    await page.getByRole("button", { name: /Save billing details/ }).click();

    await expect
      .poll(async () => {
        const row = await prisma.subscription.findUnique({
          where: { connectionId: tenant.connectionId },
          select: { billingName: true, billingAddress: true, taxCountry: true },
        });
        return row;
      })
      .toMatchObject({ billingName: "Acme Dental Pvt Ltd", taxCountry: "IN" });
  });

  test("refuses a tax number it cannot use, here rather than at checkout", async ({ page }) => {
    await page.goto(`/dashboard/${tenant.connectionId}/settings?page=billing`);

    await page.getByLabel("Country code").fill("NL");
    await page.getByLabel("Tax number").fill("nope");
    await page.getByRole("button", { name: /Save billing details/ }).click();

    await expect(page.getByText(/doesn't look like a VAT or business tax number/)).toBeVisible();
  });
});
