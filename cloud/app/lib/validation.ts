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

// For <input pattern>, which matches against the raw (unstripped) value —
// allow the same separators inline rather than asking the browser to strip
// them first.
export const PHONE_PATTERN = "^\\+?[0-9][0-9\\s()-]{6,18}$";
