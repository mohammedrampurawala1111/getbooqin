import { test, expect } from "@playwright/test";

/**
 * The 10-01-2026 review fixes, driven through a real browser.
 *
 * Public surface only — everything here is reachable without a session,
 * which is most of what the review was actually about: the booking
 * page, the manage page, the waitlist links, the deposit flow.
 *
 * Needs a seeded tenant. `E2E_QA_CTX` is the JSON the QA seed prints:
 * {connectionId, slug, serviceId, paidServiceId, resourceId}. Skipped
 * without it rather than failing, so this file is safe in the shared
 * suite.
 */
const ctx = process.env.E2E_QA_CTX ? JSON.parse(process.env.E2E_QA_CTX) : null;

test.skip(!ctx, "Set E2E_QA_CTX to the QA seed output.");

/**
 * Walks the wizard to the details form.
 *
 * The waits are not decoration: the day list and the slot grid are both
 * client-side fetcher loads that land *after* networkidle, so a probe
 * without them sees an empty step and concludes the page is broken.
 */
async function reachDetails(page: import("@playwright/test").Page, serviceName: string) {
  await page.goto(`/book/${ctx.slug}`);
  await page.getByRole("button", { name: new RegExp(serviceName, "i") }).first().click();
  // The resource step is skipped when the business has only one.
  await page.getByRole("button", { name: /Open/i }).first().waitFor({ timeout: 15_000 });
  await page.locator("button.tile").first().click();

  const slot = page.locator("button.tile").filter({ hasText: /\d{1,2}:\d{2}/ }).first();
  await slot.waitFor({ timeout: 15_000 });
  await slot.click();
  await page.getByRole("button", { name: /^Continue$/ }).click();
  await page.locator("#phone").waitFor({ timeout: 15_000 });
}

test.describe("item 11 — the booking slug", () => {
  test("the random slug resolves", async ({ page }) => {
    const res = await page.goto(`/book/${ctx.slug}`);
    expect(res?.status()).toBeLessThan(400);
    await expect(page.locator("h1").first()).toBeVisible();
  });

  test("the raw connection id still resolves, so old links survive", async ({ page }) => {
    const res = await page.goto(`/book/${ctx.connectionId}`);
    expect(res?.status()).toBeLessThan(400);
  });

  test("an unknown slug does not 500", async ({ page }) => {
    const res = await page.goto("/book/definitely-not-a-slug");
    expect(res?.status()).toBeGreaterThanOrEqual(400);
    expect(res?.status()).toBeLessThan(500);
  });
});

test.describe("item 14 — the internal shop key never reaches a customer", () => {
  test("no manual-<uuid> anywhere on the booking page", async ({ page }) => {
    await page.goto(`/book/${ctx.slug}`);
    const body = await page.locator("body").innerText();
    expect(body).not.toMatch(/manual-[0-9a-f]{8}-/i);
  });
});

test.describe("item 5 — the phone field", () => {
  test("shows a validation error on blur, not only at submit", async ({ page }) => {
    // The review reported this as "the form accepts invalid text". The
    // submit never did — client and server both refused it. What was
    // true is that nothing said so until Confirm, so a field the
    // customer had already moved past looked accepted.
    await reachDetails(page, "Standard appointment");

    // Scoped to the inline field error. The same message also appears in
    // the form's error summary (an <a> jumping to the field) — that
    // duplication is the accessible pattern, not a bug, so the selector
    // has to be specific rather than the assertion loosened.
    const fieldError = page.locator(".field-error", { hasText: "Enter a valid phone number." });

    await page.locator("#phone").fill("asadad");
    await page.locator("#phone").blur();
    await expect(fieldError).toBeVisible();

    await page.locator("#phone").fill("+919325705315");
    await page.locator("#phone").blur();
    await expect(fieldError).toBeHidden();
  });
});

test.describe("item 6 — add to calendar is a chooser, not a download", () => {
  test("offers Google, Outlook and .ics", async ({ page }) => {
    await reachDetails(page, "Standard appointment");
    await page.locator("#first_name").fill("Cal");
    await page.locator("input[name=last_name]").fill("Endar");
    await page.locator("#email").fill(`cal-${Date.now()}@example.test`);
    await page.locator("#phone").fill("+919325705315");
    const consent = page.locator("input[name=consent]");
    if (await consent.count()) await consent.check();
    await page.getByRole("button", { name: /Confirm booking/i }).first().click();

    // Assert the booking actually landed before hunting for the
    // calendar control. Without this a failed submit shows up as a
    // 30-second timeout on a button that was never going to render,
    // which says nothing about why.
    await expect(page.getByRole("heading", { name: /You're booked/i })).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: /Add to calendar/i }).click();
    const hrefs = await page.locator("a").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
    expect(hrefs.some((h) => h.includes("calendar.google.com")), "Google link").toBe(true);
    expect(hrefs.some((h) => h.includes("outlook.live.com")), "Outlook link").toBe(true);
    // The .ics survives as the third option — still the only one that
    // works for Apple Calendar, and the only one that works offline.
    expect(hrefs.some((h) => h.startsWith("data:text/calendar")), ".ics download").toBe(true);
  });
});

test.describe("item 10 — waitlist links land somewhere", () => {
  test("a bad claim token 404s rather than rendering the booking wizard", async ({ page }) => {
    const res = await page.goto(`/book/${ctx.slug}?getbooqin_claim=not-a-real-token`);
    expect(res?.status()).toBe(404);
  });

  test("a bad waitlist uid 404s rather than silently ignoring the parameter", async ({ page }) => {
    // Before the fix this rendered the booking wizard as though nothing
    // had been asked — the link in every waitlist email did nothing.
    const res = await page.goto(`/book/${ctx.slug}?getbooqin_waitlist=not-a-real-uid`);
    expect(res?.status()).toBe(404);
  });
});

test.describe("item 3 — nothing advertises two-step verification", () => {
  test("the public surface makes no 2FA promise", async ({ page }) => {
    for (const path of ["/", "/login", "/signup"]) {
      await page.goto(path);
      const body = (await page.locator("body").innerText()).toLowerCase();
      expect(body, `${path} must not promise 2FA`).not.toContain("two-step verification");
    }
  });
});

test.describe("security boundaries the new routes must not widen", () => {
  test("the gateway connect route is not a GET", async ({ page }) => {
    const res = await page.goto("/connect/razorpay");
    expect(res?.status()).toBe(404);
  });

  test("the payments webhook rejects an unsigned POST", async ({ request }) => {
    const res = await request.post("/webhooks/razorpay/payments?account=acc_fake", {
      data: { event: "payment.captured" },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test("the payments webhook rejects a POST with no account at all", async ({ request }) => {
    const res = await request.post("/webhooks/razorpay/payments", { data: {} });
    expect(res.status()).toBe(400);
  });
});
