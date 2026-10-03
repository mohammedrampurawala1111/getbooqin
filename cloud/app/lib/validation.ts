// Loose E.164 check — country code optional, 7 to 15 digits, no letters.
// Deliberately permissive on formatting (spaces/dashes stripped before the
// test) rather than strict E.164 parsing: the job here is only to catch
// what the UX audit's V2 finding caught ("abcdefg" saving as a phone
// number), not to reject every real-world number a merchant might type.
const DIGITS_RE = /^\+?[1-9]\d{6,14}$/;

export function isValidPhone(value: string): boolean {
  const stripped = value.replace(/[\s()-]/g, "");
  return stripped.length === 0 || DIGITS_RE.test(stripped);
}

/**
 * The form the number is *stored* in: the same strip isValidPhone already
 * does to decide validity, so what passes validation is what lands in the
 * database.
 *
 * Without this, `+91 93257 05315` and `+919325705315` are two different
 * strings for one merchant — the same inconsistency PB-03 fixed for
 * customer phone numbers via core's normalizePhone(), which the merchant's
 * own number never got.
 *
 * Deliberately does NOT add a country code, unlike core's normalizePhone().
 * That function takes the business's configured default, and the one place
 * this is called from — signup, before any Connection exists — has no
 * business to ask. Guessing a country code onto someone's phone number is
 * worse than leaving it as they typed it.
 */
export function canonicalPhone(value: string): string {
  return value.replace(/[\s()-]/g, "").trim();
}

// For <input pattern>, which matches against the raw (unstripped) value —
// allow the same separators inline rather than asking the browser to strip
// them first. Both ( ) and the trailing - must be escaped: browsers compile
// <input pattern> with the regex "v" flag, which is stricter about
// character-class contents than a normal /.../ literal — unescaped parens
// are a syntax error there, and (unlike outside v-mode, where a trailing -
// is safely literal) a bare trailing - is one too. Verified directly with
// `new RegExp(PHONE_PATTERN, "v")` — that throw was crashing the phone
// field on every page that renders it (onboarding, signup, settings,
// account).
export const PHONE_PATTERN = "^\\+?[0-9][0-9\\s\\(\\)\\-]{6,18}$";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

/**
 * Shared client/server validation for the public booking form, the
 * Add-consultation dialog and the staff Add-client dialog — all three
 * relied entirely on native HTML5 validation, which shows a transient
 * tooltip and leaves no persistent message for a screen-reader user or
 * anyone reading slowly (Defect Dossier's BQ-24 finding). Framework-free so
 * it runs identically in a browser onSubmit handler and in a route action.
 *
 * `requireEmail` defaults true — email was unconditionally required before
 * Settings > Booking rules gained a matching toggle (GetBooqin clinic
 * audit's PB-03 finding: a walk-in patient with no email address couldn't
 * book online at all), so every existing call site keeps its old behavior
 * until it's updated to pass the real setting. When both email and phone
 * are optional, at least one must still be given — a booking nobody can be
 * reached about isn't a state any of these forms should allow.
 */
export function contactFieldErrors(
  fields: { first_name: string; email: string; phone: string },
  requirePhone: boolean,
  requireEmail = true
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!fields.first_name.trim()) errors.first_name = "Enter a first name.";
  if (requireEmail && !fields.email.trim()) errors.email = "Enter an email address.";
  else if (fields.email.trim() && !isValidEmail(fields.email)) errors.email = "Enter a valid email address.";
  if (requirePhone && !fields.phone.trim()) errors.phone = "Enter a phone number.";
  else if (fields.phone.trim() && !isValidPhone(fields.phone)) errors.phone = "Enter a valid phone number.";
  if (!requireEmail && !requirePhone && !fields.email.trim() && !fields.phone.trim() && !errors.email && !errors.phone) {
    errors.phone = "Enter a phone number or email address so we can reach you.";
  }
  return errors;
}
