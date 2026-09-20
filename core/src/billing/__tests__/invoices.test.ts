/**
 * Issuing a tax invoice.
 *
 * The failures here are not cosmetic. An invoice issued twice for one
 * payment, a number that repeats, a GSTIN that was never configured
 * appearing as a blank, a document that silently changes after it was
 * sent — each of those is a legal document being wrong, and none of
 * them can be taken back once it is in a customer's accounting system.
 *
 * Real Postgres, because the once-per-payment guarantee is a unique
 * index and the numbering is a row lock.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import prisma from "../../db.js";
import { issueInvoice, taxComponent, invoiceDeclaration, invoiceFilename } from "../invoices.js";
import type { SellerIdentity } from "../seller.js";
import { sellerIdentity } from "../seller.js";

const RUN = Date.now();
const userId = `inv-user-${RUN}`;
let connectionId = "";

const SELLER_ENV = {
  INVOICE_LEGAL_NAME: "Scintillaweb LLP",
  INVOICE_ADDRESS: "1 Example Road\\nPune 411001",
  INVOICE_GSTIN: "27AAACS1234A1Z5",
  INVOICE_SERIES_PREFIX: `T${RUN % 100000}`,
  INVOICE_LUT_ON_FILE: "true",
};

function configureSeller(over: Record<string, string | undefined> = {}) {
  for (const [k, v] of Object.entries({ ...SELLER_ENV, ...over })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function subscription(over: Record<string, unknown> = {}) {
  await prisma.subscription.upsert({
    where: { connectionId },
    create: {
      connectionId,
      plan: "starter",
      status: "active",
      currency: "EUR",
      billingCycle: "monthly",
      taxStatus: "export_zero_rated",
      taxCountry: "NL",
      taxId: "NL123456789B01",
      billingName: "Voorbeeld B.V.",
      billingAddress: "Keizersgracht 1\n1015 Amsterdam",
      ...over,
    } as never,
    update: {
      taxStatus: "export_zero_rated",
      taxCountry: "NL",
      taxId: "NL123456789B01",
      billingName: "Voorbeeld B.V.",
      billingAddress: "Keizersgracht 1\n1015 Amsterdam",
      ...over,
    } as never,
  });
}

const charge = (over: Record<string, unknown> = {}) => ({
  connectionId,
  provider: "razorpay",
  providerPaymentId: `pay_${RUN}_${Math.random().toString(36).slice(2, 10)}`,
  amountMinor: 500,
  currency: "EUR" as const,
  plan: "starter" as const,
  cycle: "monthly" as const,
  ...over,
});

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email: `inv-${RUN}@example.com` } });
  const conn = await prisma.connection.create({
    data: { userId, platform: "manual", shop: `inv-${RUN}`, credentials: "", status: "active" },
  });
  connectionId = conn.id;
});

beforeEach(async () => {
  configureSeller();
  await prisma.invoice.deleteMany({ where: { connectionId } });
  // The counter too. It deliberately never rewinds in production — a
  // reused invoice number is the thing an auditor opens with — so a
  // test that wants to assert on 0001 has to start the series fresh.
  await prisma.invoiceCounter.deleteMany({ where: { series: { startsWith: SELLER_ENV.INVOICE_SERIES_PREFIX } } });
  await subscription();
});

afterEach(() => {
  for (const k of Object.keys(SELLER_ENV)) delete process.env[k];
});

afterAll(async () => {
  await prisma.invoice.deleteMany({ where: { connectionId } });
  await prisma.invoiceCounter.deleteMany({ where: { series: { startsWith: SELLER_ENV.INVOICE_SERIES_PREFIX } } });
  await prisma.subscription.deleteMany({ where: { connectionId } });
  await prisma.connection.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

describe("issuing", () => {
  it("creates a numbered invoice for a payment", async () => {
    const result = await issueInvoice(charge());

    expect(result.issued).toBe(true);
    if (!result.issued) return;
    expect(result.invoice.number).toMatch(/^T\d+\/\d{4}-\d{2}\/0001$/);
    expect(result.invoice.amountMinor).toBe(500);
    expect(result.invoice.currency).toBe("EUR");
  });

  it("freezes the seller onto the row, so a later move doesn't rewrite it", async () => {
    // An invoice is a legal document that must keep saying what it said.
    const result = await issueInvoice(charge());
    expect(result.issued).toBe(true);

    process.env.INVOICE_LEGAL_NAME = "Somebody Else Ltd";
    process.env.INVOICE_ADDRESS = "Nowhere";

    const stored = await prisma.invoice.findFirst({ where: { connectionId } });
    expect(stored?.sellerName).toBe("Scintillaweb LLP");
    expect(stored?.sellerGstin).toBe("27AAACS1234A1Z5");
  });

  it("records who was billed and where", async () => {
    const result = await issueInvoice(charge());
    expect(result.issued).toBe(true);
    if (!result.issued) return;

    expect(result.invoice.buyerName).toBe("Voorbeeld B.V.");
    expect(result.invoice.buyerAddress).toContain("Amsterdam");
    expect(result.invoice.buyerTaxId).toBe("NL123456789B01");
    expect(result.invoice.buyerEmail).toBe(`inv-${RUN}@example.com`);
  });
});

describe("once per payment, whatever happens", () => {
  it("refuses a second invoice for the same payment", async () => {
    // A webhook redelivery. The customer must not receive two invoices
    // with different numbers for one charge.
    const args = charge();
    const first = await issueInvoice(args);
    const second = await issueInvoice(args);

    expect(first.issued).toBe(true);
    expect(second.issued).toBe(false);
    expect(second.reason).toBe("already invoiced");
    expect(await prisma.invoice.count({ where: { connectionId } })).toBe(1);
  });

  it("holds when a webhook and a reconciliation race", async () => {
    const args = charge();
    const results = await Promise.all([issueInvoice(args), issueInvoice(args), issueInvoice(args)]);

    expect(results.filter((r) => r.issued)).toHaveLength(1);
    expect(await prisma.invoice.count({ where: { connectionId } })).toBe(1);
  });

  it("numbers consecutive charges consecutively", async () => {
    await issueInvoice(charge());
    await issueInvoice(charge());
    const third = await issueInvoice(charge());

    expect(third.issued).toBe(true);
    if (!third.issued) return;
    expect(third.invoice.number).toMatch(/\/0003$/);
  });
});

describe("refusing rather than inventing", () => {
  it("issues nothing when the seller is not configured", async () => {
    // A placeholder GSTIN on a real invoice is worse than no invoice.
    configureSeller({ INVOICE_LEGAL_NAME: undefined });

    const result = await issueInvoice(charge());

    expect(result.issued).toBe(false);
    expect(result.reason).toContain("INVOICE_LEGAL_NAME");
    expect(await prisma.invoice.count({ where: { connectionId } })).toBe(0);
  });

  it("issues nothing when there is no billing name or address", async () => {
    // Deliberately does not fall back to the shop's trading name — an
    // invoice must name the entity being billed.
    await subscription({ billingName: "", billingAddress: "" });

    const result = await issueInvoice(charge());

    expect(result.issued).toBe(false);
    expect(result.reason).toContain("billing name or address");
  });

  it("does not burn an invoice number on a refusal", async () => {
    // A gap in a consecutive series needs explaining to an auditor, so
    // a refusal must not consume a number.
    const first = await issueInvoice(charge());
    expect(first.issued).toBe(true);

    await subscription({ billingName: "", billingAddress: "" });
    expect((await issueInvoice(charge())).issued).toBe(false);

    await subscription();
    const next = await issueInvoice(charge());

    expect(next.issued).toBe(true);
    if (!next.issued || !first.issued) return;
    const n = (v: string) => Number(v.split("/").pop());
    expect(n(next.invoice.number)).toBe(n(first.invoice.number) + 1);
  });
});

describe("tax", () => {
  it("backs GST out of an inclusive Indian price rather than adding to it", async () => {
    // ₹999 inclusive of 18% is ₹152.39 of tax, not ₹179.82. Adding
    // instead of extracting overstates tax on every invoice in the run.
    expect(taxComponent(99900, "india_gst")).toBe(15239);
    expect(taxComponent(50000, "india_gst")).toBe(7627);
  });

  it("charges no tax on an export", async () => {
    expect(taxComponent(500, "export_zero_rated")).toBe(0);
  });

  it("declares the LUT basis when one is on file", async () => {
    const seller = sellerIdentity()!;
    expect(invoiceDeclaration("export_zero_rated", "NL", seller)).toContain("Letter of Undertaking");
  });

  it("does not claim an LUT that isn't on file", async () => {
    // Claiming the wrong basis means we owe the tax.
    configureSeller({ INVOICE_LUT_ON_FILE: "false" });
    const seller = sellerIdentity()!;

    const note = invoiceDeclaration("export_zero_rated", "NL", seller);
    expect(note).not.toContain("Letter of Undertaking");
    expect(note).toContain("Zero-rated");
  });

  it("mentions the reverse charge for an EU customer", async () => {
    const seller = sellerIdentity()!;
    expect(invoiceDeclaration("export_zero_rated", "NL", seller)).toContain("reverse charge");
  });

  it("says GST applies for a domestic sale", async () => {
    const seller = sellerIdentity()!;
    expect(invoiceDeclaration("india_gst", "IN", seller)).toContain("GST");
    expect(invoiceDeclaration("india_gst", "IN", seller)).not.toContain("Export");
  });
});

describe("the file that lands in an inbox", () => {
  it("is named so an accountant can find it again", () => {
    expect(invoiceFilename({ number: "GB/2026-27/0001" })).toBe("GB-2026-27-0001.pdf");
  });
});

describe("an unregistered seller charges no GST", () => {
  /**
   * A business below India's registration threshold — ₹20 lakh for
   * services — is not merely excused from charging GST, it is not
   * permitted to. Collecting it without a registration is an offence,
   * and an invoice stating a tax component is the claim to have done
   * so, on a document the customer may use to claim input credit they
   * are not entitled to.
   *
   * INVOICE_GSTIN being blank is the signal, and seller.ts already
   * refuses to print a placeholder one for exactly this reason.
   */
  const registered: SellerIdentity = {
    legalName: "GetBooqin Pvt Ltd",
    address: "Mumbai",
    gstin: "27AAPFU0939F1ZV",
    country: "IN",
    seriesPrefix: "GB",
    lutOnFile: false,
  };
  const unregistered: SellerIdentity = { ...registered, gstin: "" };

  it("backs GST out of the total for a registered seller", () => {
    // Inclusive pricing, so the tax is backed *out* of the total:
    // 99900 × 18 / 118 = 15239 paise (₹152.39). Adding 18% instead
    // would give ₹179.82 and overstate the tax on every invoice.
    expect(taxComponent(99_900, "india_gst", true)).toBe(15_239);
  });

  it("reports no tax component when the seller has no GSTIN", () => {
    expect(taxComponent(99_900, "india_gst", false)).toBe(0);
  });

  it("says GST is included only when it actually is", () => {
    expect(invoiceDeclaration("india_gst", "IN", registered)).toContain("GST @");
    expect(invoiceDeclaration("india_gst", "IN", registered)).toContain("included");
  });

  it("says plainly that no GST was charged when it wasn't", () => {
    const line = invoiceDeclaration("india_gst", "IN", unregistered);

    expect(line).toContain("not registered under GST");
    expect(line).toContain("no GST has been charged");
    // The claim that must not survive: a customer reading this must not
    // believe there is input credit in it.
    expect(line).not.toContain("included in the amount shown");
  });

  it("changes nothing for an export, which was never taxed here", () => {
    expect(taxComponent(1_000, "export_zero_rated", true)).toBe(0);
    expect(taxComponent(1_000, "export_zero_rated", false)).toBe(0);
  });
});
