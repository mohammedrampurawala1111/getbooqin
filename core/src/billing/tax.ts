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
export type TaxStatus = "india_gst" | "export_zero_rated" | "eu_no_vat_id";

/**
 * Whether an EU customer must produce a VAT number to buy.
 *
 * On by default, and the default is the safe one. Off accepts EU
 * customers who have no VAT number — small businesses below their own
 * registration threshold, and consumers — which is a commercial
 * decision with a tax consequence attached: a supply to a
 * non-taxable EU person is **not** covered by the reverse charge, and a
 * non-EU supplier has no de-minimis. The obligation is to register for
 * the non-Union OSS scheme and charge the customer's local rate, from
 * the first sale.
 *
 * Which this flag does not do for you. What it does is stop the product
 * *lying* about it: an EU sale with no VAT number gets its own status
 * and its own invoice line, rather than being labelled a reverse-charge
 * supply it is not.
 *
 * Read from BILLING_EU_REQUIRE_VAT at the edge and passed in, never
 * read here — this module has no imports and runs in the browser.
 */
export const DEFAULT_REQUIRE_EU_VAT_ID = true;

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
 * The position a specific sale is actually in, which the country alone
 * cannot answer once EU customers without a VAT number are allowed.
 *
 * The distinction that matters: an EU supply is a reverse-charge supply
 * *because the customer produced a VAT number*, not because they are in
 * the EU. Without one it is an ordinary taxable supply in their country
 * and the seller owes the VAT.
 */
export function statusFor(country: string, taxId: string | null | undefined): TaxStatus {
  const code = normalizeCountry(country);
  if (code === "IN") return "india_gst";
  if (isEuCountry(code) && !normalizeTaxId(taxId)) return "eu_no_vat_id";
  return "export_zero_rated";
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
 * A business tax number, anywhere in the world.
 *
 * This used to require an EU VAT shape — two letters then 2–12
 * alphanumerics — while being applied to **every** country outside
 * India, where a tax id is mandatory. The effect was that no business
 * in the United States, Canada, Australia, Singapore or Japan could
 * subscribe at all: a US EIN (`12-3456789`) normalises to `123456789`,
 * fails `[A-Z]{2}`, and the customer is told "that doesn't look like a
 * VAT or business tax number" with no way past it. USD is the largest
 * addressable segment and none of it could check out.
 *
 * So this is now a sanity check, not a format: 5–20 alphanumerics with
 * at least one digit. That accepts an EU VAT number, an EIN, an ABN, a
 * UEN, a Canadian BN, a Japanese corporate number — and still rejects
 * "n/a", "none", "-" and a stray word, which is all a shape check can
 * honestly claim to do.
 *
 * Shape only, deliberately. The authoritative check is VIES, which is
 * an external service that goes down, and blocking a sale on someone
 * else's uptime is the wrong trade. Capturing the number is what the
 * tax position rests on.
 */
export function looksLikeTaxId(value: string): boolean {
  const normalized = normalizeTaxId(value);
  return /^[0-9A-Z]{5,20}$/.test(normalized) && /[0-9]/.test(normalized);
}

/**
 * EU member states, for deciding whether the reverse charge is even
 * relevant. Wider than the eurozone list in plans.ts, which is about
 * which currency to bill in — Poland and Sweden are in the EU and
 * outside the euro, and the reverse charge applies to both.
 */
const EUROZONE_OR_EU: readonly string[] = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
  "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
  "SI", "ES", "SE",
];

/** True for a customer the EU reverse charge could apply to. */
export function isEuCountry(country: string): boolean {
  return EUROZONE_OR_EU.includes(normalizeCountry(country));
}

export function normalizeTaxId(value: string | null | undefined): string {
  return (value ?? "").replace(/[\s-]/g, "").trim().toUpperCase();
}

/**
 * Validates a customer-entered tax identity, returning problems rather
 * than throwing so a form can show them all at once.
 */
