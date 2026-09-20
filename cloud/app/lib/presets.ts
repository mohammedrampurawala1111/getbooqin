/* Vocabulary, the onboarding template picker, the integration catalogue
   and the setup checklist — everything the dashboard needs that is about
   *words and starting points* rather than booking logic.

   This file used to carry a second, parallel preset system: a `PREVIEW`
   table of eleven entries with their own vocabulary, a `rulesFor` /
   `ruleChips` / `startingRulesDiff` / `RULE_LABELS` apparatus for
   previewing what switching a preset would overwrite, and
   `CLINIC_FEATURE_PRESETS` for gating a feature on the shop's preset id.
   The dashboard read `vocabFor(presetId)` — a map *derived* from an id —
   while the mailer and the Shopify admin read the shop's *stored*
   `settings.terms`. Two sources of truth for the same nouns, already
   drifted once.

   There is one now: `vocabFor(settings.terms)`. A shop's words are
   whatever its owner typed on Settings → General; nothing derives them
   from an id, nothing overwrites them, and there is no switch to preview.
   What's left here is genuinely presentational — tile tint and a preview
   week of opening hours — keyed by starter-template id purely so the
   onboarding picker looks like something. */

import { useOutletContext } from "react-router";
import {
  STARTER_TEMPLATES,
  defaultTerms,
  withDefaultTerms,
  starterTemplate,
  termSuggestions,
  termSuggestionPairs,
  guessPlural,
  type StarterTemplate,
  type Terms,
} from "getbooqin-core/booking/presets";

export { STARTER_TEMPLATES, defaultTerms, withDefaultTerms, starterTemplate, termSuggestions, termSuggestionPairs, guessPlural };
export type { StarterTemplate, Terms };

/** Swatch palette a service's colour picker cycles through — shared so
 * onboarding's seeding assigns each default service a distinct colour the
 * same way the manual picker on a service's own page offers them, instead
 * of every seeded row defaulting to the same DB column default (Defect
 * Dossier's BQ-22 finding: every Legal service shared one blue swatch). */
export const SERVICE_SWATCHES = ["#b05fc9", "#2563eb", "#0f7a4f", "#92600b", "#b42318", "#545b68"];

export const DAY_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/* Tile tint and a preview week of opening hours — the only per-template
   data core has no reason to carry, because nothing is ever written from
   it. Purely how the onboarding picker looks. */
const TEMPLATE_STYLE: Record<string, { tint: string; open: boolean[]; range: string }> = {
  generic:     { tint: "#c9c2d4", open: [true, true, true, true, true, false, false], range: "09:00–17:00" },
  clinic:      { tint: "#8fbfd6", open: [true, true, true, true, true, true, false], range: "08:00–18:00" },
  dental:      { tint: "#7fb8c9", open: [true, true, true, true, true, true, false], range: "08:00–18:00" },
  salon:       { tint: "#e0a8c8", open: [false, true, true, true, true, true, false], range: "09:00–18:00" },
  automotive:  { tint: "#9aa4b2", open: [true, true, true, true, true, false, false], range: "08:00–17:30" },
  legal:       { tint: "#a9a0c9", open: [true, true, true, true, true, false, false], range: "09:00–18:00" },
  education:   { tint: "#e0c48f", open: [true, true, true, true, true, true, false], range: "15:00–20:00" },
  fitness:     { tint: "#8fd6b4", open: [true, true, true, true, true, true, true], range: "06:00–21:00" },
  realestate:  { tint: "#c9b48f", open: [true, true, true, true, true, true, false], range: "09:00–19:00" },
  restaurant:  { tint: "#e09a8f", open: [false, true, true, true, true, true, true], range: "12:00–23:00" },
  homeservice: { tint: "#8fc3d6", open: [true, true, true, true, true, true, false], range: "07:30–17:00" },
};

const FALLBACK_STYLE = TEMPLATE_STYLE.generic;

