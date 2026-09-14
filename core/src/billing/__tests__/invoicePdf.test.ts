/**
 * The PDF a customer actually receives.
 *
 * Worth testing because the failure is silent and remote: a malformed
 * or half-empty PDF is opened by someone else's accountant, weeks
 * later, and nothing here ever logs an error. The assertions are about
 * the things that make it a *tax* document rather than a receipt —
 * every party named, the number present, the declaration present.
 */
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { Invoice } from "@prisma/client";
import { renderInvoicePdf } from "../invoicePdf.js";

const invoice = (over: Partial<Invoice> = {}): Invoice =>
  ({
    id: "inv_1",
    connectionId: "conn_1",
    number: "GB/2026-27/0001",
    series: "GB/2026-27",
    issuedAt: new Date("2026-10-12T10:00:00Z"),
    sellerName: "Scintillaweb LLP",
    sellerAddress: "1 Example Road\nPune 411001",
    sellerGstin: "27AAACS1234A1Z5",
    sellerCountry: "IN",
    buyerName: "Voorbeeld B.V.",
    buyerAddress: "Keizersgracht 1\n1015 Amsterdam",
    buyerEmail: "finance@voorbeeld.example",
    buyerTaxId: "NL123456789B01",
    buyerCountry: "NL",
    taxStatus: "export_zero_rated",
    taxNote: "Supply meant for export of services under Letter of Undertaking without payment of integrated tax.",
    currency: "EUR",
    amountMinor: 500,
    taxAmountMinor: 0,
    planId: "starter",
    billingCycle: "monthly",
    periodStart: new Date("2026-10-12T00:00:00Z"),
    periodEnd: new Date("2026-11-12T00:00:00Z"),
    provider: "razorpay",
    providerPaymentId: "pay_1",
    providerInvoiceId: "inv_rzp_1",
    createdAt: new Date(),
    ...over,
  }) as Invoice;

/**
 * The readable text on the page.
 *
 * Two layers in the way, both of which silently yield nothing if you
 * ignore them. pdfkit Flate-compresses its content streams, so the
 * bytes have to be inflated first; and it writes text as hex-encoded
 * `TJ` arrays (`<54> <617820496e>`) rather than literal `(…)` strings,
 * so the operands have to be hex-decoded. Matching the raw file for a
 * plain string finds nothing and looks exactly like a blank page.
 */
async function textOf(inv: Invoice): Promise<string> {
  const pdf = await renderInvoicePdf(inv);
  const out: string[] = [];

  let from = 0;
  for (;;) {
    const start = pdf.indexOf("stream", from);
    if (start === -1) break;
    const end = pdf.indexOf("endstream", start);
    if (end === -1) break;

    // Skip the EOL after the `stream` keyword.
    let begin = start + "stream".length;
    if (pdf[begin] === 0x0d) begin += 1;
    if (pdf[begin] === 0x0a) begin += 1;

    try {
      const content = inflateSync(pdf.subarray(begin, end)).toString("latin1");
      // Hex operands, then literal ones — pdfkit emits the former, but
      // both are valid PDF and either could show up.
      for (const m of content.matchAll(/<([0-9a-fA-F]+)>/g)) {
        out.push(Buffer.from(m[1], "hex").toString("latin1"));
      }
      for (const m of content.matchAll(/\(((?:[^()\\]|\\.)*)\)/g)) out.push(m[1]);
    } catch {
      // Not a Flate stream (an embedded font, say) — nothing to read.
    }
    from = end + 1;
  }

  return out.join("");
}

describe("it is a real PDF", () => {
  it("has a PDF header and some substance to it", async () => {
    const pdf = await renderInvoicePdf(invoice());

    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(800);
  });

  it("renders without a browser — no headless Chrome in the container", async () => {
    await expect(renderInvoicePdf(invoice())).resolves.toBeInstanceOf(Buffer);
  });
});

describe("what has to be on the page", () => {
  it("names both parties", async () => {
    const text = await textOf(invoice());

    expect(text).toContain("Scintillaweb LLP");
    expect(text).toContain("Voorbeeld B.V.");
  });

  it("carries the invoice number and the date", async () => {
    const text = await textOf(invoice());

    expect(text).toContain("GB/2026-27/0001");
    expect(text).toContain("2026");
  });

  it("shows our GSTIN and labels the buyer's number correctly for their country", async () => {
    // "GSTIN" printed over a Dutch VAT number is wrong on the face of
    // the document.
    const text = await textOf(invoice());

    expect(text).toContain("27AAACS1234A1Z5");
    expect(text).toContain("Tax ID");
    expect(text).toContain("NL123456789B01");
  });

  it("says GSTIN for an Indian buyer", async () => {
    const text = await textOf(
      invoice({ buyerCountry: "IN", buyerTaxId: "29AAACX5678B1Z2", taxStatus: "india_gst" })
    );

    expect(text).toContain("GSTIN: 29AAACX5678B1Z2");
  });

  it("carries the tax declaration", async () => {
    const text = await textOf(invoice());

    expect(text).toContain("Letter of Undertaking");
  });

  it("shows a tax line even when it is zero", async () => {
    // A blank where tax belongs reads as an omission; an explicit zero
    // beside the zero-rating note reads as the statement it is.
    const text = await textOf(invoice());

    expect(text).toContain("Tax");
    // The amount, not the symbol: pdfkit encodes € as WinAnsi 0x80,
    // which is not the same byte once the stream is read back as latin1.
    expect(text).toContain("0.00");
  });

  it("shows the amount and calls it paid", async () => {
    const text = await textOf(invoice());

    expect(text).toContain("Total paid");
    expect(text).toContain("5.00");
  });

  it("names the plan and the billing period", async () => {
    const text = await textOf(invoice());

    expect(text).toContain("Starter");
    expect(text).toContain("Billing period");
  });
});

describe("the awkward inputs", () => {
  it("survives a business with no tax number", async () => {
    const text = await textOf(invoice({ buyerTaxId: "" }));

    expect(text).toContain("Voorbeeld B.V.");
    expect(text).not.toContain("Tax ID:");
  });

  it("survives a seller with no GSTIN", async () => {
    // Legitimate below the registration threshold.
    const text = await textOf(invoice({ sellerGstin: "" }));

    expect(text).toContain("Scintillaweb LLP");
    expect(text).not.toContain("GSTIN:");
  });

  it("handles an Indian invoice with tax actually on it", async () => {
    const text = await textOf(
      invoice({
        currency: "INR",
        amountMinor: 99900,
        taxAmountMinor: 15239,
        taxStatus: "india_gst",
        taxNote: "Supply of services within India. GST @ 18% is included in the amount shown.",
      })
    );

    expect(text).toContain("GST (included)");
    expect(text).toContain("18%");
    // Exact amounts, with decimals — ₹152.39, not ₹152. An invoice
    // whose subtotal and tax do not sum to its total is the first thing
    // anyone checking it notices.
    expect(text).toContain("152.39");
    expect(text).toContain("846.61");
    expect(text).toContain("999.00");
  });

  it("does not fall over on a long multi-line address", async () => {
    const long = Array.from({ length: 6 }, (_, i) => `Address line ${i + 1} that is quite long indeed`).join("\n");
    const pdf = await renderInvoicePdf(invoice({ buyerAddress: long }));

    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
