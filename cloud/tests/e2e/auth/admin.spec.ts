import { test, expect } from "@playwright/test";
import { seedTenant, seedPlatformAdmin, destroyTenant, disconnectFixtures, signInAs, type SeededTenant } from "../fixtures/tenant";

/**
 * The admin console's guard, exercised as two real signed-in people.
 *
 * This is the only surface in the product that sits above every tenant
 * at once, so the case that matters is the negative one: a perfectly
 * valid merchant session must not reach it.
 */
let merchant: SeededTenant;
let admin: SeededTenant;

test.beforeAll(async () => {
  merchant = await seedTenant("merchant");
  admin = await seedPlatformAdmin();
});

test.afterAll(async () => {
  await destroyTenant(merchant);
  await destroyTenant(admin);
  await disconnectFixtures();
});

test("a signed-in merchant cannot reach /admin", async ({ page }) => {
  // Only meaningful because the admin test below proves the console
  // *is* reachable for someone — without that, this would pass simply
  // because nobody can reach it.
  await signInAs(page, merchant);
  await page.goto("/admin");
  // 404, not 403 — a 403 would confirm the route exists and that there
  // is something behind it worth guarding.
  await expect(page.getByText("GetBooqin admin")).toHaveCount(0);
  // Still a bare locator here, deliberately: a non-admin must see *no*
  // table at all, coverage or accounts.
  await expect(page.getByRole("table")).toHaveCount(0);
});

test("a platform admin sees the accounts table", async ({ page }) => {
  await signInAs(page, admin);
  await page.goto("/admin");

  await expect(page.getByRole("heading", { name: "GetBooqin admin" })).toBeVisible();
  // Scoped to the accounts table by a column only it has. /admin grew a
  // second table — billing coverage, which lists price points with no
  // provider plan id — and a bare getByRole("table") now matches both.
  // Naming the one under test beats .first(), which would silently
  // follow whichever card happens to render first.
  await expect(page.getByRole("table").filter({ hasText: "Trial ends" })).toBeVisible();
  // The seeded merchant is an account, so it must be listed. `.first()`
  // because the business name and the shop id both render in the row.
  await expect(page.getByText("E2E merchant").first()).toBeVisible();
  // Counts, never tenant data: the console must not be leaking a
  // merchant's customers or bookings into a platform-wide screen.
  await expect(page.getByText("Bookings")).toBeVisible();
});

test("every admin action demands a reason before it will run", async ({ page }) => {
  await signInAs(page, admin);
  await page.goto(`/admin/accounts/${merchant.connectionId}`);

  await expect(page.getByRole("heading", { name: /E2E merchant/i })).toBeVisible();

  // `required` on every reason field is what makes the audit log worth
  // keeping — an entry with no "why" is just a timestamp.
  const reasons = page.locator('input[name="reason"]');
  const count = await reasons.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    await expect(reasons.nth(i)).toHaveAttribute("required", "");
  }
});

test("comping an account changes its plan and records why", async ({ page }) => {
  await signInAs(page, admin);
  await page.goto(`/admin/accounts/${merchant.connectionId}`);

  await page.locator('form:has(input[value="set_plan"]) select[name="plan"]').selectOption("business");
  await page.locator('form:has(input[value="set_plan"]) input[name="reason"]').fill("e2e: design partner");
  await page.getByRole("button", { name: "Set plan" }).click();

  await expect(page.getByText("Plan updated.")).toBeVisible();
  // The reason is the whole point: six months from now, "why is this
  // account free?" has an answer.
  await expect(page.getByText("e2e: design partner").first()).toBeVisible();
});