export type TemplateCard = StarterTemplate & {
  tint: string;
  open: boolean[];
  range: string;
  /** Picker-card tagline, taken from the template's own booking noun so it always names vocabulary the template actually seeds. */
  unit: string;
};

export const TEMPLATE_CARDS: TemplateCard[] = STARTER_TEMPLATES.map((template) => ({
  ...template,
  ...(TEMPLATE_STYLE[template.id] ?? FALLBACK_STYLE),
  unit: template.terms.booking_plural,
}));

export function templateCard(id: string | null | undefined): TemplateCard {
  return TEMPLATE_CARDS.find((t) => t.id === id) ?? TEMPLATE_CARDS[0];
}

// The onboarding hours preview used to carry its own hand-written summary
// line alongside the real open/range data shown right below it — Clinic's
// said "Sat mornings" while its data had Saturday open the same full
// 08:00–18:00 as every other day, and Education's named a distinct
// "Sat 09:00–14:00" that didn't exist anywhere in its data either (UX
// audit's #9 finding). Generating the summary from open/range instead
// means it can't drift from the schedule shown beneath it.
export function summarizeHours(open: readonly boolean[], range: string): string {
  const openDays = open.map((isOpen, i) => (isOpen ? i : -1)).filter((i) => i >= 0);
  if (openDays.length === 0) return "Closed";
  if (openDays.length === 7) return `Every day ${range}`;
  const isContiguousRun = openDays.every((day, idx) => idx === 0 || day === openDays[idx - 1] + 1);
  const dayPart = isContiguousRun
    ? `${DAY_ABBR[openDays[0]]}–${DAY_ABBR[openDays[openDays.length - 1]]}`
    : openDays.map((day) => DAY_ABBR[day]).join(", ");
  return `${dayPart} ${range}`;
}

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

/* Built from the shop's own stored `settings.terms` — the same object the
   mailer and the public booking page read, so the dashboard can no longer
   say "Appointments" while a confirmation email says "Bookings". Call
   once per request and pass it down. */
export function vocabFor(terms: Partial<Terms> | null | undefined) {
  const t = withDefaultTerms(terms);
  return {
    bookingOne: t.booking_single.toLowerCase(),
    bookingMany: t.booking_plural.toLowerCase(),
    bookingTitle: t.booking_plural,
    customerOne: t.customer_single.toLowerCase(),
    customers: t.customer_plural,
    resourceOne: t.resource_single.toLowerCase(),
    // The properly-cased singular, untouched — for headings like "X
    // utilisation" that need real title case. resourceOne can't be
    // recovered into this by re-capitalizing just its first character:
    // lowercasing "Service Bay" first and capitalizing only the "S" back
    // produces "Service bay", which is exactly the casing bug this field
    // exists to avoid (UX audit's #12 finding).
    resourceOneTitle: t.resource_single,
    resources: t.resource_plural,
    serviceOne: t.service_single.toLowerCase(),
    // Same reasoning as resourceOneTitle above — kept for field labels
    // ("Consultation type") that need real title case, where serviceOne
    // alone renders lowercase mid-form (Defect Dossier's R2-08 finding).
    serviceOneTitle: t.service_single,
    services: t.service_plural,
  };
}

export type Vocabulary = ReturnType<typeof vocabFor>;

// Every dashboard.$connectionId.* route is a direct child of that layout's
// <Outlet>, which passes { vocab } down via context — one Settings lookup
// per request instead of every list/detail route re-querying it just to
// reach the same words. Only the sidebar nav (dashboard.$connectionId.tsx
// itself) used vocabFor() before; page <h1>s, stat tiles and empty states
// elsewhere still read the generic English nouns hardcoded in each route
// (UX audit's #5 finding) — this is the one place to call instead so that
// gap can't reopen route by route.
export function useVocabulary(): Vocabulary {
  const ctx = useOutletContext<{ vocab: Vocabulary } | undefined>();
  return ctx?.vocab ?? vocabFor(null);
}

