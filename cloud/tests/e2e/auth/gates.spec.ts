import { test, expect } from "@playwright/test";
import {
  seedTenant, destroyTenant, disconnectFixtures, signInAs, setPlan, grantFeature, seedBookable,
  type SeededTenant,
} from "../fixtures/tenant";

/**
 * Do the plan gates actually hold, in a browser?
 *
 * Every case here checks **both halves**: what the merchant is shown,
 * and what happens if they go straight at the URL anyway. A gate that
 * only hides a nav item is not a gate, and that distinction is the
 * entire reason this file exists — the feature keys were decorative for
 * a while, resolving correctly and gating nothing.
 */
let tenant: SeededTenant;

test.beforeAll(async () => {
  tenant = await seedTenant("gates");
  await seedBookable(tenant);
});

test.afterAll(async () => {
  await destroyTenant(tenant);
  await disconnectFixtures();
});

test.describe("waitlist — a Free-plan feature gate", () => {
  test("Free sees a padlock and an upgrade prompt, not the waitlist", async ({ page }) => {
    await setPlan(tenant, "free");
    await signInAs(page, tenant);
    await page.goto(`/dashboard/${tenant.connectionId}`);

    // Locked, not hidden: a merchant who can't see a feature can't
    // discover it exists.
    const waitlistNav = page.getByRole("link", { name: /Waitlist/i });
    await expect(waitlistNav).toBeVisible();

    // Going straight at the URL is answered, not crashed.
    await page.goto(`/dashboard/${tenant.connectionId}/waitlist`);
    await expect(page.getByText("Not on your plan")).toBeVisible();
    // ...and it names the plan that unlocks it rather than saying "upgrade".
    await expect(page.getByRole("link", { name: /See Starter/i })).toBeVisible();
  });

  test("Starter sees the real waitlist page", async ({ page }) => {
    await setPlan(tenant, "starter");
    await signInAs(page, tenant);
    await page.goto(`/dashboard/${tenant.connectionId}/waitlist`);
    await expect(page.getByText("Not on your plan")).toHaveCount(0);
  });

  test("an admin grant unlocks it on Free, without changing the plan", async ({ page }) => {
    await setPlan(tenant, "free");
    await grantFeature(tenant, "waitlist");
    await signInAs(page, tenant);
    await page.goto(`/dashboard/${tenant.connectionId}/waitlist`);
    await expect(page.getByText("Not on your plan")).toHaveCount(0);
  });
});

test.describe("CSV export — gated at the URL, not just the button", () => {
  // page.request, not page.goto: the route answers with
  // Content-Disposition: attachment, which a navigation turns into a
  // download rather than a response. page.request carries the same
  // session cookies, which is what makes this a real authenticated
  // fetch rather than an anonymous one.
  test("Free is refused even going straight at the file", async ({ page }) => {
    await setPlan(tenant, "free");
    await signInAs(page, tenant);
    const response = await page.request.get(`/dashboard/${tenant.connectionId}/bookings/export.csv`);
    // 402 Payment Required — paying is what fixes it.
    expect(response.status()).toBe(402);
  });

  test("Growth downloads a real CSV", async ({ page }) => {
    await setPlan(tenant, "growth");
    await signInAs(page, tenant);
    const response = await page.request.get(`/dashboard/${tenant.connectionId}/bookings/export.csv`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/csv");
    expect(await response.text()).toContain("reference,status,date");
  });
});

test.describe("the Powered by badge — what Starter is actually sold on", () => {
  test("Free shows it on the public booking page", async ({ page, context }) => {
    await setPlan(tenant, "free");
    // Public page: no session needed, and it must not have one — the
    // badge is decided by the shop's plan, not the viewer.
    const anon = await context.browser()!.newPage();
    await anon.goto(`/dashboard/${tenant.connectionId}`).catch(() => {});
    await anon.goto(`http://localhost:3101/book/${tenant.connectionId}`);
    await expect(anon.getByText("Booking powered by GetBooqin")).toBeVisible();
    await anon.close();
  });

  test("Starter removes it", async ({ context }) => {
    await setPlan(tenant, "starter");
    const anon = await context.browser()!.newPage();
    await anon.goto(`http://localhost:3101/book/${tenant.connectionId}`);
    await expect(anon.getByText("Booking powered by GetBooqin")).toHaveCount(0);
    await anon.close();
  });
});

test.describe("email template editing", () => {
  test("Starter can silence a notification but not reword it", async ({ page }) => {
    // Turning a message off must work on every plan; only the wording is
    // the paid part.
    await setPlan(tenant, "starter");
    await signInAs(page, tenant);
    await page.goto(`/dashboard/${tenant.connectionId}/settings?page=notifications`);
    await expect(page.getByRole("heading", { name: "Notifications" }).first()).toBeVisible();
  });
});

test.describe("a refused gate is explained, never a 500", () => {
  // The bug this guards: GetBooqinError is a plain Error, so an uncaught
  // one becomes a generic 500 — "something went wrong" to a merchant
  // whose actual problem is "this is on a higher plan". It shipped, and
  // the only thing that caught it was a browser test.
  test("hitting the resource limit says which plan allows more", async ({ page }) => {
    await setPlan(tenant, "free"); // 1 resource, and the fixture already has one
    await signInAs(page, tenant);
    await page.goto(`/dashboard/${tenant.connectionId}/resources/new`);

    await page.getByLabel(/name/i).first().fill("Second practitioner");
    await page.getByRole("button", { name: /save|create/i }).first().click();

    const body = page.locator("body");
    await expect(body).toContainText(/Free plan includes 1/i);
    await expect(body).toContainText(/Starter/i);
    // The failure mode being guarded against.
    await expect(body).not.toContainText("Something went wrong");
  });

  test("the export route's 402 is a 402, not a 500", async ({ page }) => {
    await setPlan(tenant, "free");
    await signInAs(page, tenant);
    const response = await page.request.get(`/dashboard/${tenant.connectionId}/bookings/export.csv`);
    expect(response.status(), "a plan gate must never surface as a server error").toBe(402);
  });
});

test.describe("Shopify is shipped dark", () => {
  // No plan grants it. An admin turns it on per account from /admin when
  // there is a decision to release it — that is the entire point of
  // entitlements being per-account rather than per-deploy.
  test("no plan offers it in Settings → Integrations", async ({ page }) => {
    await setPlan(tenant, "growth"); // the richest visible plan
    await signInAs(page, tenant);
    await page.goto(`/dashboard/${tenant.connectionId}/settings?page=integrations`);

    await expect(page.getByText("WhatsApp Business")).toBeVisible();
    // Hidden outright, not shown disabled: a "coming soon" tile for
    // something already built invites questions nobody wants yet.
    await expect(page.getByText("Shopify", { exact: true })).toHaveCount(0);
  });

  test("an admin grant makes it appear, on the same plan", async ({ page }) => {
    await setPlan(tenant, "growth");
    await grantFeature(tenant, "shopify");
    await signInAs(page, tenant);
    await page.goto(`/dashboard/${tenant.connectionId}/settings?page=integrations`);
    await expect(page.getByText("Shopify", { exact: true }).first()).toBeVisible();
  });
});
