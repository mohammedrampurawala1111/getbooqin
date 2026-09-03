/* Industry presets — the vocab and rule-preview data here is now sourced
   from core/src/booking/presets.ts (getbooqin-core's real preset system,
   the one Settings.applyPreset actually writes to a shop's Settings row),
   imported via the `getbooqin-core/booking/presets` export subpath, which
   (like settingsShared/bookingsShared) has zero imports and is safe for a
   client bundle. This used to be a fully separate, hand-maintained array
   that only shared preset *ids* with core by convention — vocabulary had
   drifted (e.g. this file called automotive's resource "Technician" while
   core's actual Terms call it "Service Bay") so the onboarding preview no
   longer always matched what a merchant's shop would actually show. Only
   genuinely presentational data that core has no concept of — marketing
   copy (label/unit/tint), sample services, and preview business hours —
   stays local here. */

import { useOutletContext } from "react-router";
import { PRESETS as CORE_PRESETS, type Preset as CorePreset } from "getbooqin-core/booking/presets";

export type PresetId = Extract<keyof typeof CORE_PRESETS, string>;

export type Preset = {
  id: PresetId;
  label: string;
  unit: string;               // picker-card tagline — derived from the preset's own booking noun (terms.booking_plural), so it always names vocabulary the preset actually uses
  tint: string;               // swatch on the preset tile
  vocab: {
    booking: string;          // "Booking" | "Appointment" | "Job" | "Reservation" — sourced from core's terms
    customer: string;         // "Customer" | "Patient" | "Client" | "Guest" — sourced from core's terms
    resource: string;         // "Staff" | "Practitioner" | "Stylist" — sourced from core's terms
    service: string;          // "Service" | "Treatment" | "Job" | "Sitting" (singular) — sourced from core's terms
    services: string;         // section heading for bookable things — cosmetic, local
    resources: string;        // section heading for who/what takes them — cosmetic, local
  };
  services: { name: string; minutes: number; price: number; location?: "onsite" | "video" | "phone" }[];
  open: boolean[];            // Mon..Sun
  range: string;              // default open range for open days
};

/** Swatch palette a service's colour picker cycles through — shared so
 * preset seeding (onboarding, template switch) assigns each default service
 * a distinct colour the same way the manual picker on a service's own page
 * offers them, instead of every seeded row defaulting to the same DB column
 * default (Defect Dossier's BQ-22 finding: every Legal service shared one
 * blue swatch). */
export const SERVICE_SWATCHES = ["#b05fc9", "#2563eb", "#0f7a4f", "#92600b", "#b42318", "#545b68"];