/* ------------------------------------------------------------------ */
/* Integration catalogue — onboarding and Settings › Integrations
   render from this list, so adding a channel is one entry.            */
/* ------------------------------------------------------------------ */
export type IntegrationId = "shopify" | "whatsapp" | "wordpress" | "calendar";

export const INTEGRATIONS: {
  id: IntegrationId; name: string; initial: string; tint: string; tag: string; blurb: string;
}[] = [
  { id: "shopify", name: "Shopify", initial: "S", tint: "#5a8f3d", tag: "Products & checkout",
    blurb: "Sync your product catalogue as bookable services and put a booking widget in your theme." },
  { id: "whatsapp", name: "WhatsApp Business", initial: "W", tint: "#25a366", tag: "Reminders",
    blurb: "Send confirmations and reminders, and let customers reschedule by replying to a message." },
  { id: "wordpress", name: "WordPress", initial: "W", tint: "#3c5a72", tag: "Website widget",
    blurb: "Drop a booking block on any page or post with the GetBooqin plugin." },
  { id: "calendar", name: "Google Calendar", initial: "G", tint: "#c9563f", tag: "Two-way sync",
    blurb: "Busy time in staff calendars blocks slots automatically, and bookings appear as events." },
];

/* ------------------------------------------------------------------ */
/* Setup checklist — drives the empty dashboard. Derive it from real
   loader data; never hardcode the remaining count. */
/* ------------------------------------------------------------------ */
export type SetupFacts = {
  terms: Partial<Terms> | null;
  businessNamed: boolean;
  serviceCount: number;
  bookableResourceCount: number;
  connectedChannels: number;
  channelSetupSkipped: boolean;
  remindersOn: boolean;
};

export function setupTasks(f: SetupFacts, canManageStaff = false) {
  const v = vocabFor(f.terms);
  return [
    // Accounts from before onboarding persisted a real name see their raw
    // manual-<uuid> connection id as their business name with no prompt
    // telling them it's editable (UX audit's D2 finding) — this surfaces
    // that as a real checklist item instead of a silent gap.
    { key: "name", name: "Name your business", hint: "Shown in the sidebar and on booking confirmations", done: f.businessNamed },
    { key: "services", name: `Add your ${v.services.toLowerCase()}`, hint: `${f.serviceCount} added so far`, done: f.serviceCount > 0 },
    // The same underlying fact either way — bookable *hours* exist, not
    // merely a resource row, since a resource with every day toggled off
    // takes zero bookings while technically existing (UX audit's B1
    // finding). What changes is where the merchant is sent to fix it.
    //
    // With staff management dark there is no Staff screen to send them
    // to, and "Add staff" is a task a one-person business cannot
    // complete and should not be asked to. They set hours on Settings,
    // which writes through to the resource onboarding already made.
    canManageStaff
      ? {
          key: "resources",
          name: `Add ${v.resources.toLowerCase()}`,
          hint: `At least one ${v.resourceOne} needs bookable hours`,
          done: f.bookableResourceCount > 0,
        }
      : {
          key: "hours",
          name: "Set your business hours",
          hint: "When customers can book",
          done: f.bookableResourceCount > 0,
        },
    { key: "reminders", name: "Turn on reminders", hint: "Cuts no-shows by around a third", done: f.remindersOn },
  ];
}

/* "One step left before your first booking can come in." */
export function setupSummary(f: SetupFacts, canManageStaff = false) {
  const tasks = setupTasks(f, canManageStaff);
  const done = tasks.filter((t) => t.done).length;
  const left = tasks.length - done;
  const v = vocabFor(f.terms);
  const headline =
    left === 0 ? `Setup is complete — your first ${v.bookingOne} can come in now.`
    : left === 1 ? `One step left before your first ${v.bookingOne} can come in.`
    : `${left} steps left before your first ${v.bookingOne} can come in.`;
  return { tasks, done, left, total: tasks.length, headline, pct: Math.round((done / tasks.length) * 100), complete: left === 0 };
}
