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
// them first. Both ( ) and the trailing - must be escaped: browsers compile
// <input pattern> with the regex "v" flag, which is stricter about
// character-class contents than a normal /.../ literal — unescaped parens
// are a syntax error there, and (unlike outside v-mode, where a trailing -
// is safely literal) a bare trailing - is one too. Verified directly with
// `new RegExp(PHONE_PATTERN, "v")` — that throw was crashing the phone
// field on every page that renders it (onboarding, signup, settings,
// account).
export const PHONE_PATTERN = "^\\+?[0-9][0-9\\s\\(\\)\\-]{6,18}$";
