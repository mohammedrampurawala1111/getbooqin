/**
 * Issuing a tax invoice for a payment that has been taken.
 *
 * Neither Razorpay nor PayPal does this for us in a form we can use.
 * Razorpay *does* create an invoice object per charge, but it carries
 * no buyer name, no address, no tax line and none of the declarations
 * an Indian exporter has to make — and it cannot be emailed at all
 * unless the customer record has an address on it. So the document the
 * customer actually receives is ours to produce.
 *
 * ## Three rules this file exists to enforce
 *
 * **Issued once per payment.** `Invoice.providerPaymentId` is unique,
 * and that index — not a check in this code — is what guarantees it. A
 * webhook redelivery, a reconciliation running beside it and a manual
 * replay all try to insert the same payment id; exactly one wins and
 * the rest are told the invoice already exists.
 *
 * **Frozen at issue.** Every field, our own name and GSTIN included, is
 * copied onto the row. An invoice is a legal document that must keep
 * saying what it said; re-rendering from live configuration would
 * quietly rewrite history the first time the company moves office.
 *
 * **Never invented.** If the seller is not configured, or the buyer has
 * no name and address, nothing is issued and the reason is logged. A
 * document with a placeholder GSTIN is not a weaker invoice — it is an
 * invalid one that has been emailed to a customer and filed by their
 * accountant.
 */
import prisma from "../db.js";
import type { Invoice } from "@prisma/client";
import { nextInvoiceNumber } from "./invoiceNumber.js";
import { sellerIdentity, seriesFor, sellerConfigProblem, type SellerIdentity } from "./seller.js";
import { taxNote, isEuCountry, type TaxStatus } from "./tax.js";
import { MINOR_UNITS, PLANS, type BillingCycle, type Currency, type PlanId } from "./plans.js";

/**
 * Indian GST on a domestic sale of software services. Configurable
 * because a rate is a thing a government changes, not a constant.
 */
function gstRate(): number {
  const raw = Number(process.env.INVOICE_GST_RATE);
  return Number.isFinite(raw) && raw >= 0 ? raw : 18;
}

/**
 * The tax component of a gross amount.
 *
 * Indian prices are quoted **inclusive** of GST (see tax.ts's note), so
 * this backs the tax out of the total rather than adding to it —
 * 18% of a ₹999 price is ₹152.39, not ₹179.82. Getting this backwards
 * overstates the tax collected on every invoice in the series.
 *
 * An export is zero-rated, so there is nothing to back out.
 */
export function taxComponent(amountMinor: number, status: TaxStatus | string): number {
  if (status !== "india_gst") return 0;
  const rate = gstRate();
  return Math.round((amountMinor * rate) / (100 + rate));
}

export interface IssueInvoiceArgs {
  connectionId: string;
  provider: string;
  /** The payment being invoiced. Its uniqueness is the idempotency guard. */
  providerPaymentId: string;
  providerInvoiceId?: string | null;
  /** Minor units, as the provider reports them. */
  amountMinor: number;
  currency: Currency;
  plan: PlanId;
  cycle: BillingCycle;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  issuedAt?: Date;
}

export type IssueResult =
  | { issued: true; invoice: Invoice }
  | { issued: false; reason: string; invoice?: Invoice };

/**
 * Creates the invoice for a payment, or explains why it didn't.
 *
 * Returns rather than throws for every ordinary refusal. This runs
 * inside a webhook handler, and a missing GSTIN must not turn a
 * correctly-applied payment event into a 500 and a provider retry —
 * the money moving is the part that has to be right.
 */