// Marketing/preview-only data core has no reason to carry: label copy, tile
// tint, "what this industry counts" unit, sample services, and a preview
// week of hours. Section headings (vocab.services/resources) live here too
// — they're richer nav copy ("Practitioners & rooms") than core's plain
// plural noun, and onboarding-preview-only, so drift here has no real
// consequence the way booking/customer/resource wording did.
const PREVIEW: Record<PresetId, Omit<Preset, "id" | "vocab" | "unit"> & { vocabExtra: Pick<Preset["vocab"], "services" | "resources"> }> = {
  generic: {
    label: "Generic / Other", tint: "#c9c2d4",
    vocabExtra: { services: "Services", resources: "Staff & resources" },
    services: [
      { name: "Standard appointment", minutes: 60, price: 50 },
      { name: "Short appointment", minutes: 30, price: 25 },
      { name: "Consultation", minutes: 30, price: 30 },
      { name: "Follow-up", minutes: 45, price: 35 },
    ],
    open: [true, true, true, true, true, false, false], range: "09:00–17:00",
  },
  clinic: {
    label: "Clinic / Healthcare", tint: "#8fbfd6",
    vocabExtra: { services: "Treatments", resources: "Practitioners & rooms" },
    services: [
      { name: "Initial assessment", minutes: 45, price: 90, location: "onsite" },
      { name: "Follow-up consultation", minutes: 20, price: 45, location: "onsite" },
      { name: "Physiotherapy session", minutes: 40, price: 65, location: "onsite" },
      { name: "Vaccination", minutes: 15, price: 25, location: "onsite" },
    ],
    open: [true, true, true, true, true, true, false], range: "08:00–18:00",
  },
  salon: {
    label: "Salon / Spa / Barber", tint: "#e0a8c8",
    vocabExtra: { services: "Services", resources: "Stylists & chairs" },
    services: [
      { name: "Cut & finish", minutes: 60, price: 45 },
      { name: "Balayage & toner", minutes: 150, price: 120 },
      { name: "Gel manicure", minutes: 45, price: 35 },
      { name: "Beard trim", minutes: 20, price: 20 },
    ],
    open: [false, true, true, true, true, true, false], range: "09:00–18:00",
  },
  automotive: {
    label: "Automotive / Repair Shop", tint: "#9aa4b2",
    vocabExtra: { services: "Jobs", resources: "Service bays" },
    services: [
      { name: "MOT test", minutes: 60, price: 55 },
      { name: "Full service", minutes: 180, price: 250 },
      { name: "Tyre change", minutes: 45, price: 80 },
      { name: "Diagnostics", minutes: 90, price: 60 },
    ],
    open: [true, true, true, true, true, false, false], range: "08:00–17:30",
  },
  legal: {
    label: "Legal / Consulting", tint: "#a9a0c9",
    vocabExtra: { services: "Consultation types", resources: "Consultants & rooms" },
    services: [
      { name: "Discovery call", minutes: 30, price: 50, location: "video" },
      { name: "Strategy session", minutes: 60, price: 150, location: "video" },
      { name: "Document review", minutes: 90, price: 200 },
      { name: "Quarterly review", minutes: 60, price: 150 },
    ],
    open: [true, true, true, true, true, false, false], range: "09:00–18:00",
  },
  education: {
    label: "Education / Tutoring", tint: "#e0c48f",
    vocabExtra: { services: "Courses", resources: "Tutors & rooms" },
    services: [
      { name: "1:1 tuition", minutes: 60, price: 40 },
      { name: "Group class", minutes: 90, price: 25 },
      { name: "Trial lesson", minutes: 30, price: 15 },
      { name: "Exam prep block", minutes: 120, price: 60 },
    ],
    open: [true, true, true, true, true, true, false], range: "15:00–20:00",
  },
  fitness: {
    label: "Fitness / Wellness", tint: "#8fd6b4",
    vocabExtra: { services: "Classes", resources: "Trainers & studios" },
    services: [
      { name: "Personal training", minutes: 60, price: 50 },
      { name: "Group class", minutes: 45, price: 20 },
      { name: "Assessment", minutes: 30, price: 30 },
      { name: "Recovery session", minutes: 30, price: 35 },
    ],
    open: [true, true, true, true, true, true, true], range: "06:00–21:00",
  },
  realestate: {
    label: "Real Estate / Property Viewings", tint: "#c9b48f",
    vocabExtra: { services: "Viewing types", resources: "Agents" },
    services: [
      { name: "Property viewing", minutes: 30, price: 0 },
      { name: "Second viewing", minutes: 45, price: 0 },
      { name: "Valuation visit", minutes: 60, price: 0 },
      { name: "Open house slot", minutes: 120, price: 0 },
    ],
    open: [true, true, true, true, true, true, false], range: "09:00–19:00",
  },
  restaurant: {
    label: "Restaurant / Table Reservations", tint: "#e09a8f",
    vocabExtra: { services: "Sittings", resources: "Tables & sections" },
    services: [
      { name: "Lunch sitting", minutes: 90, price: 0 },
      { name: "Dinner sitting", minutes: 120, price: 0 },
      { name: "Private dining", minutes: 180, price: 0 },
      { name: "Bar seating", minutes: 60, price: 0 },
    ],
    open: [false, true, true, true, true, true, true], range: "12:00–23:00",
  },
  homeservice: {
    label: "Home Services / Trades", tint: "#8fc3d6",
    vocabExtra: { services: "Job types", resources: "Engineers & vans" },
    services: [
      { name: "Quotation visit", minutes: 30, price: 0, location: "onsite" },
      { name: "Standard callout", minutes: 120, price: 90, location: "onsite" },
      { name: "Annual service", minutes: 60, price: 70, location: "onsite" },
      { name: "Emergency callout", minutes: 90, price: 120, location: "onsite" },
    ],
    open: [true, true, true, true, true, true, false], range: "07:30–17:00",
  },
};

function termsOf(id: PresetId): CorePreset["terms"] {
  return CORE_PRESETS[id].terms;
}

export const PRESETS: Preset[] = (Object.keys(CORE_PRESETS) as PresetId[]).map((id) => {
  const { vocabExtra, ...preview } = PREVIEW[id];
  const terms = termsOf(id);
  return {
    id,
    ...preview,
    unit: terms.booking_plural,
    vocab: {
      booking: terms.booking_single,
      customer: terms.customer_single,
      resource: terms.resource_single,
      service: terms.service_single,
      ...vocabExtra,
    },
  };
});

