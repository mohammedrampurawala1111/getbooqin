/**
 * The five messages GetBooqin sends over WhatsApp, and their exact
 * shape at Meta.
 *
 * ## Why this is a catalogue and not a settings page
 *
 * Email templates are free text a merchant edits and we render. WhatsApp
 * templates are not: every proactive message must be **registered with
 * Meta and approved by a human reviewer**, per WhatsApp Business
 * Account, before it can be sent once. Approval takes minutes to days,
 * a rejected template has to be resubmitted, and the body cannot be
 * changed at send time — only the numbered variables can.
 *
 * So the merchant does not write these. We define them, submit them to
 * each merchant's WABA at connect time, and track what Meta said. That
 * is also why the list is short: five approvals per merchant is already
 * a lot of surface to keep green, and each extra one is another thing
 * that can sit in PENDING on the day it is needed.
 *
 * ## Zero imports
 *
 * Same contract as plans.ts and settingsShared.ts: this is safe to pull
 * into the browser bundle, so the Settings screen can render exactly
 * the copy that will be submitted rather than an approximation of it.
 *
 * ## UTILITY, not MARKETING
 *
 * Every template here is transactional — it follows from something the
 * customer themselves did. That is what makes it UTILITY, which matters
 * for three reasons: it is what Meta will approve, it is cheaper for the
 * merchant than MARKETING, and it is free entirely when it lands inside
 * a customer service window the customer opened. A reminder categorised
 * as MARKETING would be rejected, and rightly.
 *
 * ## Variables are positional and that is a trap
 *
 * Meta's template variables are `{{1}}`, `{{2}}` — position, not name.
 * Reordering `variables` below without resubmitting the template puts
 * the time where the service name should be, silently, in a message a
 * customer receives. So the array is the contract: append, never
 * reorder, and treat a change as a new template.
 */

export type TemplateCategory = "UTILITY";

/** Our own key for a template. Not Meta's name — see `metaName()`. */
export type WhatsAppTemplateKey =
  | "booking_confirmed"
  | "booking_reminder"
  | "booking_cancelled"
  | "booking_rescheduled"
  | "waitlist_offered";

/**
 * The tokens a template body can interpolate, in the order Meta will
 * see them. Names are ours; Meta only ever sees `{{1}}`…`{{n}}`.
 */
export type TemplateVariable =
  | "customer_name"
  | "business_name"
  | "service"
  | "date"
  | "time"
  | "resource"
  | "manage_url"
  | "claim_url"
  | "expires_at";

export interface WhatsAppTemplateDef {
  key: WhatsAppTemplateKey;
  /** Shown on the Settings screen. */
  label: string;
  /** What triggers it, in the merchant's terms. */
  description: string;
  category: TemplateCategory;
  /**
   * The body exactly as submitted, with `{{1}}`-style placeholders.
   * Kept as the literal string rather than assembled, because what is
   * approved is characters — a template whose body differs from what
   * Meta approved by so much as a newline is a different template.
   */
  body: string;
  /**
   * Positional. Index 0 fills `{{1}}`. **Append only** — reordering
   * this without resubmitting silently swaps values in a live message.
   */
  variables: TemplateVariable[];
  /**
   * A URL button, when the message is actionable. WhatsApp renders
   * these far better than a link in the body, and a dynamic URL button
   * takes its own suffix variable.
   */
  button?: { text: string; urlVariable: Extract<TemplateVariable, "manage_url" | "claim_url"> };
}

/**
 * Meta's name for one of our templates.
 *
 * Lowercase with underscores is Meta's requirement. The `getbooqin_`
 * prefix is ours, and it is load-bearing: these are registered inside
 * the *merchant's* WABA alongside whatever else they have created
 * there, and a template called `booking_reminder` would collide with a
 * merchant who made their own.
 */
export function metaName(key: WhatsAppTemplateKey): string {
  return `getbooqin_${key}`;
}

/** The catalogue key a Meta template name refers to, or null if it isn't ours. */
export function keyFromMetaName(name: string): WhatsAppTemplateKey | null {
  const key = name.startsWith("getbooqin_") ? name.slice("getbooqin_".length) : null;
  return key && TEMPLATE_KEYS.includes(key as WhatsAppTemplateKey) ? (key as WhatsAppTemplateKey) : null;
}

