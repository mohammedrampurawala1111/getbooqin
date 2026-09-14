/**
 * Rendering an invoice as a PDF.
 *
 * A PDF rather than styled HTML because of what happens to this
 * document after it arrives: it gets forwarded to an accountant,
 * printed, and filed. An email body cannot be any of those things
 * reliably, and "view it in your dashboard" is not an answer to
 * "attach the invoice to this expense claim".
 *
 * Drawn with pdfkit, which is pure JavaScript — no headless browser to
 * install, keep patched, or watch fall over in a 256MB container. The
 * layout is deliberately plain: this is a document that has to be
 * legible and complete, not designed.
 *
 * Everything printed comes from the Invoice row, never from live
 * configuration — see invoices.ts on why that matters.
 */
import PDFDocument from "pdfkit";
import type { Invoice } from "@prisma/client";
import { invoiceAmount, invoiceDescription } from "./invoices.js";

const MARGIN = 50;
const INK = "#1a1620";
const MUTED = "#545b68";
const RULE = "#e3e6ec";

export function renderInvoicePdf(invoice: Invoice): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: MARGIN });
    const chunks: Buffer[] = [];

    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      draw(doc, invoice);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function draw(doc: PDFKit.PDFDocument, invoice: Invoice) {
  const right = doc.page.width - MARGIN;
  const width = right - MARGIN;

  // --- Header -----------------------------------------------------
  doc.fillColor(INK).fontSize(22).font("Helvetica-Bold").text("Tax Invoice", MARGIN, MARGIN);
  doc.font("Helvetica").fontSize(10).fillColor(MUTED);
  doc.text(invoice.number, MARGIN, MARGIN + 30);
  doc.text(`Issued ${formatDate(invoice.issuedAt)}`, MARGIN, MARGIN + 44);

  // --- Seller, top right ------------------------------------------
  const sellerTop = MARGIN;
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text(invoice.sellerName, MARGIN, sellerTop, {
    width,
    align: "right",
  });
  doc.font("Helvetica").fontSize(9).fillColor(MUTED);
  doc.text(invoice.sellerAddress, MARGIN, doc.y + 2, { width, align: "right" });
  if (invoice.sellerGstin) {
    doc.text(`GSTIN: ${invoice.sellerGstin}`, MARGIN, doc.y + 2, { width, align: "right" });
  }

  let y = Math.max(doc.y, MARGIN + 70) + 24;

  // --- Billed to ---------------------------------------------------
  doc.fillColor(MUTED).font("Helvetica").fontSize(9).text("BILLED TO", MARGIN, y);
  y = doc.y + 4;
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text(invoice.buyerName, MARGIN, y, { width: width * 0.6 });
  doc.font("Helvetica").fontSize(9).fillColor(MUTED);
  doc.text(invoice.buyerAddress || "", MARGIN, doc.y + 2, { width: width * 0.6 });
  if (invoice.buyerTaxId) {
    // Labelled by what it actually is where the customer is. "GSTIN" on
    // a German VAT number is wrong on the face of the document.
    const label = invoice.buyerCountry === "IN" ? "GSTIN" : "Tax ID";
    doc.text(`${label}: ${invoice.buyerTaxId}`, MARGIN, doc.y + 2, { width: width * 0.6 });
  }

  y = doc.y + 26;

  // --- Line items --------------------------------------------------
  doc.moveTo(MARGIN, y).lineTo(right, y).strokeColor(RULE).lineWidth(1).stroke();
  y += 10;

  doc.fillColor(MUTED).fontSize(9).font("Helvetica");
  doc.text("DESCRIPTION", MARGIN, y);
  doc.text("AMOUNT", MARGIN, y, { width, align: "right" });
  y += 18;

  doc.fillColor(INK).fontSize(10).font("Helvetica");
  doc.text(invoiceDescription(invoice), MARGIN, y, { width: width * 0.65 });
  doc.text(invoiceAmount(invoice.amountMinor, invoice.currency), MARGIN, y, { width, align: "right" });

  if (invoice.periodStart && invoice.periodEnd) {
    doc.fillColor(MUTED).fontSize(9);
    doc.text(
      `Billing period ${formatDate(invoice.periodStart)} – ${formatDate(invoice.periodEnd)}`,
      MARGIN,
      doc.y + 3,
      { width: width * 0.65 }
    );
  }

  y = doc.y + 14;
  doc.moveTo(MARGIN, y).lineTo(right, y).strokeColor(RULE).stroke();
  y += 12;

  // --- Totals ------------------------------------------------------
  // The tax line is shown even when it is zero. A blank where tax
  // belongs reads as an omission; an explicit zero next to the
  // zero-rating declaration below reads as the statement it is.
  const net = invoice.amountMinor - invoice.taxAmountMinor;
  row(doc, y, "Subtotal", invoiceAmount(net, invoice.currency), width);
  y += 16;
  row(
    doc,
    y,
    invoice.taxStatus === "india_gst" ? "GST (included)" : "Tax",
    invoiceAmount(invoice.taxAmountMinor, invoice.currency),
    width
  );
  y += 20;

  doc.fillColor(INK).font("Helvetica-Bold").fontSize(12);
  doc.text("Total paid", MARGIN, y);
  doc.text(invoiceAmount(invoice.amountMinor, invoice.currency), MARGIN, y, { width, align: "right" });

  y = doc.y + 28;

  // --- Declaration -------------------------------------------------
  if (invoice.taxNote) {
    doc.fillColor(MUTED).font("Helvetica").fontSize(9);
    doc.text(invoice.taxNote, MARGIN, y, { width });
    y = doc.y + 14;
  }

  doc.fillColor(MUTED).font("Helvetica").fontSize(8.5);
  doc.text(
    "Paid in full. This invoice is issued electronically and is valid without a signature.",
    MARGIN,
    y,
    { width }
  );
}

function row(doc: PDFKit.PDFDocument, y: number, label: string, value: string, width: number) {
  doc.fillColor(MUTED).font("Helvetica").fontSize(10);
  doc.text(label, MARGIN, y);
  doc.fillColor(INK).text(value, MARGIN, y, { width, align: "right" });
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