// Real, wired scheduling-rule defaults (see core/src/booking/presets.ts's
// PRESET_CONTROLLED_KEYS) for the given preset, for onboarding/settings
// preview cards. `generic`'s own preset.defaults deliberately omits these
// four fields since they already equal this fallback — see
// core/src/booking/settings.ts's defaultSettings() — so it's spelled out
// here once rather than imported from that DB-touching module (unsafe for
// a client bundle; see this file's header comment on why presets.ts is the
// only core subpath safe to pull business facts from client-side).
const GENERIC_RULE_FALLBACK: PresetRules = {
  slot_interval: 30,
  min_notice_hours: 2,
  max_advance_days: 60,
  cancel_cutoff_hours: 24,
  auto_confirm: true,
  require_phone: false,
  waitlist_enabled: false,
  waitlist_offer_window_hours: 4,
};

export interface PresetRules {
  slot_interval: number;
  min_notice_hours: number;
  max_advance_days: number;
  cancel_cutoff_hours: number;
  auto_confirm: boolean;
  require_phone: boolean;
  waitlist_enabled: boolean;
  waitlist_offer_window_hours: number;
}

export function rulesFor(id: string | null | undefined): PresetRules {
  const preset = CORE_PRESETS[id as PresetId] ?? CORE_PRESETS.generic;
  return { ...GENERIC_RULE_FALLBACK, ...(preset.defaults as Partial<PresetRules>) };
}

/* Plain-language summary of rulesFor()'s output, for onboarding's "Starting
   rules" preview and the Business template page's before/after diff — one
   place to phrase these so both stay consistent. Covers every simple
   (non-text) key core/src/booking/presets.ts's PRESET_CONTROLLED_KEYS lets
   a preset set — this used to cover only 4 of the 11, so switching Legal ->
   Clinic silently also changed slot_interval/max_advance_days/
   waitlist_enabled with nothing in this list mentioning it (Defect
   Dossier's BQ-19 finding). consent_text/widget_text/templates are prose,
   not one-line rules, so they're called out qualitatively instead — see
   featureNotesFor() below. */
export function ruleChips(rules: PresetRules): string[] {
  return [
    rules.auto_confirm ? "Confirms bookings automatically" : "New bookings need approval first",
    `At least ${rules.min_notice_hours}h notice required to book`,
    `Bookable up to ${rules.max_advance_days} days ahead`,
    `Customers can cancel up to ${rules.cancel_cutoff_hours}h before`,
    `${rules.slot_interval}-minute slot spacing`,
    rules.require_phone ? "Phone number required at booking" : "Phone number optional",
    rules.waitlist_enabled
      ? `Offers freed slots to the waitlist (within ${rules.waitlist_offer_window_hours}h)`
      : "Waitlist offers are off",
  ];
}

/**
 * Feature surfaces a preset switch adds or removes, beyond the rule chips
 * above. Used to only ever announce what's gained, never what's lost —
 * switching Clinic -> Legal silently dropped the Visit summaries page (and
 * everything configured on it) with no mention in the confirmation dialog
 * (Defect Dossier's R3-04 finding). applyPreset() only ever touches fields
 * listed in a preset's own `defaults` (core/src/booking/settings.ts) —
 * visit-summary settings aren't one of them, so nothing is actually
 * deleted here, only hidden; the note below says so.
 */
export function featureNotesFor(fromId: string | null | undefined, toId: string | null | undefined): { text: string; removed: boolean }[] {
  const notes: { text: string; removed: boolean }[] = [];
  if (toId === "clinic" && fromId !== "clinic") {
    notes.push({ text: "Adds a Visit summaries page for AI-drafted patient summaries", removed: false });
  }
  if (fromId === "clinic" && toId !== "clinic") {
    notes.push({
      text: "Removes the Visit summaries page (your consent notice and settings are kept, and come back if you switch to Clinic again)",
      removed: true,
    });
  }
  return notes;
}

/**
 * The actual before/after for switching to `targetPresetId`, computed
 * against the shop's real current values — not a static description of
 * the target preset alone, which is what let three real changes (slot
 * interval, max advance days, waitlist toggle) go unmentioned even once
 * ruleChips() above covered them, because the old panel only ever showed
 * the *target*, never compared it to what the shop already had (Defect
 * Dossier's BQ-19 finding). A field the merchant has already hand-edited
 * (in `customizedFields`) is protected by applyPreset()'s own merge logic
 * (core/src/booking/settings.ts) and reported as kept, not changed.
 */
