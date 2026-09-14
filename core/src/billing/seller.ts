/**
 * Who is issuing the invoice.
 *
 * Configuration, not code, because these are facts about a company that
 * change without a deploy — an address, a GSTIN, the arrival of a
 * Letter of Undertaking. They are snapshotted onto every Invoice row at
 * issue, so changing them here never rewrites an invoice already sent.
 *
 * **This fails closed.** If the legal name or address is missing,
 * `sellerIdentity()` returns null and no invoice is issued at all. That
 * is deliberate and it is the whole point of this file: an invoice
 * carrying a placeholder name, or a blank where a GSTIN belongs, is not
 * a weaker invoice — it is an invalid tax document that has been
 * emailed to a customer and filed by their accountant. Sending nothing
 * is recoverable; sending that is not.
 */

export interface SellerIdentity {
  legalName: string;
  address: string;
  /** Empty is legitimate — a business below the registration threshold has none. */
  gstin: string;
  country: string;
  /** Prefix for the invoice series, e.g. "GB" -> "GB/2026-27/0001". */
  seriesPrefix: string;
  /**
   * Is a Letter of Undertaking on file?
   *
   * It decides what an export invoice may say. With an LUT, services
   * exported from India go out under bond with **no IGST charged**;
   * without one, IGST is payable and reclaimed later. Getting this
   * wrong in the customer's favour means we owe the tax.
   */
  lutOnFile: boolean;
  /** Optional, printed under the address when set. */
  email: string;
}

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

/**
 * The configured seller, or null when there isn't enough to issue a
 * valid invoice. Callers must treat null as "do not invoice", never as
 * "use defaults".
 */
export function sellerIdentity(): SellerIdentity | null {
  const legalName = env("INVOICE_LEGAL_NAME");
  const address = env("INVOICE_ADDRESS");

  // Name and address are the two a tax invoice cannot be without. A
  // GSTIN can legitimately be absent; a nameless invoice cannot.
  if (!legalName || !address) return null;

  return {
    legalName,
    address: address.replace(/\\n/g, "\n"),
    gstin: env("INVOICE_GSTIN"),
    country: env("INVOICE_COUNTRY") || "IN",
    seriesPrefix: env("INVOICE_SERIES_PREFIX") || "GB",
    lutOnFile: env("INVOICE_LUT_ON_FILE") === "true",
    email: env("INVOICE_CONTACT_EMAIL") || env("MAIL_FROM_EMAIL"),
  };
}

/** Why invoicing is off, for a log line or the admin console. */
export function sellerConfigProblem(): string | null {
  if (sellerIdentity()) return null;
  const missing = ["INVOICE_LEGAL_NAME", "INVOICE_ADDRESS"].filter((k) => !env(k));
  return `Invoicing is disabled: ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set.`;
}

/**
 * The Indian financial year a date falls in, as a series suffix.
 *
 * April to March, not January to December — the invoice series has to
 * restart with the financial year, and using the calendar year would
 * produce a numbering run that no Indian auditor recognises.
 */
export function financialYear(date: Date): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth(); // 0 = January
  const startYear = month >= 3 ? year : year - 1; // 3 = April
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/** e.g. "GB/2026-27". */
export function seriesFor(seller: SellerIdentity, date: Date): string {
  return `${seller.seriesPrefix}/${financialYear(date)}`;
}
