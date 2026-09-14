import { test, expect } from "@playwright/test";
import { seedTenant, signInAs, destroyTenant, disconnectFixtures, type SeededTenant } from "../fixtures/tenant";
import { PrismaClient } from "@prisma/client";

/**
 * Invoices, from the merchant's side.
 *
 * The generation and numbering are covered by unit tests; what this
 * covers is whether a merchant can actually get the document —
 * including the case that matters most, which is a year later when they
 * need last March's invoice for their accountant and the email is long
 * gone.
 *
 * Also the boundary: an invoice is a tax document with a named party on
 * it, and an id from another account must not resolve.
 */
const prisma = new PrismaClient();

let tenant: SeededTenant;
let other: SeededTenant;
let invoiceId = "";
let otherInvoiceId = "";

const RUN = Date.now();

async function seedInvoice(t: SeededTenant, over: Record<string, unknown> = {}): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const invoice = await prisma.invoice.create({
    data: {
      connectionId: t.connectionId,
      number: `E2E/${RUN}/${suffix}`,
      series: `E2E/${RUN}`,
      issuedAt: new Date("2026-10-12T10:00:00Z"),
      sellerName: "Scintillaweb LLP",
      sellerAddress: "1 Example Road\nPune 411001",
      sellerGstin: "27AAACS1234A1Z5",
      buyerName: "Voorbeeld B.V.",
      buyerAddress: "Keizersgracht 1\n1015 Amsterdam",
      buyerEmail: t.email,
      buyerTaxId: "NL123456789B01",
      buyerCountry: "NL",
      taxStatus: "export_zero_rated",
      taxNote: "Supply meant for export of services under Letter of Undertaking without payment of integrated tax.",
      currency: "EUR",
      amountMinor: 500,
      taxAmountMinor: 0,
      planId: "starter",
      billingCycle: "monthly",
      provider: "razorpay",
      providerPaymentId: `pay_e2e_${RUN}_${suffix}`,
      ...over,
    } as never,
  });
  return invoice.id;
}

test.beforeAll(async () => {
  tenant = await seedTenant("inv");
  other = await seedTenant("inv-other");
  invoiceId = await seedInvoice(tenant);
  otherInvoiceId = await seedInvoice(other);
});

test.afterAll(async () => {
  await prisma.invoice.deleteMany({ where: { connectionId: { in: [tenant.connectionId, other.connectionId] } } });
  await destroyTenant(tenant);
  await destroyTenant(other);
  await prisma.$disconnect();
  await disconnectFixtures();
});

test.describe("the invoice list", () => {
  test("shows every invoice issued on the account", async ({ page }) => {
    await signInAs(page, tenant);
    await page.goto(`/dashboard/${tenant.connectionId}/settings?page=billing`);

    const card = page.locator(".card", { hasText: "Invoices" });
    await expect(card).toBeVisible();
    await expect(card.getByText(`E2E/${RUN}/`, { exact: false })).toBeVisible();
    await expect(card.getByText("€5.00")).toBeVisible();
  });

  test("says so plainly when there are none yet", async ({ page }) => {
    await signInAs(page, other);
    await prisma.invoice.deleteMany({ where: { connectionId: other.connectionId } });
    await page.goto(`/dashboard/${other.connectionId}/settings?page=billing`);

    await expect(page.getByText(/No invoices yet/)).toBeVisible();

    otherInvoiceId = await seedInvoice(other);
  });
});

test.describe("downloading one", () => {
  test("serves a real PDF as an attachment", async ({ page }) => {
    // page.request, not a click: the response is a download, so there is
    // no navigation to assert against.
    await signInAs(page, tenant);

    const response = await page.request.get(`/dashboard/${tenant.connectionId}/invoices/${invoiceId}.pdf`);

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/pdf");
    expect(response.headers()["content-disposition"]).toContain("attachment");
    // Named so it can be found again on a hard drive in April.
    expect(response.headers()["content-disposition"]).toMatch(/filename="E2E-\d+-[a-z0-9]+\.pdf"/);

    const body = await response.body();
    expect(body.subarray(0, 5).toString()).toBe("%PDF-");
    expect(body.length).toBeGreaterThan(800);
  });

  test("is never cached — it is a tax document tied to a session", async ({ page }) => {
    await signInAs(page, tenant);

    const response = await page.request.get(`/dashboard/${tenant.connectionId}/invoices/${invoiceId}.pdf`);

    expect(response.headers()["cache-control"]).toContain("no-store");
  });
});

test.describe("the boundary", () => {
  test("another account's invoice does not resolve", async ({ page }) => {
    // Guessing an id must not hand over somebody else's invoice, which
    // carries their legal name, address and tax number.
    await signInAs(page, tenant);

    const response = await page.request.get(`/dashboard/${tenant.connectionId}/invoices/${otherInvoiceId}.pdf`);

    expect(response.status()).toBe(404);
  });

  test("cannot be fetched through the other account's own URL either", async ({ page }) => {
    await signInAs(page, tenant);

    const response = await page.request.get(`/dashboard/${other.connectionId}/invoices/${otherInvoiceId}.pdf`);

    expect(response.status()).not.toBe(200);
  });

  test("a logged-out visitor gets the login page, not the PDF", async ({ browser }) => {
    const anon = await browser.newPage();

    // The status is 200 because requireTenant redirects to /login and
    // the request follows it — so the status says nothing useful here.
    // What matters is what came back, and where it came from.
    const response = await anon.request.get(`/dashboard/${tenant.connectionId}/invoices/${invoiceId}.pdf`);

    expect((await response.body()).subarray(0, 5).toString()).not.toBe("%PDF-");
    expect(response.headers()["content-type"]).not.toContain("application/pdf");
    expect(response.url()).toContain("/login");

    await anon.close();
  });
});

test.describe("billing details that make an invoice possible", () => {
  test("asks for the registered name and address", async ({ page }) => {
    // Without these nothing can be issued at all — see invoices.ts.
    await signInAs(page, tenant);
    await page.goto(`/dashboard/${tenant.connectionId}/settings?page=billing`);

    await expect(page.getByLabel("Registered business name")).toBeVisible();
    await expect(page.getByLabel("Billing address")).toBeVisible();
  });
});
