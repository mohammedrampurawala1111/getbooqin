import { test, expect } from "@playwright/test";
import { seedTenant, destroyTenant, disconnectFixtures, signInAs, type SeededTenant } from "../fixtures/tenant";

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
