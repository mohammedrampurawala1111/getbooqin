// Lightweight region → currency lookup so onboarding can default the
// currency the same way it already defaults the timezone — from the
// browser's own locale, not a hardcoded USD. A detected Europe/Amsterdam
// timezone next to a USD default disagreed about where the business was
// (UX audit's N6 finding), and a merchant who didn't notice would price
// every service in the wrong currency. Intl has no direct locale→currency
// API, so this is a small curated map of the regions likely to sign up —
// it only sets the initial value; General settings can still override it.
const REGION_CURRENCY: Record<string, { code: string; symbol: string }> = {
  US: { code: "USD", symbol: "$" },
  CA: { code: "CAD", symbol: "$" },
  MX: { code: "MXN", symbol: "$" },
  GB: { code: "GBP", symbol: "£" },
  IE: { code: "EUR", symbol: "€" },
  DE: { code: "EUR", symbol: "€" },
  FR: { code: "EUR", symbol: "€" },
  ES: { code: "EUR", symbol: "€" },
  IT: { code: "EUR", symbol: "€" },
  NL: { code: "EUR", symbol: "€" },
  BE: { code: "EUR", symbol: "€" },
  PT: { code: "EUR", symbol: "€" },
  AT: { code: "EUR", symbol: "€" },
  FI: { code: "EUR", symbol: "€" },
  GR: { code: "EUR", symbol: "€" },
  AU: { code: "AUD", symbol: "$" },
  NZ: { code: "NZD", symbol: "$" },
  IN: { code: "INR", symbol: "₹" },
  JP: { code: "JPY", symbol: "¥" },
  CN: { code: "CNY", symbol: "¥" },
  CH: { code: "CHF", symbol: "CHF" },
  SE: { code: "SEK", symbol: "kr" },
  NO: { code: "NOK", symbol: "kr" },
  DK: { code: "DKK", symbol: "kr" },
  PL: { code: "PLN", symbol: "zł" },
  BR: { code: "BRL", symbol: "R$" },
  ZA: { code: "ZAR", symbol: "R" },
  AE: { code: "AED", symbol: "AED" },
  SG: { code: "SGD", symbol: "$" },
  HK: { code: "HKD", symbol: "$" },
};

// IANA zone → currency, for the same reason the region map above isn't
// enough on its own: timezone and browser language are independent
// settings. A browser can report the Europe/Amsterdam zone (geography) with
// an en-US language pack installed (a UI preference) — exactly the
// combination the audit hit, where deriving currency from *locale* still
// landed on USD next to a timezone the app had already correctly detected
// as Amsterdam. Timezone is the more reliable of the two signals here
// because it's geographic by construction; this only needs one representative
// zone per country since IANA already canonicalizes the rest as aliases.
const TIMEZONE_CURRENCY: Record<string, { code: string; symbol: string }> = {
  "America/New_York": { code: "USD", symbol: "$" }, "America/Chicago": { code: "USD", symbol: "$" },
  "America/Denver": { code: "USD", symbol: "$" }, "America/Los_Angeles": { code: "USD", symbol: "$" },
  "America/Anchorage": { code: "USD", symbol: "$" }, "Pacific/Honolulu": { code: "USD", symbol: "$" },
  "America/Toronto": { code: "CAD", symbol: "$" }, "America/Vancouver": { code: "CAD", symbol: "$" },
  "America/Mexico_City": { code: "MXN", symbol: "$" },
  "Europe/London": { code: "GBP", symbol: "£" },
  "Europe/Dublin": { code: "EUR", symbol: "€" }, "Europe/Berlin": { code: "EUR", symbol: "€" },
  "Europe/Paris": { code: "EUR", symbol: "€" }, "Europe/Madrid": { code: "EUR", symbol: "€" },
  "Europe/Rome": { code: "EUR", symbol: "€" }, "Europe/Amsterdam": { code: "EUR", symbol: "€" },
  "Europe/Brussels": { code: "EUR", symbol: "€" }, "Europe/Lisbon": { code: "EUR", symbol: "€" },
  "Europe/Vienna": { code: "EUR", symbol: "€" }, "Europe/Helsinki": { code: "EUR", symbol: "€" },
  "Europe/Athens": { code: "EUR", symbol: "€" },
  "Australia/Sydney": { code: "AUD", symbol: "$" }, "Australia/Melbourne": { code: "AUD", symbol: "$" },
  "Australia/Perth": { code: "AUD", symbol: "$" },
  "Pacific/Auckland": { code: "NZD", symbol: "$" },
  "Asia/Kolkata": { code: "INR", symbol: "₹" }, "Asia/Calcutta": { code: "INR", symbol: "₹" },
  "Asia/Tokyo": { code: "JPY", symbol: "¥" }, "Asia/Shanghai": { code: "CNY", symbol: "¥" },
  "Europe/Zurich": { code: "CHF", symbol: "CHF" },
  "Europe/Stockholm": { code: "SEK", symbol: "kr" }, "Europe/Oslo": { code: "NOK", symbol: "kr" },
  "Europe/Copenhagen": { code: "DKK", symbol: "kr" }, "Europe/Warsaw": { code: "PLN", symbol: "zł" },
  "America/Sao_Paulo": { code: "BRL", symbol: "R$" },
  "Africa/Johannesburg": { code: "ZAR", symbol: "R" },
  "Asia/Dubai": { code: "AED", symbol: "AED" },
  "Asia/Singapore": { code: "SGD", symbol: "$" },
  "Asia/Hong_Kong": { code: "HKD", symbol: "$" },
};

