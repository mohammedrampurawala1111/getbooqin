import { test, expect } from "@playwright/test";
import { PLANS, PRICES, formatPrice } from "getbooqin-core/billing/plans";

/**
 * What a real browser can reach without a session.
 *
 * The honest limit of this file: **everything behind Clerk is
 * unreachable from here** — Settings → Billing, the checkout redirect,
 * the admin console, account deletion. Reaching those needs a Clerk test
 * session fixture, which does not exist yet. What this does cover is the
 * public surface, the security boundaries, and one consistency check
 * that has been quietly wrong for a while.
 */

test.describe("public pages load", () => {
  for (const path of ["/", "/login", "/signup", "/legal/terms", "/legal/privacy"]) {
    test(`${path} renders`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status(), `${path} status`).toBeLessThan(400);
      await expect(page.locator("h1").first()).toBeVisible();
    });
  }
});

test.describe("terms cover what we now charge for", () => {
  // These sections are what makes taking recurring payments lawful.
  // A deploy that drops them is a compliance regression, not a typo.
  test("states renewal, cancellation, refund and tax terms", async ({ page }) => {
    await page.goto("/legal/terms");
    const body = (await page.locator("body").innerText()).toLowerCase();

    for (const phrase of [
      "renew automatically",
      "cancel at any time",
      "refund",
      "free trial",
      "grace period",
    ]) {
      expect(body, `terms must mention "${phrase}"`).toContain(phrase);
    }
  });

  test("states the Indian-entity tax position, including B2B-only exports", async ({ page }) => {
    await page.goto("/legal/terms");
    const body = (await page.locator("body").innerText()).toLowerCase();
    expect(body).toContain("registered in india");
    expect(body).toContain("gst");
    expect(body).toContain("reverse charge");
  });

  test("explains account deletion", async ({ page }) => {
    await page.goto("/legal/terms");
    const body = (await page.locator("body").innerText()).toLowerCase();
    expect(body).toContain("delete your account");
    expect(body).toContain("cannot be undone");
  });
});

test.describe("security boundaries", () => {
  test("/admin is not reachable by a logged-out visitor", async ({ page }) => {
    // Asserting on the final URL, not the status: the guard bounces to
    // /login, and following that redirect lands on a perfectly healthy
    // 200. The question is whether the console ever renders, not what
    // code the last hop returned.
    await page.goto("/admin");
    await expect(page).toHaveURL(/login|sign-in/i);
    await expect(page.getByText("GetBooqin admin")).toHaveCount(0);
  });

  test("/dashboard requires a session", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/login|sign-in/i);
  });

  test("the Razorpay webhook rejects a GET", async ({ request }) => {
    const response = await request.get("/webhooks/razorpay");
    expect(response.status()).toBe(405);
  });

  test("the Razorpay webhook rejects an unsigned POST", async ({ request }) => {
    // The one endpoint on the app that can change what someone is
    // paying. An unsigned body must never get past verification.
    const response = await request.post("/webhooks/razorpay", {
      data: { event: "subscription.charged" },
    });
    expect(response.status()).toBe(400);
  });
});

test.describe("the pricing page tells the truth", () => {
  // The plan table is what the server actually enforces and charges.
  // A marketing page quoting different numbers is not a copy problem —
  // it is a visitor seeing one price and being charged another.
  test("landing-page plan names match plans.ts", async ({ page }) => {
    await page.goto("/");
    const body = await page.locator("body").innerText();
    for (const plan of Object.values(PLANS).filter((p) => p.visible)) {
      expect(body, `landing page should offer the "${plan.name}" plan`).toContain(plan.name);
    }
  });

  test("landing-page prices match plans.ts", async ({ page }) => {
    await page.goto("/");
    const body = await page.locator("body").innerText();
    const expected = formatPrice(PRICES.growth.INR.monthly.amount, "INR");
    expect(body, `landing page should quote ${expected} for Growth, the price checkout charges`).toContain(expected);
  });
});

test.describe("public booking page", () => {
  const slug = process.env.E2E_BOOKING_SLUG;

  test("loads and offers services", async ({ page }) => {
    test.skip(!slug, "Set E2E_BOOKING_SLUG to a connection slug with active services.");
    await page.goto(`/book/${slug}`);
    await expect(page.locator("h1").first()).toBeVisible();
    // The booking flow's first step. If this is empty the page is up but
    // useless, which is the failure worth catching.
    await expect(page.getByRole("button").first()).toBeVisible();
  });
});