export interface RuleChange {
  label: string;
  kept: boolean;
  fromText: string;
  toText: string;
}

const RULE_LABELS: Record<keyof PresetRules, string> = {
  slot_interval: "Slot interval",
  min_notice_hours: "Minimum notice",
  max_advance_days: "Max advance booking",
  cancel_cutoff_hours: "Cancellation cutoff",
  auto_confirm: "Auto-confirm bookings",
  require_phone: "Require a phone number",
  waitlist_enabled: "Offer freed slots to the waitlist",
  waitlist_offer_window_hours: "Waitlist offer window",
};

function ruleValueText(key: keyof PresetRules, value: PresetRules[keyof PresetRules]): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

function displayValue(key: keyof PresetRules, value: PresetRules[keyof PresetRules]): string {
  if (key === "slot_interval") return `${value} min`;
  if (key === "waitlist_offer_window_hours") return `${value}h`;
  return ruleValueText(key, value);
}

export function startingRulesDiff(
  current: PresetRules,
  customizedFields: string[],
  targetPresetId: string | null | undefined
): RuleChange[] {
  const target = rulesFor(targetPresetId);
  return (Object.keys(RULE_LABELS) as (keyof PresetRules)[])
    .filter((key) => current[key] !== target[key]) // only fields the switch would actually touch
    .map((key) => ({
      label: RULE_LABELS[key],
      // Protected by applyPreset()'s own non-destructive merge — the
      // preset's new default would apply, but a hand-edited field never
      // gets silently overwritten, so it's reported as kept, not changed.
      kept: customizedFields.includes(key),
      fromText: displayValue(key, current[key]),
      toText: displayValue(key, target[key]),
    }));
}

export const DAY_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

// Onboarding's business-hours preview used to carry its own hand-written
// summary line (Preset.hours) alongside the real open/range data shown
// right below it — Clinic's said "Sat mornings" while its data had Saturday
// open the same full 08:00–18:00 as every other day, and Education's said a
// distinct "Sat 09:00–14:00" that didn't exist anywhere in its data either
// (UX audit's #9 finding, and the same shape of bug in a preset the
// auditor's pass hadn't reached yet). Generating the summary from open/range
// instead means it can't drift from the schedule shown beneath it, for any
// preset, ever again.
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

export function getPreset(id: string | null | undefined): Preset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}

/* Derived vocabulary. Call once per request from the connection's preset id and
   pass it down — every user-facing noun in the dashboard should come from here
   so a clinic reads "Appointments / Patients" and a garage reads "Jobs". */
export function vocabFor(id: string | null | undefined) {
  const p = getPreset(id);
  return {
    bookingOne: p.vocab.booking.toLowerCase(),
    bookingMany: `${p.vocab.booking.toLowerCase()}s`,
    bookingTitle: `${p.vocab.booking}s`,
    customerOne: p.vocab.customer.toLowerCase(),
    customers: `${p.vocab.customer}s`,
    resourceOne: p.vocab.resource.toLowerCase(),
    // The properly-cased singular, untouched — for headings like "X
    // utilisation" that need real title case. resourceOne can't be
    // recovered into this by re-capitalizing just its first character:
    // lowercasing "Service Bay" first and capitalizing only the "S" back
    // produces "Service bay", which is exactly the casing bug this field
    // exists to avoid (UX audit's #12 finding).
    resourceOneTitle: p.vocab.resource,
    resources: p.vocab.resources,
    serviceOne: p.vocab.service.toLowerCase(),
    // Same reasoning as resourceOneTitle above — kept for field labels
    // ("Consultation type") that need real title case, where serviceOne
    // alone renders lowercase mid-form (Defect Dossier's R2-08 finding).
    serviceOneTitle: p.vocab.service,
    services: p.vocab.services,
  };
}

export type Vocabulary = ReturnType<typeof vocabFor>;

// Every dashboard.$connectionId.* route is a direct child of that layout's
// <Outlet>, which passes { vocab } down via context — one Settings lookup
// per request instead of every list/detail route re-querying it just to
// reach the same preset id. Only the sidebar nav (dashboard.$connectionId.
// tsx itself) used vocabFor() before; page <h1>s, stat tiles and empty
// states elsewhere still read the generic English nouns hardcoded in each
// route (UX audit's #5 finding) — this is the one place to call instead so
// that gap can't reopen route by route.
export function useVocabulary(): Vocabulary {
  const ctx = useOutletContext<{ vocab: Vocabulary } | undefined>();
  return ctx?.vocab ?? vocabFor(null);
}