const DEFAULT_CURRENCY = { code: "USD", symbol: "$" };

export function guessCurrency(timezone?: string): { code: string; symbol: string } {
  const tz = timezone ?? (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "");
  if (tz && TIMEZONE_CURRENCY[tz]) return TIMEZONE_CURRENCY[tz];
  if (typeof Intl === "undefined") return DEFAULT_CURRENCY;
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    const region = new Intl.Locale(locale).maximize().region;
    return (region && REGION_CURRENCY[region]) || DEFAULT_CURRENCY;
  } catch {
    return DEFAULT_CURRENCY;
  }
}

export const CURRENCIES: { code: string; symbol: string; label: string }[] = [
  { code: "USD", symbol: "$", label: "US Dollar (USD)" },
  { code: "EUR", symbol: "€", label: "Euro (EUR)" },
  { code: "GBP", symbol: "£", label: "British Pound (GBP)" },
  { code: "CAD", symbol: "$", label: "Canadian Dollar (CAD)" },
  { code: "AUD", symbol: "$", label: "Australian Dollar (AUD)" },
  { code: "NZD", symbol: "$", label: "New Zealand Dollar (NZD)" },
  { code: "INR", symbol: "₹", label: "Indian Rupee (INR)" },
  { code: "JPY", symbol: "¥", label: "Japanese Yen (JPY)" },
  { code: "CNY", symbol: "¥", label: "Chinese Yuan (CNY)" },
  { code: "CHF", symbol: "CHF", label: "Swiss Franc (CHF)" },
  { code: "SEK", symbol: "kr", label: "Swedish Krona (SEK)" },
  { code: "NOK", symbol: "kr", label: "Norwegian Krone (NOK)" },
  { code: "DKK", symbol: "kr", label: "Danish Krone (DKK)" },
  { code: "PLN", symbol: "zł", label: "Polish Złoty (PLN)" },
  { code: "BRL", symbol: "R$", label: "Brazilian Real (BRL)" },
  { code: "MXN", symbol: "$", label: "Mexican Peso (MXN)" },
  { code: "ZAR", symbol: "R", label: "South African Rand (ZAR)" },
  { code: "AED", symbol: "AED", label: "UAE Dirham (AED)" },
  { code: "SGD", symbol: "$", label: "Singapore Dollar (SGD)" },
  { code: "HKD", symbol: "$", label: "Hong Kong Dollar (HKD)" },
];