export function validateTaxIdentity(
  input: { country?: string | null; taxId?: string | null },
  opts: { requireEuVatId?: boolean } = {}
): {
  identity: TaxIdentity | null;
  problems: TaxIdentityProblem[];
} {
  const requireEuVatId = opts.requireEuVatId ?? DEFAULT_REQUIRE_EU_VAT_ID;
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
  } else if (isEuCountry(country) && requireEuVatId) {
    // Required here and nowhere else, because here it does something.
    //
    // An Indian entity supplying a digital service into the EU shifts
    // the VAT to the customer under the reverse charge — but only if
    // the customer is a taxable person, and the VAT number is the
    // evidence of that. Without one the supply looks like B2C, where
    // the *supplier* owes VAT at the customer's own local rate and has
    // to register to remit it. Collecting the number is what keeps the
    // simple position true, and is the whole of the plan's G2 decision:
    // B2B-only outside India, reverse charge, no OSS registration.
    if (!taxId) {
      problems.push({
        field: "taxId",
        message:
          "EU businesses account for VAT themselves under the reverse charge, so we need your VAT number. " +
          "We can't sell to EU consumers.",
      });
    } else if (!looksLikeTaxId(taxId)) {
      problems.push({ field: "taxId", message: "That doesn't look like a VAT number." });
    }
  } else {
    // Optional everywhere else, and it used to be demanded.
    //
    // For a customer in the US, Australia, the UAE or anywhere outside
    // the EU, this is a plain zero-rated export of services. There is
    // no reverse charge to evidence and frequently no such number to
    // give — a US company has an EIN, which is not a VAT number and has
    // nothing to do with an Indian export. Asking for it was friction
    // at the worst possible moment, in exchange for a field nobody
    // reads.
    //
    // Still validated when offered, since a merchant who types one
    // wants it on their invoice and a typo there is theirs to find now
    // rather than at their own year end.
    if (taxId && !looksLikeTaxId(taxId)) {
      problems.push({
        field: "taxId",
        message: "That doesn't look like a business tax number. Leave it blank if you don't have one.",
      });
    }
  }

  if (problems.length > 0) return { identity: null, problems };
  // Recomputed from what actually arrived rather than from the country
  // alone: with the EU requirement off, an EU sale with no VAT number
  // is a different position from one with, and the invoice has to say
  // which.
  return { identity: { country, taxId, status: statusFor(country, taxId) }, problems: [] };
}

/** The line an invoice or the Billing screen should carry. */
export function taxNote(status: TaxStatus | string, country: string): string {
  if (status === "india_gst") return "Indian GST applies. Prices include tax.";
  if (status === "eu_no_vat_id") {
    // Deliberately states no treatment it cannot support. It is not a
    // reverse-charge supply — no VAT number was given — and claiming so
    // on a document a customer may hand to their own accountant would
    // be worse than saying nothing. Whether VAT was charged is a
    // question of whether the seller has registered for OSS, which this
    // module has no way to know.
    return "Supplied to a customer in the EU without a VAT registration number.";
  }
  if (status === "export_zero_rated") {
    // The reverse-charge sentence is about EU VAT, so it belongs only on
    // an invoice going to the EU. Shown to a customer in the US,
    // Australia or the UAE it is noise; shown to a UK customer it has
    // been wrong since 2020.
    return EUROZONE_OR_EU.includes(country)
      ? "Zero-rated export of services. VAT is accounted for by you under the reverse charge."
      : "Zero-rated export of services.";
  }
  return "";
}

/* ------------------------------------------------------------------ */
/* Where the business is, from what we already know                    */
/* ------------------------------------------------------------------ */

/**
 * IANA timezone → ISO-3166 country, for the zones we plausibly serve.
 *
 * Exact matches only, and that is the whole design. This value decides
 * a **tax position** — `IN` means GST is charged, an EU country means
 * reverse charge and a VAT number is demanded, anything else is
 * zero-rated export — so a confident wrong answer here puts the wrong
 * tax treatment on a real invoice, which is worse than asking.
 *
 * A zone that is not in this table returns "" and the merchant picks
 * from the list themselves. That is the correct outcome for
 * `Europe/Busingen` and for anywhere else nobody has thought about:
 * the field is a select, pre-filling it is a convenience, and being
 * unhelpful is cheaper than being wrong.
 *
 * Deliberately not derived from currency. A merchant pricing in EUR
 * could be in any of twenty countries, and INR is the only currency
 * that implies its country — which the caller handles separately,
 * because that inference is about the *price list* rather than about
 * where the business is registered.
 */