export async function issueInvoice(args: IssueInvoiceArgs): Promise<IssueResult> {
  const existing = await prisma.invoice.findUnique({ where: { providerPaymentId: args.providerPaymentId } });
  if (existing) return { issued: false, reason: "already invoiced", invoice: existing };

  const seller = sellerIdentity();
  if (!seller) return { issued: false, reason: sellerConfigProblem() ?? "seller is not configured" };

  const subscription = await prisma.subscription.findUnique({
    where: { connectionId: args.connectionId },
    include: { connection: { include: { user: { select: { email: true } } } } },
  });
  if (!subscription) return { issued: false, reason: "no subscription row" };

  const buyerName = subscription.billingName.trim();
  const buyerAddress = subscription.billingAddress.trim();
  if (!buyerName || !buyerAddress) {
    // Deliberately not falling back to the shop's trading name. An
    // invoice has to name the entity being billed, and a tax invoice
    // has to carry its address; inventing either produces a document
    // that looks right and isn't.
    return { issued: false, reason: "the account has no billing name or address on file" };
  }

  const issuedAt = args.issuedAt ?? new Date();
  const status = subscription.taxStatus || "export_zero_rated";

  try {
    const invoice = await prisma.$transaction(async (tx) => {
      // Allocated inside the transaction so the number and the row that
      // uses it commit together — a number handed out and then not used
      // is a gap in a series that must be consecutive.
      const number = await nextInvoiceNumber(seriesFor(seller, issuedAt), tx);

      return tx.invoice.create({
        data: {
          connectionId: args.connectionId,
          number,
          series: seriesFor(seller, issuedAt),
          issuedAt,

          sellerName: seller.legalName,
          sellerAddress: seller.address,
          sellerGstin: seller.gstin,
          sellerCountry: seller.country,

          buyerName,
          buyerAddress,
          buyerEmail: subscription.connection.user.email,
          buyerTaxId: subscription.taxId,
          buyerCountry: subscription.taxCountry,

          taxStatus: status,
          taxNote: invoiceDeclaration(status, subscription.taxCountry, seller),

          currency: args.currency,
          amountMinor: args.amountMinor,
          taxAmountMinor: taxComponent(args.amountMinor, status),

          planId: args.plan,
          billingCycle: args.cycle,
          periodStart: args.periodStart ?? null,
          periodEnd: args.periodEnd ?? null,

          provider: args.provider,
          providerPaymentId: args.providerPaymentId,
          providerInvoiceId: args.providerInvoiceId ?? null,
        },
      });
    });

    return { issued: true, invoice };
  } catch (err) {
    // The unique index did its job — something else invoiced this
    // payment between our check above and this insert.
    if ((err as { code?: string }).code === "P2002") {
      const raced = await prisma.invoice.findUnique({ where: { providerPaymentId: args.providerPaymentId } });
      return { issued: false, reason: "already invoiced", invoice: raced ?? undefined };
    }
    throw err;
  }
}

/**
 * The declaration the invoice carries.
 *
 * Richer than `taxNote()`, which writes the one-liner for the Billing
 * screen. An export invoice has to state *which* basis it goes out on:
 * with a Letter of Undertaking, services leave India under bond with no
 * IGST charged; without one, IGST is payable. Claiming the LUT basis
 * when there is no LUT means we owe the tax.
 */
export function invoiceDeclaration(status: TaxStatus | string, country: string, seller: SellerIdentity): string {
  if (status === "india_gst") {
    return `Supply of services within India. GST @ ${gstRate()}% is included in the amount shown.`;
  }
  if (status === "export_zero_rated") {
    const basis = seller.lutOnFile
      ? "Supply meant for export of services under Letter of Undertaking without payment of integrated tax."
      : "Export of services. Zero-rated supply under the IGST Act.";
    // Only for an EU customer. Every non-Indian invoice used to carry
    // this sentence, so a practice in Texas received a paragraph about
    // EU VAT on their invoice.
    const reverse = isEuCountry(country)
      ? " Where the recipient is registered for VAT in the EU, VAT is accounted for by the recipient under the reverse charge."
      : "";
    return basis + reverse;
  }
  return taxNote(status, country);
}

/** One account's invoices, newest first. */
export function listInvoices(connectionId: string, limit = 50) {
  return prisma.invoice.findMany({
    where: { connectionId },
    orderBy: { issuedAt: "desc" },
    take: limit,
  });
}

/** One invoice, scoped to its account so an id from elsewhere can't be fetched. */
export function getInvoice(connectionId: string, id: string) {
  return prisma.invoice.findFirst({ where: { id, connectionId } });
}

/** A filename an accountant can find again: GB/2026-27/0001 -> GB-2026-27-0001.pdf */
export function invoiceFilename(invoice: Pick<Invoice, "number">): string {
  return `${invoice.number.replace(/[^A-Za-z0-9]+/g, "-")}.pdf`;
}

/** What the line item says. */
export function invoiceDescription(invoice: Pick<Invoice, "planId" | "billingCycle">): string {
  const plan = PLANS[invoice.planId as PlanId];
  const cycle = invoice.billingCycle === "yearly" ? "annual" : "monthly";
  return `GetBooqin ${plan ? plan.name : invoice.planId} plan — ${cycle} subscription`;
}

/**
 * Money on an invoice, always with its decimals.
 *
 * Not `formatPrice()`, which drops the fractional part for a round
 * number — right for a pricing page ("€5/mo" reads better than
 * "€5.00/mo"), wrong here. An invoice has to show exact amounts: the
 * GST backed out of ₹999 is ₹152.39, and rendering that as "₹152"
 * produces a document whose subtotal and tax do not add up to its
 * total. That is the first thing anyone checking an invoice does.
 */
export function invoiceAmount(minor: number, currency: string): string {
  const code = currency as Currency;
  const major = minor / (MINOR_UNITS[code] ?? 100);
  return new Intl.NumberFormat(code === "INR" ? "en-IN" : "en-US", {
    style: "currency",
    currency: code,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(major);
}