/* ------------------------------------------------------------------ */
/* Integration catalogue — onboarding step 3 and Settings › Integrations
   render from this list, so adding a channel is one entry.            */
/* ------------------------------------------------------------------ */
export type IntegrationId = "shopify" | "whatsapp" | "wordpress" | "calendar" | "stripe";

export const INTEGRATIONS: {
  id: IntegrationId; name: string; initial: string; tint: string; tag: string; blurb: string;
}[] = [
  { id: "shopify", name: "Shopify", initial: "S", tint: "#5a8f3d", tag: "Products & checkout",
    blurb: "Sync your product catalogue as bookable services and take deposits through Shopify checkout." },
  { id: "whatsapp", name: "WhatsApp Business", initial: "W", tint: "#25a366", tag: "Reminders",
    blurb: "Send confirmations and reminders, and let customers reschedule by replying to a message." },
  { id: "wordpress", name: "WordPress", initial: "W", tint: "#3c5a72", tag: "Website widget",
    blurb: "Drop a booking block on any page or post with the GetBooqin plugin." },
  { id: "calendar", name: "Google Calendar", initial: "G", tint: "#c9563f", tag: "Two-way sync",
    blurb: "Busy time in staff calendars blocks slots automatically, and bookings appear as events." },
  { id: "stripe", name: "Stripe", initial: "S", tint: "#5f5be0", tag: "Payments",
    blurb: "Take deposits and full payments if you are not selling through Shopify." },
];

/* ------------------------------------------------------------------ */
/* Setup checklist — drives the empty dashboard. Derive it from real
   loader data; never hardcode the remaining count. */
/* ------------------------------------------------------------------ */
export type SetupFacts = {
  presetId: string | null;
  businessNamed: boolean;
  serviceCount: number;
  bookableResourceCount: number;
  connectedChannels: number;
  channelSetupSkipped: boolean;
  remindersOn: boolean;
};

export function setupTasks(f: SetupFacts) {
  const v = vocabFor(f.presetId);
  return [
    // Accounts from before onboarding persisted a real name see their raw
    // manual-<uuid> connection id as their business name with no prompt
    // telling them it's editable (UX audit's D2 finding) — this surfaces
    // that as a real checklist item instead of a silent gap.
    { key: "name", name: "Name your business", hint: "Shown in the sidebar and on booking confirmations", done: f.businessNamed },
    { key: "preset", name: "Choose your industry preset", hint: `Sets ${v.services.toLowerCase()}, vocabulary and reminders`, done: !!f.presetId },
    { key: "services", name: `Add your ${v.services.toLowerCase()}`, hint: `${f.serviceCount} scaffolded from the preset`, done: f.serviceCount > 0 },
    // done requires bookable *hours*, not just a resource row existing — a
    // resource can be created with every day toggled off (onboarding's own
    // resource step used to do exactly that) and take zero bookings despite
    // technically existing (UX audit's B1 finding).
    { key: "resources", name: `Add ${v.resources.toLowerCase()}`, hint: `At least one ${v.resourceOne} needs bookable hours`, done: f.bookableResourceCount > 0 },
    {
      key: "channel",
      name: "Connect a channel",
      hint: f.connectedChannels > 0 ? `${f.connectedChannels} connected` : f.channelSetupSkipped ? "Skipped — selling without Shopify" : "Shopify, WhatsApp or WordPress",
      done: f.connectedChannels > 0 || f.channelSetupSkipped,
    },
    { key: "reminders", name: "Turn on reminders", hint: "Cuts no-shows by around a third", done: f.remindersOn },
  ];
}

/* "One step left before your first booking can come in." */
export function setupSummary(f: SetupFacts) {
  const tasks = setupTasks(f);
  const done = tasks.filter((t) => t.done).length;
  const left = tasks.length - done;
  const v = vocabFor(f.presetId);
  const headline =
    left === 0 ? `Setup is complete — your first ${v.bookingOne} can come in now.`
    : left === 1 ? `One step left before your first ${v.bookingOne} can come in.`
    : `${left} steps left before your first ${v.bookingOne} can come in.`;
  return { tasks, done, left, total: tasks.length, headline, pct: Math.round((done / tasks.length) * 100), complete: left === 0 };
}