export const WHATSAPP_TEMPLATES: WhatsAppTemplateDef[] = [
  {
    key: "booking_confirmed",
    label: "Booking confirmed",
    description: "Sent the moment a booking is confirmed.",
    category: "UTILITY",
    body:
      "Hi {{1}}, your booking with {{2}} is confirmed.\n\n" +
      "{{3}}\n{{4}} at {{5}}\nWith {{6}}\n\n" +
      "See you then!",
    variables: ["customer_name", "business_name", "service", "date", "time", "resource"],
    button: { text: "Manage booking", urlVariable: "manage_url" },
  },
  {
    key: "booking_reminder",
    label: "Reminder",
    description: "Sent ahead of the appointment, on the same schedule as the email reminder.",
    category: "UTILITY",
    body:
      "Hi {{1}}, a reminder of your booking with {{2}}.\n\n" +
      "{{3}}\n{{4}} at {{5}}\nWith {{6}}\n\n" +
      "See you soon!",
    variables: ["customer_name", "business_name", "service", "date", "time", "resource"],
    button: { text: "Manage booking", urlVariable: "manage_url" },
  },
  {
    key: "booking_cancelled",
    label: "Cancelled",
    description: "Sent when a booking is cancelled, by either side.",
    category: "UTILITY",
    body:
      "Hi {{1}}, your booking with {{2}} on {{4}} at {{5}} has been cancelled.\n\n" +
      "{{3}}\n\n" +
      "You can book another time whenever suits you.",
    // Positions still run 1..5 in variable order even though the body
    // reads them out of sequence — Meta numbers by the parameter array,
    // not by order of appearance.
    variables: ["customer_name", "business_name", "service", "date", "time"],
  },
  {
    key: "booking_rescheduled",
    label: "Rescheduled",
    description: "Sent when a booking moves to a new date or time.",
    category: "UTILITY",
    body:
      "Hi {{1}}, your booking with {{2}} has moved.\n\n" +
      "{{3}}\nNew time: {{4}} at {{5}}\nWith {{6}}",
    variables: ["customer_name", "business_name", "service", "date", "time", "resource"],
    button: { text: "Manage booking", urlVariable: "manage_url" },
  },
  {
    key: "waitlist_offered",
    label: "Waitlist slot offered",
    description: "Sent when a cancellation frees a slot someone is waiting for. First come, first served.",
    category: "UTILITY",
    body:
      "Hi {{1}}, a spot has opened up at {{2}}.\n\n" +
      "{{3}}\n{{4}} at {{5}}\n\n" +
      "First come, first served — this offer expires at {{6}}.",
    variables: ["customer_name", "business_name", "service", "date", "time", "expires_at"],
    button: { text: "Claim this slot", urlVariable: "claim_url" },
  },
];

export const TEMPLATE_KEYS: readonly WhatsAppTemplateKey[] = WHATSAPP_TEMPLATES.map((t) => t.key);

export function templateFor(key: WhatsAppTemplateKey): WhatsAppTemplateDef {
  const def = WHATSAPP_TEMPLATES.find((t) => t.key === key);
  if (!def) throw new Error(`No WhatsApp template named "${key}"`);
  return def;
}

/**
 * The variable values in the order Meta expects them.
 *
 * Throws on a missing value rather than sending an empty one. A
 * WhatsApp template parameter that is blank is rejected by Meta with a
 * 132000, and a template that renders "your booking with  on  at " is
 * worse than no message — so the failure belongs here, before the
 * network call, where it names the token.
 *
 * Whitespace is collapsed for the same reason: Meta rejects a parameter
 * containing a newline or a tab, and a service called "Cut, colour\n&
 * finish" is a thing a merchant can genuinely type.
 */
export function orderedParameters(
  key: WhatsAppTemplateKey,
  values: Partial<Record<TemplateVariable, string>>
): string[] {
  const def = templateFor(key);
  return def.variables.map((name) => {
    const raw = values[name];
    if (raw === undefined || raw === null || `${raw}`.trim() === "") {
      throw new Error(`WhatsApp template "${key}" needs a value for {{${name}}}`);
    }
    return `${raw}`.replace(/\s+/g, " ").trim();
  });
}

/**
 * What a merchant sees on the Settings screen: the approved copy with
 * real words in it rather than `{{1}}`.
 */
export function previewBody(
  key: WhatsAppTemplateKey,
  values: Partial<Record<TemplateVariable, string>>
): string {
  const def = templateFor(key);
  return def.body.replace(/\{\{(\d+)\}\}/g, (match, position) => {
    const name = def.variables[Number(position) - 1];
    return (name && values[name]) || match;
  });
}
