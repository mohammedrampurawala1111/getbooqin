/**
 * Turning a payment into an invoice in the customer's inbox.
 *
 * Split from invoices.ts so that *issuing* — the part with legal
 * consequences and a transaction around it — has no email code in it.
 * The invoice being recorded and the invoice being delivered are
 * different promises: the first must be exactly once, the second is
 * best-effort and retryable. Conflating them is how a failed SMTP
 * connection ends up rolling back a tax record.
 */
import prisma from "../db.js";
import type { Invoice } from "@prisma/client";
import { issueInvoice, invoiceFilename, invoiceAmount, type IssueInvoiceArgs } from "./invoices.js";
import { renderInvoicePdf } from "./invoicePdf.js";
import { sendInvoiceEmail } from "../booking/mailer.js";
import { isEmail } from "../booking/bookingsShared.js";
import { PLANS, type PlanId } from "./plans.js";

/**
 * Issue and send, in that order.
 *
 * Never throws. This is called from the webhook handler and from
 * reconciliation, and in both places the money has already moved — a
 * problem generating a PDF must not turn a correctly-applied payment
 * into a provider retry, because the retry would re-apply the payment
 * and still fail on the PDF.
 *
 * A recorded-but-unsent invoice is the safe failure: the row exists,
 * the number is allocated, it appears in the account's billing history
 * for download, and resending is a manual action away.
 */
export async function issueAndSendInvoice(args: IssueInvoiceArgs): Promise<Invoice | null> {
  let result;
  try {
    result = await issueInvoice(args);
  } catch (err) {
    console.error(`[getbooqin billing] could not issue an invoice for ${args.providerPaymentId}:`, err);
    return null;
  }

  if (!result.issued) {
    // "already invoiced" is the normal outcome of a webhook redelivery
    // and is not worth a warning; anything else is a configuration
    // problem somebody has to fix, so it says so plainly.
    if (result.reason === "already invoiced") return result.invoice ?? null;
    console.warn(`[getbooqin billing] no invoice issued for ${args.providerPaymentId} — ${result.reason}`);
    return null;
  }

  await deliverInvoice(result.invoice).catch((err) =>
    console.error(`[getbooqin billing] invoice ${result.invoice.number} was issued but not sent:`, err)
  );

  return result.invoice;
}

/** Renders and emails an invoice that already exists. Also the resend path. */
export async function deliverInvoice(invoice: Invoice): Promise<void> {
  if (!isEmail(invoice.buyerEmail)) {
    console.warn(`[getbooqin billing] invoice ${invoice.number} has no valid email to send to.`);
    return;
  }

  const connection = await prisma.connection.findUnique({ where: { id: invoice.connectionId } });
  if (!connection) return;

  const pdf = await renderInvoicePdf(invoice);
  const plan = PLANS[invoice.planId as PlanId];
  const amount = invoiceAmount(invoice.amountMinor, invoice.currency);

  await sendInvoiceEmail(
    connection,
    invoice.buyerEmail,
    `Your GetBooqin invoice ${invoice.number}`,
    `Hi,\n\n` +
      `Thanks — we've received your payment of ${amount} for the ${plan ? plan.name : invoice.planId} plan.\n\n` +
      `Your invoice ${invoice.number} is attached as a PDF, and every invoice on this account is also available ` +
      `under Settings → Billing whenever you need it again.\n\n` +
      `Nothing to do — your subscription continues as normal.\n\n` +
      `GetBooqin`,
    { filename: invoiceFilename(invoice), content: pdf }
  );

  console.log(`[getbooqin billing] invoice ${invoice.number} sent to ${invoice.buyerEmail}`);
}
