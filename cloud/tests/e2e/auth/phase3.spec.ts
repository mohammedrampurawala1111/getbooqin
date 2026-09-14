import { test, expect } from "@playwright/test";
import { seedTenant, signInAs, seedBookable, setPlan, destroyTenant, disconnectFixtures, type SeededTenant } from "../fixtures/tenant";
import { PrismaClient } from "@prisma/client";

/**
 * Phase 3 — self-serve onboarding.
 *
 * The three things a merchant now does without talking to anyone:
 * finish a three-step wizard, prove to themselves it works by booking
 * their own appointment, and put the form on their own website.
 *
 * In a real browser because all three are UI claims. "The onboarding is
 * three steps" is not something a unit test can be wrong about in a
 * useful way; a stale rail label or a card that throws on render is.
 */
const prisma = new PrismaClient();

let tenant: SeededTenant;

const BOOKING_URL_HOST = "http://localhost:3100";

test.beforeAll(async () => {
  tenant = await seedTenant("phase3");
  await seedBookable(tenant);

  // The public booking URL, which onboarding pins at step 1 for a real
  // account. seedTenant doesn't, so without this the embed snippet
  // correctly points at defaultSettings()' `https://<shop>` guess and
  // the test would be asserting against fixture data rather than the
  // product.
  const row = await prisma.shopSettings.findFirst({ where: { shop: tenant.shop, platform: tenant.platform } });
  await prisma.shopSettings.update({
    where: { platform_shop: { platform: tenant.platform, shop: tenant.shop } },
    data: {
      data: JSON.stringify({
        ...JSON.parse(row!.data),
        booking_page_url: `${BOOKING_URL_HOST}/book/${tenant.connectionId}`,
      }),
    },
  });
});

test.afterAll(async () => {
  await destroyTenant(tenant);
  await prisma.$disconnect();
  await disconnectFixtures();
});

test.describe("three-step onboarding", () => {
  test.beforeEach(async ({ page }) => {
    await signInAs(page, tenant);
  });

  test("counts three steps, not four", async ({ page }) => {
    await page.goto(`/onboarding?cid=${tenant.connectionId}`);

    await expect(page.getByText(/Step 1 of 3/)).toBeVisible();
  });

  test("the rail no longer offers an Integrations step", async ({ page }) => {
    // It was a whole screen whose only working control was "Skip for
    // now" — every row on it was a "coming soon".
    await page.goto(`/onboarding?cid=${tenant.connectionId}`);

    await expect(page.locator(".ob-rail")).not.toContainText("Integrations");
    await expect(page.locator(".ob-rail")).toContainText("Go live");
  });

  test("step 3 is Go live, reachable directly", async ({ page }) => {
    await page.goto(`/onboarding?cid=${tenant.connectionId}&step=3`);

    await expect(page.getByRole("heading", { name: "Go live", level: 1 })).toBeVisible();
    await expect(page.getByText(/Step 3 of 3/)).toBeVisible();
  });

  test("step 4 no longer exists — a bookmarked link lands on the last real step", async ({ page }) => {
    await page.goto(`/onboarding?cid=${tenant.connectionId}&step=4`);

    await expect(page.getByText(/Step 3 of 3/)).toBeVisible();
  });
});

test.describe("the plan strip", () => {
  test.beforeEach(async ({ page }) => {
    await signInAs(page, tenant);
    await page.goto(`/onboarding?cid=${tenant.connectionId}&step=3`);
  });

  test("says what happens when the trial ends, before they go live", async ({ page }) => {
    await expect(page.getByText(/free for 30 days/i)).toBeVisible();
    await expect(page.getByText(/nothing is deleted/i)).toBeVisible();
  });

  test("shows the paid tiers with prices, and no way to be charged mid-setup", async ({ page }) => {
    const strip = page.locator(".card", { hasText: "free for 30 days" });

    await expect(strip.getByText("Starter", { exact: true })).toBeVisible();
    await expect(strip.getByText("Growth", { exact: true })).toBeVisible();
    // A price, in some currency, per month.
    await expect(strip.getByText(/\/mo/).first()).toBeVisible();
    await expect(strip.getByRole("button")).toHaveCount(0);
  });
});

test.describe("send yourself a test booking", () => {
  test("books a real appointment and says where the email went", async ({ page }) => {
    await signInAs(page, tenant);
    await page.goto(`/onboarding?cid=${tenant.connectionId}&step=3`);

    const before = await prisma.booking.count({ where: { shop: tenant.shop } });

    await page.getByRole("button", { name: /Send yourself a test/i }).click();

    // Names the address — "check your email" is useless if it went
    // somewhere they aren't looking.
    await expect(page.getByText(tenant.email)).toBeVisible({ timeout: 20_000 });

    // A real row, through the real create() path, not a simulation.
    expect(await prisma.booking.count({ where: { shop: tenant.shop } })).toBe(before + 1);

    const booking = await prisma.booking.findFirst({
      where: { shop: tenant.shop },
      orderBy: { id: "desc" },
    });
    expect(booking?.notes).toContain("safe to cancel");
  });
});

