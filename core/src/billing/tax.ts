/**
 * Tax identity, for an Indian seller selling worldwide.
 *
 * There are exactly two positions, and the customer's country decides
 * which one applies:
 *
 * **India → GST.** A domestic supply. Indian GST applies at the SaaS
 * rate. A business customer's GSTIN is worth capturing so they can claim
 * input credit, but an unregistered customer is perfectly normal and
 * must not be blocked.
 *
 * **Everywhere else → zero-rated export.** Export of services is
 * zero-rated under Indian GST. For an EU business customer the reverse
 * charge then makes the VAT theirs to account for, not ours — which is
 * the whole reason a **business tax id is required** outside India: it
 * is the evidence that this is B2B. Sell to an EU *consumer* and you are
 * a non-EU supplier of electronically supplied services, which triggers
 * non-Union OSS registration from the very first euro, with no
 * threshold. Requiring the id is what keeps that door shut.
 *
 * ⚠️ Two things this file does not do, and an accountant should:
 *   - Exporting zero-rated normally requires a **Letter of Undertaking**
 *     filed with the GST department; without one you pay IGST and claim
 *     it back.
 *   - Prices are treated as tax-inclusive (see the terms). Splitting GST
 *     out on an invoice line is a real invoicing requirement and is not
 *     implemented here.
 */
export type TaxStatus = "india_gst" | "export_zero_rated";

export interface TaxIdentity {
  country: string;
  taxId: string;
  status: TaxStatus;
}

export interface TaxIdentityProblem {
  field: "country" | "taxId";
  message: string;
}

/** ISO-3166 alpha-2, uppercased. Empty for anything that isn't two letters. */
export function normalizeCountry(value: string | null | undefined): string {
  const code = (value ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : "";
}

export function statusForCountry(country: string): TaxStatus {
  return normalizeCountry(country) === "IN" ? "india_gst" : "export_zero_rated";
}

/**
 * A GSTIN is 15 characters: 2 state digits, a 10-character PAN, an
 * entity digit, a 'Z', and a checksum. Checked by shape only — the
 * checksum needs the official algorithm and the authoritative answer is
 * the GST portal, not a regex. A wrong-but-well-formed number is the
 * customer's to correct; a nonsense one is worth catching at the door.
 */
export function looksLikeGstin(value: string): boolean {
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(value.trim().toUpperCase());
}

/**
 * EU VAT numbers are a country prefix plus 2–12 alphanumerics. Again
 * shape only: the authoritative check is VIES, which is an external
 * service that goes down, and blocking a sale on someone else's uptime
 * is the wrong trade. Capturing the number is what the tax position
 * rests on; verifying it is a reconciliation job, not a checkout gate.
 */
export function looksLikeTaxId(value: string): boolean {
  return /^[A-Z]{2}[0-9A-Z]{2,12}$/.test(value.replace(/[\s-]/g, "").trim().toUpperCase());
}

export function normalizeTaxId(value: string | null | undefined): string {
  return (value ?? "").replace(/[\s-]/g, "").trim().toUpperCase();
}

/**
 * Validates a customer-entered tax identity, returning problems rather
 * than throwing so a form can show them all at once.
 */
export function validateTaxIdentity(input: { country?: string | null; taxId?: string | null }): {
  identity: TaxIdentity | null;
  problems: TaxIdentityProblem[];
} {
  const problems: TaxIdentityProblem[] = [];
  const country = normalizeCountry(input.country);
  const taxId = normalizeTaxId(input.taxId);

  if (!country) {
    problems.push({ field: "country", message: "Choose the country your business is registered in." });
    return { identity: null, problems };
  }

  const status = statusForCountry(country);

  if (status === "india_gst") {
    // Optional: plenty of legitimate Indian customers are below the
    // registration threshold and have no GSTIN at all.
    if (taxId && !looksLikeGstin(taxId)) {
      problems.push({ field: "taxId", message: "That doesn't look like a GSTIN. Leave it blank if you aren't registered." });
    }
  } else {
    if (!taxId) {
      problems.push({
        field: "taxId",
        message: "We sell to registered businesses outside India. Enter your VAT or business tax number to continue.",
      });
    } else if (!looksLikeTaxId(taxId)) {
      problems.push({ field: "taxId", message: "That doesn't look like a VAT or business tax number." });
    }
  }

  if (problems.length > 0) return { identity: null, problems };
  return { identity: { country, taxId, status }, problems: [] };
}

/** The line an invoice or the Billing screen should carry. */
export function taxNote(status: TaxStatus | string, country: string): string {
  if (status === "india_gst") return "Indian GST applies. Prices include tax.";
  if (status === "export_zero_rated") {
    return country && country !== "IN"
      ? "Zero-rated export of services. If you're in the EU, VAT is accounted for by you under the reverse charge."
      : "Zero-rated export of services.";
  }
  return "";
}