const TIMEZONE_COUNTRY: Record<string, string> = {
  // India — the primary market, and the one where getting this wrong
  // means charging GST to someone who owes none, or the reverse.
  "Asia/Kolkata": "IN",
  "Asia/Calcutta": "IN",

  // Eurozone and the rest of the EU, where the answer decides whether a
  // VAT number is required at checkout.
  "Europe/Amsterdam": "NL", "Europe/Athens": "GR", "Europe/Berlin": "DE",
  "Europe/Bratislava": "SK", "Europe/Brussels": "BE", "Europe/Bucharest": "RO",
  "Europe/Budapest": "HU", "Europe/Copenhagen": "DK", "Europe/Dublin": "IE",
  "Europe/Helsinki": "FI", "Europe/Lisbon": "PT", "Europe/Ljubljana": "SI",
  "Europe/Luxembourg": "LU", "Europe/Madrid": "ES", "Europe/Malta": "MT",
  "Europe/Nicosia": "CY", "Europe/Paris": "FR", "Europe/Prague": "CZ",
  "Europe/Riga": "LV", "Europe/Rome": "IT", "Europe/Sofia": "BG",
  "Europe/Stockholm": "SE", "Europe/Tallinn": "EE", "Europe/Vienna": "AT",
  "Europe/Vilnius": "LT", "Europe/Warsaw": "PL", "Europe/Zagreb": "HR",

  // Outside the EU, where the position is simply zero-rated export.
  "Europe/London": "GB", "Europe/Zurich": "CH", "Europe/Oslo": "NO",
  "Asia/Dubai": "AE", "Asia/Singapore": "SG", "Asia/Tokyo": "JP",
  "Asia/Hong_Kong": "HK", "Asia/Karachi": "PK", "Asia/Dhaka": "BD",
  "Asia/Colombo": "LK", "Asia/Kathmandu": "NP",
  "Australia/Sydney": "AU", "Australia/Melbourne": "AU",
  "Australia/Brisbane": "AU", "Australia/Perth": "AU",
  "Pacific/Auckland": "NZ",
  "America/New_York": "US", "America/Chicago": "US", "America/Denver": "US",
  "America/Los_Angeles": "US", "America/Phoenix": "US", "America/Anchorage": "US",
  "America/Toronto": "CA", "America/Vancouver": "CA", "America/Edmonton": "CA",
  "America/Sao_Paulo": "BR", "America/Mexico_City": "MX",
  "Africa/Johannesburg": "ZA", "Africa/Lagos": "NG", "Africa/Nairobi": "KE",
};

/**
 * The country a merchant is most likely registered in, or "".
 *
 * Only ever a *default* for a field they can change — never the value
 * an invoice is issued against without them having seen it.
 */
export function countryFromTimezone(timezone: string | null | undefined): string {
  return TIMEZONE_COUNTRY[(timezone ?? "").trim()] ?? "";
}

/**
 * The EU requirement as this deployment has it configured.
 *
 * Server-only — `process.env` is meaningless in the browser bundle,
 * which is why every function above takes the answer as an argument
 * instead of reaching for it. A screen gets this through its loader.
 *
 * Off takes a deliberate "false": a typo, a blank, or an unset variable
 * all leave the safe behaviour in place, because the unsafe one carries
 * a registration obligation in twenty-seven countries.
 */
export function requireEuVatIdFromEnv(env: { BILLING_EU_REQUIRE_VAT?: string } = process.env): boolean {
  return (env.BILLING_EU_REQUIRE_VAT ?? "").trim().toLowerCase() !== "false";
}
