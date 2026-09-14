import { test, expect } from "@playwright/test";
import { PLANS, PRICES, formatPrice, providerForCurrency } from "getbooqin-core/billing/plans";

/**
 * The release gate.
 *
 * Run against a deployment immediately after it goes out — this is the
 * suite whose failure means roll back, not open a ticket. It is
 * deliberately small: everything here is either "the product's one job"
 * or "we take money for this", and nothing here needs a seeded account,
 * so it can be pointed at production without creating anything.
 *
 *   npm run smoke -- (E2E_BASE_URL=https://getbooqin.fly.dev)
 *
 * The wider public suite covers copy and boundaries; this covers "is it
 * alive and can it still be paid". Both run read-only; neither writes.
 */
const BOOKING_SLUG = process.env.E2E_BOOKING_SLUG;

test.describe("the deployment is alive", () => {
  test("serves the marketing page", async ({ page }) => {
    const response = await page.goto("/");

    expect(response?.status()).toBe(200);
    await expect(page.locator("h1").first()).toBeVisible();
  });

  test("healthz reports the database and every job as healthy", async ({ page }) => {
    // ?strict=1 is the one that fails on a stale job, which is how a
    // silently dead reminder sweep becomes visible at all.
    const response = await page.request.get("/healthz?strict=1");

    expect(response.status(), "strict health must be green after a deploy").toBe(200);
    const body = (await response.json()) as {
      checks: { database: string; jobs: { name: string; stale: boolean; failure_count: number }[] };
    };

    expect(body.checks.database).toBe("ok");
    expect(body.checks.jobs.length, "no scheduled jobs registered at all").toBeGreaterThan(0);
    for (const job of body.checks.jobs) {
      expect(job.stale, `job "${job.name}" is stale`).toBe(false);
    }
  });

  test("the login page renders — nobody can get in if this is broken", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator("body")).toContainText(/sign in|log in|email/i);
  });
});

test.describe("money can still be taken", () => {
  test("both webhook endpoints are routed and reject unsigned deliveries", async ({ page }) => {
    // A webhook silently 404ing is how a renewal stops being recorded
    // while the card keeps being charged. 400 proves it is routed *and*
    // verifying.
    for (const path of ["/webhooks/razorpay", "/webhooks/paypal"]) {
      const response = await page.request.post(path, {
        headers: { "content-type": "application/json" },
        data: { event: "smoke" },
      });
      expect(response.status(), `${path} should reject an unsigned delivery`).toBe(400);
    }
  });

  test("a GET on a webhook is refused without pretending the URL is wrong", async ({ page }) => {
    for (const path of ["/webhooks/razorpay", "/webhooks/paypal"]) {
      expect((await page.request.get(path)).status(), path).toBe(405);
    }
  });

  test("the prices on the public page are the prices that get charged", async ({ page }) => {
    // A visitor quoted one number and charged another is not a copy bug.
    await page.goto("/");
    const body = await page.locator("body").innerText();

    for (const plan of Object.values(PLANS).filter((p) => p.visible)) {
      expect(body, `plan "${plan.name}" missing`).toContain(plan.name);
    }
    expect(body).toContain(formatPrice(PRICES.growth.INR.monthly.amount, "INR"));
  });

  test("each currency still routes to a rail", async () => {
    // Pure check, but it belongs in the gate: a currency with no
    // provider means an upgrade button that cannot work, and the split
    // is a one-line change away from being wrong.
    expect(providerForCurrency("INR")).toBe("razorpay");
    expect(providerForCurrency("EUR")).toBe("paypal");
    expect(providerForCurrency("USD")).toBe("paypal");
  });
});

test.describe("the booking loop", () => {
  test("a real booking page loads and offers something to book", async ({ page }) => {
    // The product's one job. Skipped rather than failed when no slug is
    // configured, because a gate that fails for a missing env var
    // teaches people to ignore it.
    test.skip(!BOOKING_SLUG, "Set E2E_BOOKING_SLUG to a connection with active services.");

    await page.goto(`/book/${BOOKING_SLUG}`);

    await expect(page.locator("h1").first()).toBeVisible();
    // A page that renders but offers nothing is up and useless, which is
    // the failure worth catching.
    await expect(page.getByRole("button").first()).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/Something went wrong/i);
  });

  test("the booking page can be embedded", async ({ page }) => {
    test.skip(!BOOKING_SLUG, "Set E2E_BOOKING_SLUG.");

    await page.goto(`/book/${BOOKING_SLUG}?embed=1`);
    await expect(page.getByRole("button").first()).toBeVisible();
  });
});

test.describe("nothing private is reachable", () => {
  test("the dashboard and admin need a session", async ({ page }) => {
    for (const path of ["/dashboard", "/admin"]) {
      const response = await page.request.get(path);
      const body = await response.text();
      expect(body, `${path} must not render without a session`).not.toContain("Sign out");
    }
  });
});