test.describe("the embed snippet", () => {
  test("gives a snippet pointing at this account's own booking page", async ({ page }) => {
    await signInAs(page, tenant);
    await page.goto(`/dashboard/${tenant.connectionId}/settings?page=integrations`);

    const card = page.locator(".card", { hasText: "Put booking on your website" });
    await expect(card).toBeVisible();

    const snippet = await card.locator("code").innerText();
    expect(snippet).toContain(`/book/${tenant.connectionId}`);
    expect(snippet).toContain("embed=1");
    // The host page must only accept height messages from this iframe.
    expect(snippet).toContain("e.source !== frame.contentWindow");
  });

  test("copies to the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await signInAs(page, tenant);
    await page.goto(`/dashboard/${tenant.connectionId}/settings?page=integrations`);

    const card = page.locator(".card", { hasText: "Put booking on your website" });
    await card.getByRole("button", { name: "Copy" }).click();

    await expect(card.getByRole("button", { name: "Copied" })).toBeVisible();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain("<iframe");
    expect(clipboard).toContain("embed=1");
  });
});

test.describe("the printable booking QR", () => {
  /**
   * The cheapest distribution a small business has: print it, tape it
   * to the window. Unlike the payment QR there is no app chooser to
   * worry about — a phone camera opens an https:// link directly.
   */
  test("shows a real preview pointing at this account's booking page", async ({ page }) => {
    await signInAs(page, tenant);
    await page.goto(`/dashboard/${tenant.connectionId}/settings?page=integrations`);

    const card = page.locator(".card", { hasText: "Your booking QR code" });
    await expect(card).toBeVisible();

    // The alt text carries the URL, so what it encodes is checkable
    // without decoding the image.
    const alt = await card.locator("img").getAttribute("alt");
    expect(alt).toContain(`/book/${tenant.connectionId}`);
    await expect(card.locator("img")).toHaveAttribute("src", /^data:image\/png;base64,/);
  });

  test("downloads a print-resolution PNG", async ({ page }) => {
    await signInAs(page, tenant);

    const response = await page.request.get(`/dashboard/${tenant.connectionId}/booking-qr.png`);

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");
    expect(response.headers()["content-disposition"]).toContain("attachment");

    const body = await response.body();
    // PNG magic number, then enough bytes to be a 1024px code rather
    // than the on-screen preview.
    expect(body.subarray(1, 4).toString()).toBe("PNG");
    expect(body.length).toBeGreaterThan(3000);
  });

  test("is not reachable without a session", async ({ browser }) => {
    const anon = await browser.newPage();

    const response = await anon.request.get(`/dashboard/${tenant.connectionId}/booking-qr.png`);

    expect(response.headers()["content-type"]).not.toContain("image/png");
    await anon.close();
  });
});

test.describe("embed mode on the booking page", () => {
  test("drops the page's own header, which the host site already has", async ({ page }) => {
    await page.goto(`/book/${tenant.connectionId}`);
    const hosted = await page.locator("body").innerText();

    await page.goto(`/book/${tenant.connectionId}?embed=1`);
    const embedded = await page.locator("body").innerText();

    // Same booking flow, minus the business-name banner.
    await expect(page.getByRole("heading").first()).toBeVisible();
    expect(hosted.length).toBeGreaterThan(embedded.length);
  });

  test("keeps the GetBooqin badge — an iframe is not a way around a paid plan", async ({ page }) => {
    // Free, because the badge is what `no_badge` buys and the seeded
    // tenant is on a Growth trial, which already includes it. On Free
    // the badge must survive being embedded.
    await setPlan(tenant, "free");

    await page.goto(`/book/${tenant.connectionId}`);
    await expect(page.getByText(/powered by GetBooqin/i)).toBeVisible();

    await page.goto(`/book/${tenant.connectionId}?embed=1`);
    await expect(page.getByText(/powered by GetBooqin/i)).toBeVisible();
  });

  test("honours no_badge inside the iframe exactly as it does outside", async ({ page }) => {
    await setPlan(tenant, "growth");

    await page.goto(`/book/${tenant.connectionId}?embed=1`);
    await expect(page.getByRole("heading").first()).toBeVisible();
    await expect(page.getByText(/powered by GetBooqin/i)).toHaveCount(0);
  });

  test("tells the host page how tall it is", async ({ page }) => {
    // Without this the merchant picks one iframe height and it is wrong
    // on every screen of the flow.
    const heights: number[] = [];
    await page.exposeFunction("__recordHeight", (h: number) => void heights.push(h));
    await page.addInitScript(() => {
      window.addEventListener("message", (e) => {
        const data = e.data as { type?: string; height?: number };
        if (data?.type === "getbooqin:height" && data.height) {
          (window as unknown as { __recordHeight: (h: number) => void }).__recordHeight(data.height);
        }
      });
    });

    await page.goto(`/book/${tenant.connectionId}?embed=1`);
    await expect.poll(() => heights.length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(heights[0]).toBeGreaterThan(100);
  });
});
