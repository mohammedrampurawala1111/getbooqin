import { test, expect } from "@playwright/test";
import { seedTenant, signInAs, seedBookable, destroyTenant, disconnectFixtures, type SeededTenant } from "../fixtures/tenant";
import { PrismaClient } from "@prisma/client";

/**
 * Taking a deposit, end to end, through the screens a merchant uses.
 *
 * The thing this feature has to get right is not the maths — that's unit
 * tested — but the honesty. GetBooqin never sees the money, so every
 * screen has to say that a payment is the merchant's own assertion. A
 * merchant who believes the product is watching their bank will stop
 * watching it themselves, and that is worse than shipping nothing.
 */
const prisma = new PrismaClient();

let tenant: SeededTenant;
let serviceId = 0;
let resourceId = 0;
let customerId = 0;
let slot = 0;

async function booking(price: number, over: Record<string, unknown> = {}) {
  const start = new Date(Date.now() + 86_400_000 + slot++ * 3_600_000);
  return prisma.booking.create({
    data: {
      shop: tenant.shop,
      platform: tenant.platform,
      uid: `bk_ord_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      serviceId,
      resourceId,
      customerId,
      startUtc: start,
      endUtc: new Date(start.getTime() + 1_800_000),
      timezone: "Asia/Kolkata",
      status: "confirmed",
      price,
      currency: "INR",
      paymentStatus: "unpaid",
      ...over,
    } as never,
  });
}

async function setSettings(patch: Record<string, unknown>) {
  const row = await prisma.shopSettings.findFirst({ where: { shop: tenant.shop, platform: tenant.platform } });
  await prisma.shopSettings.update({
    where: { platform_shop: { platform: tenant.platform, shop: tenant.shop } },
    data: { data: JSON.stringify({ ...JSON.parse(row!.data), ...patch }) },
  });
}

test.beforeAll(async () => {
  tenant = await seedTenant("orders");
  const seeded = await seedBookable(tenant);
  serviceId = seeded.serviceId;
  resourceId = seeded.resourceId;

  const customer = await prisma.customer.create({
    data: {
      shop: tenant.shop,
      platform: tenant.platform,
      firstName: "Asha",
      lastName: "Iyer",
      email: "asha@example.com",
      phone: "+919876543210",
    },
  });
  customerId = customer.id;

  await setSettings({ business_name: "Acme Dental", currency: "INR", currency_symbol: "₹", upi_id: "acme@okhdfcbank" });
});

test.afterAll(async () => {
  await prisma.payment.deleteMany({ where: { shop: tenant.shop } });
  await prisma.booking.deleteMany({ where: { shop: tenant.shop } });
  await prisma.customer.deleteMany({ where: { shop: tenant.shop } });
  await destroyTenant(tenant);
  await prisma.$disconnect();
  await disconnectFixtures();
});

test.beforeEach(async ({ page }) => {
  await prisma.payment.deleteMany({ where: { shop: tenant.shop } });
  await prisma.booking.deleteMany({ where: { shop: tenant.shop } });
  await signInAs(page, tenant);
});

test.describe("setting up how you get paid", () => {
  test("takes a UPI ID and shows the real link before you trust it", async ({ page }) => {
    // Nothing can tell whether an address is *yours* — only that it's
    // the right shape. Seeing the actual link is the check that catches
    // a typo that is still valid.
    await page.goto(`/dashboard/${tenant.connectionId}/settings?page=payments`);

    await expect(page.getByLabel("UPI ID")).toHaveValue("acme@okhdfcbank");
    await expect(page.locator("code")).toContainText("upi://pay?");
    await expect(page.locator("code")).toContainText("pa=acme%40okhdfcbank");
    // Named apps rather than one generic link: a bare upi:// goes to
    // whichever app holds Android's default, and WhatsApp registers as
    // one — so "it opened WhatsApp" was the first thing testing hit.
    for (const app of ["Any UPI app", "PhonePe", "Google Pay", "Paytm", "BHIM"]) {
      await expect(page.getByRole("link", { name: app, exact: true })).toBeVisible();
    }
  });

  test("refuses something that is not a UPI ID", async ({ page }) => {
    await page.goto(`/dashboard/${tenant.connectionId}/settings?page=payments`);

    await page.getByLabel("UPI ID").fill("not-a-vpa");
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByText(/doesn't look like a UPI ID/)).toBeVisible();
    await setSettings({ upi_id: "acme@okhdfcbank" });
  });

  test("says plainly that nothing confirms a payment", async ({ page }) => {
    // The single most important sentence in the feature.
    await page.goto(`/dashboard/${tenant.connectionId}/settings?page=payments`);

    await expect(page.getByText(/Nothing tells us when they've paid/i)).toBeVisible();
    // Said in the page subtitle and again on the card — deliberately.
    await expect(page.getByText(/never holds it/i).first()).toBeVisible();
  });
});

test.describe("the orders screen", () => {
  test("lists a booking nobody has asked to pay yet", async ({ page }) => {
    await booking(2000);
    await page.goto(`/dashboard/${tenant.connectionId}/orders`);

    await expect(page.getByText("Asha Iyer")).toBeVisible();
    await expect(page.getByText("₹2000.00 owed")).toBeVisible();
  });

  test("puts the customer's email and phone on the row", async ({ page }) => {
    // Chasing a payment means phoning somebody. Making that a second
    // click is the friction that means it doesn't happen.
    await booking(2000);
    await page.goto(`/dashboard/${tenant.connectionId}/orders`);

    await expect(page.getByRole("link", { name: "asha@example.com" })).toBeVisible();
    await expect(page.getByRole("link", { name: "+919876543210" })).toBeVisible();
  });

  test("requests a payment, and shows a link and a QR for it", async ({ page }) => {
    await booking(2000);
    await page.goto(`/dashboard/${tenant.connectionId}/orders`);

    await page.getByRole("button", { name: /Request ₹2000\.00/ }).click();

    await expect(page.getByRole("link", { name: "Open link" })).toBeVisible();
    await page.getByRole("button", { name: "Show QR" }).click();
    await expect(page.getByAltText("Payment QR code")).toBeVisible();
  });

  test("the link pays the merchant, with the amount already in it", async ({ page }) => {
    await booking(2000);
    await page.goto(`/dashboard/${tenant.connectionId}/orders`);
    await page.getByRole("button", { name: /Request ₹2000\.00/ }).click();

    const href = await page.getByRole("link", { name: "Open link" }).getAttribute("href");

    expect(href).toContain("upi://pay?");
    expect(href).toContain("pa=acme%40okhdfcbank");
    expect(href).toContain("am=2000.00");
  });

  test("marks a payment received, with the UTR the customer quoted", async ({ page }) => {
    await booking(2000);
    await page.goto(`/dashboard/${tenant.connectionId}/orders`);
    await page.getByRole("button", { name: /Request ₹2000\.00/ }).click();

    await page.getByRole("button", { name: "Mark paid" }).click();
    await page.getByLabel("UTR or reference").fill("412345678901");
    await page.getByRole("button", { name: "Confirm" }).click();

    // Wait for the submission to land before navigating. page.goto()
    // while a form post is in flight cancels it, which looks exactly
    // like the action having failed.
    await expect(page.getByText(/Nothing outstanding/)).toBeVisible();

    // The row leaves the default "Owed" view the moment it settles —
    // which is the point of that view — so the record is checked where
    // it actually lives.
    await page.goto(`/dashboard/${tenant.connectionId}/orders?show=all`);

    await expect(page.getByText("412345678901")).toBeVisible();
    // The status on the row, not the filter button of the same name.
    await expect(page.locator("span").filter({ hasText: /^Settled$/ })).toBeVisible();
  });

  test("a settled booking leaves the owed list", async ({ page }) => {
    const row = await booking(2000);
    await page.goto(`/dashboard/${tenant.connectionId}/orders`);
    await page.getByRole("button", { name: /Request ₹2000\.00/ }).click();
    await page.getByRole("button", { name: "Mark paid" }).click();
    await page.getByRole("button", { name: "Confirm" }).click();
    // Same reason as above: don't navigate out from under the post.
    await expect(page.getByText(/Nothing outstanding/)).toBeVisible();

    await page.goto(`/dashboard/${tenant.connectionId}/orders?show=outstanding`);
    await expect(page.getByText("Asha Iyer")).toHaveCount(0);

    // And the booking itself agrees.
    expect((await prisma.booking.findUnique({ where: { id: row.id } }))?.paymentStatus).toBe("paid");
  });

  test("a cancelled request can be replaced", async ({ page }) => {
    await booking(2000);
    await page.goto(`/dashboard/${tenant.connectionId}/orders`);
    await page.getByRole("button", { name: /Request ₹2000\.00/ }).click();

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("cancelled")).toBeVisible();
    await expect(page.getByRole("button", { name: /Request ₹2000\.00/ })).toBeVisible();
  });

  test("keeps saying the merchant has to check their own bank", async ({ page }) => {
    await booking(2000);
    await page.goto(`/dashboard/${tenant.connectionId}/orders`);

    await expect(page.getByText(/GetBooqin can't see them/i)).toBeVisible();
  });
});

test.describe("which app opens the payment", () => {
  test("a pending request offers each major UPI app by name", async ({ page }) => {
    await booking(2000);
    await page.goto(`/dashboard/${tenant.connectionId}/orders`);
    await page.getByRole("button", { name: /^Request/ }).click();

    await page.getByRole("button", { name: "Pay with…" }).click();

    const phonepe = await page.getByRole("link", { name: "PhonePe", exact: true }).getAttribute("href");
    const gpay = await page.getByRole("link", { name: "Google Pay", exact: true }).getAttribute("href");

    expect(phonepe).toContain("phonepe://upi/pay?");
    expect(gpay).toContain("gpay://upi/pay?");
    // Same payment, different door.
    expect(phonepe).toContain("am=2000.00");
    expect(gpay).toContain("am=2000.00");
  });
});

test.describe("a UPI ID on a shop that doesn't price in rupees", () => {
  /**
   * The button and the server used to disagree. The loader asked "is a
   * UPI ID or PayPal handle set?" while the action asked "is there a
   * method that works for this currency?" — so a shop pricing in
   * dollars with a UPI ID was offered "Request $32.00", clicked it, and
   * was refused. UPI settles only in rupees; a link for a dollar amount
   * would ask for that many rupees instead.
   */
  test("does not offer a request it cannot fulfil, and says why", async ({ page }) => {
    await setSettings({ currency: "USD", currency_symbol: "$", upi_id: "acme@okhdfcbank", paypal_me: "" });
    await booking(2000);

    await page.goto(`/dashboard/${tenant.connectionId}/orders`);

    await expect(page.getByText(/UPI can't be used while you price in USD/)).toBeVisible();
    await expect(page.getByRole("button", { name: /^Request/ })).toHaveCount(0);

    await setSettings({ currency: "INR", currency_symbol: "₹" });
  });

  test("warns on the Payments page too, where the mistake is made", async ({ page }) => {
    await setSettings({ currency: "USD", currency_symbol: "$", upi_id: "acme@okhdfcbank" });

    await page.goto(`/dashboard/${tenant.connectionId}/settings?page=payments`);

    await expect(page.getByText(/This UPI ID won't be used/)).toBeVisible();

    await setSettings({ currency: "INR", currency_symbol: "₹" });
  });

  test("a PayPal link works for that shop instead", async ({ page }) => {
    await setSettings({ currency: "USD", currency_symbol: "$", upi_id: "acme@okhdfcbank", paypal_me: "acmedental" });
    await booking(2000);

    await page.goto(`/dashboard/${tenant.connectionId}/orders`);
    await page.getByRole("button", { name: /^Request/ }).click();

    const href = await page.getByRole("link", { name: "Open link" }).getAttribute("href");
    expect(href).toContain("paypal.me/acmedental");
    expect(href).toContain("USD");

    await setSettings({ currency: "INR", currency_symbol: "₹", paypal_me: "" });
  });
});

test.describe("when there is no way to be paid", () => {
  test("says so, and does not offer to request anything", async ({ page }) => {
    await setSettings({ upi_id: "", paypal_me: "" });
    await booking(2000);

    await page.goto(`/dashboard/${tenant.connectionId}/orders`);

    await expect(page.getByText(/haven't set up a way to be paid/)).toBeVisible();
    await expect(page.getByRole("button", { name: /^Request/ })).toHaveCount(0);

    await setSettings({ upi_id: "acme@okhdfcbank" });
  });
});
