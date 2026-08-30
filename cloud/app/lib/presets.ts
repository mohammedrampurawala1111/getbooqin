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
  unit: string;               // what the industry counts, for marketing copy
  tint: string;               // swatch on the preset tile
  vocab: {
    booking: string;          // "Booking" | "Appointment" | "Job" | "Reservation" — sourced from core's terms
    customer: string;         // "Customer" | "Patient" | "Client" | "Guest" — sourced from core's terms
    resource: string;         // "Staff Member" | "Doctor" | "Stylist" — sourced from core's terms
    services: string;         // section heading for bookable things — cosmetic, local
    resources: string;        // section heading for who/what takes them — cosmetic, local
  };
  services: { name: string; minutes: number }[];
  open: boolean[];            // Mon..Sun
  range: string;              // default open range for open days
};

// Marketing/preview-only data core has no reason to carry: label copy, tile
// tint, "what this industry counts" unit, sample services, and a preview
// week of hours. Section headings (vocab.services/resources) live here too
// — they're richer nav copy ("Practitioners & rooms") than core's plain
// plural noun, and onboarding-preview-only, so drift here has no real
// consequence the way booking/customer/resource wording did.
const PREVIEW: Record<PresetId, Omit<Preset, "id" | "vocab"> & { vocabExtra: Pick<Preset["vocab"], "services" | "resources"> }> = {
  generic: {
    label: "Generic / Other", unit: "Appointments", tint: "#c9c2d4",
    vocabExtra: { services: "Services", resources: "Staff & resources" },
    services: [
      { name: "Standard appointment", minutes: 60 },
      { name: "Short appointment", minutes: 30 },
      { name: "Consultation", minutes: 30 },
      { name: "Follow-up", minutes: 45 },
    ],
    open: [true, true, true, true, true, false, false], range: "09:00–17:00",
  },
  clinic: {
    label: "Clinic / Healthcare", unit: "Patient visits", tint: "#8fbfd6",
    vocabExtra: { services: "Treatments", resources: "Practitioners & rooms" },
    services: [
      { name: "Initial assessment", minutes: 45 },
      { name: "Follow-up consultation", minutes: 20 },
      { name: "Physiotherapy session", minutes: 40 },
      { name: "Vaccination", minutes: 15 },
    ],
    open: [true, true, true, true, true, true, false], range: "08:00–18:00",
  },
  salon: {
    label: "Salon / Spa / Barber", unit: "Chair time", tint: "#e0a8c8",
    vocabExtra: { services: "Services", resources: "Stylists & chairs" },
    services: [
      { name: "Cut & finish", minutes: 60 },
      { name: "Balayage & toner", minutes: 150 },
      { name: "Gel manicure", minutes: 45 },
      { name: "Beard trim", minutes: 20 },
    ],
    open: [false, true, true, true, true, true, false], range: "09:00–18:00",
  },
  automotive: {
    label: "Automotive / Repair Shop", unit: "Bay slots", tint: "#9aa4b2",
    vocabExtra: { services: "Jobs", resources: "Service bays" },
    services: [
      { name: "MOT test", minutes: 60 },
      { name: "Full service", minutes: 180 },
      { name: "Tyre change", minutes: 45 },
      { name: "Diagnostics", minutes: 90 },
    ],
    open: [true, true, true, true, true, false, false], range: "08:00–17:30",
  },
  legal: {
    label: "Legal / Consulting", unit: "Billable meetings", tint: "#a9a0c9",
    vocabExtra: { services: "Consultation types", resources: "Consultants & rooms" },
    services: [
      { name: "Discovery call", minutes: 30 },
      { name: "Strategy session", minutes: 60 },
      { name: "Document review", minutes: 90 },
      { name: "Quarterly review", minutes: 60 },
    ],
    open: [true, true, true, true, true, false, false], range: "09:00–18:00",
  },
  education: {
    label: "Education / Tutoring", unit: "Lessons", tint: "#e0c48f",
    vocabExtra: { services: "Classes", resources: "Tutors & rooms" },
    services: [
      { name: "1:1 tuition", minutes: 60 },
      { name: "Group class", minutes: 90 },
      { name: "Trial lesson", minutes: 30 },
      { name: "Exam prep block", minutes: 120 },
    ],
    open: [true, true, true, true, true, true, false], range: "15:00–20:00",
  },
  fitness: {
    label: "Fitness / Wellness", unit: "Classes", tint: "#8fd6b4",
    vocabExtra: { services: "Classes", resources: "Trainers & studios" },
    services: [
      { name: "Personal training", minutes: 60 },
      { name: "Group class", minutes: 45 },
      { name: "Assessment", minutes: 30 },
      { name: "Recovery session", minutes: 30 },
    ],
    open: [true, true, true, true, true, true, true], range: "06:00–21:00",
  },
  realestate: {
    label: "Real Estate / Property Viewings", unit: "Viewings", tint: "#c9b48f",
    vocabExtra: { services: "Viewing types", resources: "Agents" },
    services: [
      { name: "Property viewing", minutes: 30 },
      { name: "Second viewing", minutes: 45 },
      { name: "Valuation visit", minutes: 60 },
      { name: "Open house slot", minutes: 120 },
    ],
    open: [true, true, true, true, true, true, false], range: "09:00–19:00",
  },
  restaurant: {
    label: "Restaurant / Table Reservations", unit: "Covers", tint: "#e09a8f",
    vocabExtra: { services: "Sittings", resources: "Tables & sections" },
    services: [
      { name: "Lunch sitting", minutes: 90 },
      { name: "Dinner sitting", minutes: 120 },
      { name: "Private dining", minutes: 180 },
      { name: "Bar seating", minutes: 60 },
    ],
    open: [false, true, true, true, true, true, true], range: "12:00–23:00",
  },
  homeservice: {
    label: "Home Services / Trades", unit: "Site visits", tint: "#8fc3d6",
    vocabExtra: { services: "Job types", resources: "Engineers & vans" },
    services: [
      { name: "Quotation visit", minutes: 30 },
      { name: "Standard callout", minutes: 120 },
      { name: "Annual service", minutes: 60 },
      { name: "Emergency callout", minutes: 90 },
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
    vocab: {
      booking: terms.booking_single,
      customer: terms.customer_single,
      resource: terms.resource_single,
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
const GENERIC_RULE_FALLBACK = {
  min_notice_hours: 2,
  max_advance_days: 60,
  cancel_cutoff_hours: 24,
  auto_confirm: true,
  require_phone: false,
} as const;

export type PresetRules = typeof GENERIC_RULE_FALLBACK;

export function rulesFor(id: string | null | undefined): PresetRules {
  const preset = CORE_PRESETS[id as PresetId] ?? CORE_PRESETS.generic;
  return { ...GENERIC_RULE_FALLBACK, ...(preset.defaults as Partial<PresetRules>) };
}

/* Plain-language summary of rulesFor()'s output, for onboarding's "Starting
   rules" preview and the Business template page's before/after diff — one
   place to phrase these so both stay consistent. */
export function ruleChips(rules: PresetRules): string[] {
  return [
    rules.auto_confirm ? "Confirms bookings automatically" : "New bookings need approval first",
    `At least ${rules.min_notice_hours}h notice required to book`,
    `Customers can cancel up to ${rules.cancel_cutoff_hours}h before`,
    rules.require_phone ? "Phone number required at booking" : "Phone number optional",
  ];
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
    customers: `${p.vocab.customer}s`,
    resourceOne: p.vocab.resource.toLowerCase(),
    resources: p.vocab.resources,
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
  resourceCount: number;
  connectedChannels: number;
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
    { key: "preset", name: "Choose your industry preset", hint: "Sets services, vocabulary and reminders", done: !!f.presetId },
    { key: "services", name: `Add your ${v.services.toLowerCase()}`, hint: `${f.serviceCount} scaffolded from the preset`, done: f.serviceCount > 0 },
    { key: "resources", name: `Add ${v.resources.toLowerCase()}`, hint: `At least one person or room must take ${v.bookingMany}`, done: f.resourceCount > 0 },
    { key: "channel", name: "Connect a channel", hint: f.connectedChannels > 0 ? `${f.connectedChannels} connected` : "Shopify, WhatsApp or WordPress", done: f.connectedChannels > 0 },
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
