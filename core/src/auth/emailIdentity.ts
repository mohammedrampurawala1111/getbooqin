/**
 * One mailbox, many spellings.
 *
 * `info.scintillaweb@gmail.com` and `info.scintilla.web@gmail.com` are
 * the same inbox — Gmail ignores dots in the local part entirely, and
 * treats everything after a `+` as a label. So does every domain Google
 * hosts, which includes a large share of small businesses.
 *
 * Left alone, that is a free duplicate-account generator: the same
 * person signs up twice without meaning to, gets two trials, two
 * booking pages and two sets of bookings, and then asks why their
 * appointments are missing. It is also the cheapest trial-farming
 * technique there is.
 *
 * ## Only for comparison, never for sending
 *
 * The normalised form is a **key**, not an address. Mail goes to what
 * the merchant actually typed: they chose that spelling, it is what
 * appears in their own sent folder, and rewriting it would be us
 * deciding we know their address better than they do.
 *
 * ## Only where the rule is real
 *
 * Dots are significant at most providers. Stripping them everywhere
 * would merge `j.smith@company.com` and `jsmith@company.com`, which are
 * two different colleagues — a far worse failure than the one this
 * prevents, because it locks someone out of a product they never signed
 * up to. So the dot rule applies to Google-hosted domains only, and the
 * `+` rule applies broadly, being near-universal.
 */

/** Domains where Gmail's local-part rules apply. */
const GOOGLE_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * The comparison key for an address.
 *
 * Returns "" for anything that isn't shaped like an address, so a
 * caller cannot accidentally match two malformed values against each
 * other.
 */
export function emailKey(email: string): string {
  const trimmed = (email ?? "").trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return "";

  let local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (!domain.includes(".")) return "";

  // Sub-addressing. Near-universal — Gmail, Outlook, Fastmail, most
  // self-hosted setups — and the half of this that matters most, since
  // "+1", "+2" is what someone reaches for deliberately.
  const plus = local.indexOf("+");
  if (plus >= 0) local = local.slice(0, plus);

  if (GOOGLE_DOMAINS.has(domain)) {
    local = local.replace(/\./g, "");
    // googlemail.com is the same mailbox as gmail.com, historically
    // served to German users, and still resolves.
    return `${local}@gmail.com`;
  }

  return `${local}@${domain}`;
}

/** True when two addresses reach the same mailbox. */
export function sameMailbox(a: string, b: string): boolean {
  const keyA = emailKey(a);
  return keyA !== "" && keyA === emailKey(b);
}
