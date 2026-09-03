import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// See README.md for what this covers and why. `wcag2a`/`wcag2aa` mirrors
// the ruleset the exploration for UX audit pass 11's #9 finding scanned
// with (label, select-name, aria-allowed-attr, aria-allowed-role, color-
// contrast, landmark-one-main, region, button-name, link-name, heading-
// order all live under these two tags).
async function checkA11y(page: Page) {
  return new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
}

const STATIC_PAGES = ["/", "/login", "/signup", "/forgot-password", "/legal/privacy", "/legal/terms", "/support"];

for (const path of STATIC_PAGES) {
  test(`${path} has no axe violations`, async ({ page }) => {
    await page.goto(path);
    const results = await checkA11y(page);
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
}

test("public booking page (service step) has no axe violations", async ({ page }) => {
  const connectionId = process.env.A11Y_BOOKING_ID;
  test.skip(!connectionId, "Set A11Y_BOOKING_ID to a seeded connection id to run this case — see README.md.");

  await page.goto(`/book/${connectionId}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const results = await checkA11y(page);
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});
