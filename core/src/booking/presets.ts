/**
 * Vocabulary, and the seed data a new account starts from.
 *
 * This file used to be an industry *preset* system: eleven entries, each
 * carrying `terms` **plus** a `defaults` block that overwrote eleven live
 * settings keys (booking rules, consent text, widget copy, four email
 * templates) on a shop whenever a preset was applied or re-applied. That
 * one design choice is what spawned `PRESET_CONTROLLED_KEYS`,
 * `applyPreset()`, `settings.customized_fields`, per-field "Preset
 * default / Customized" badges, a whole Settings → Business template
 * page whose job was explaining what switching would and wouldn't
 * overwrite, and a second, parallel vocabulary system in the cloud app
 * that had already drifted out of step with this one.
 *
 * The user-visible value of all of that was: different words, and
 * different starting numbers. So that is all this is now.
 *
 * - **Words** are `Terms`, stored per shop in `settings.terms` and
 *   editable as free text on Settings → General. Nothing derives them
 *   from an id any more, so a business can call a booking a Cohort, a
 *   Sitting or a Viewing without waiting for a preset to exist for it.
 * - **Starting numbers** are `STARTER_TEMPLATES`, and they are *seed
 *   data only* — read once, during onboarding, to pre-fill the first
 *   services and a sensible slot interval. Nothing reads a template
 *   again after that, so there is no "switching" to reason about and
 *   nothing a merchant edits can be silently overwritten later.
 *
 * `settings.preset` survives as a plain label ("what kind of business is
 * this") for analytics. No behaviour keys off it.
 *
 * Zero imports, deliberately: this module is safe to pull into a browser
 * bundle, same as settingsShared/bookingsShared.
 */

export interface Terms {
  resource_single: string;
  resource_plural: string;
  service_single: string;
  service_plural: string;
  booking_single: string;
  booking_plural: string;
  customer_single: string;
  customer_plural: string;
}

/** The neutral vocabulary every shop starts from and falls back to. */
export function defaultTerms(): Terms {
  return {
    resource_single: "Staff",
    resource_plural: "Staff",
    service_single: "Service",
    service_plural: "Services",
    booking_single: "Booking",
    booking_plural: "Bookings",
    customer_single: "Customer",
    customer_plural: "Customers",
  };
}

/**
 * Fills in any missing/blank word from the neutral set, so a partially
 * saved vocabulary can never render an empty noun in a heading. Also the
 * single place a legacy row with no `terms` at all gets a usable value.
 */
export function withDefaultTerms(terms: Partial<Terms> | null | undefined): Terms {
  const base = defaultTerms();
  if (!terms) return base;
  const out = { ...base };
  for (const key of Object.keys(base) as (keyof Terms)[]) {
    const value = terms[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return out;
}

export interface StarterService {
  name: string;
  minutes: number;
  location?: "onsite" | "video" | "phone";
}

/**
 * Onboarding seed data. `slotInterval` and `services` are written once,
 * at the point the merchant picks a tile, and never consulted again —
 * see this file's header comment on why that matters.
 */
/**
 * Deliberately no price.
 *
 * A duration generalises — a haircut is about forty minutes wherever
 * you are. A price does not: it depends on the currency, the city and
 * the business, and the wizard never shows these to the merchant before
 * going live. Seeding them meant a salon in Pune went live advertising
 * "Cut & finish · ₹45" — the figure was written for dollars and landed
 * in rupees, roughly twenty times under, on a public page the owner had
 * not been shown.
 *
 * Services are therefore seeded unpriced, and every screen already
 * guards on `price > 0`, so an unpriced service simply shows no price
 * until the merchant sets one.
 */
export interface StarterTemplate {
  id: string;
  label: string;
  terms: Terms;
  slotInterval: number;
  services: StarterService[];
}

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    id: "generic",
    label: "Generic / Other",
    terms: defaultTerms(),
    slotInterval: 30,
    services: [
      { name: "Standard appointment", minutes: 60 },
      { name: "Short appointment", minutes: 30 },
      { name: "Consultation", minutes: 30 },
      { name: "Follow-up", minutes: 45 },
    ],
  },
  {
    id: "clinic",
    label: "Clinic / Healthcare",
    terms: {
      resource_single: "Practitioner", resource_plural: "Practitioners",
      service_single: "Treatment", service_plural: "Treatments",
      booking_single: "Appointment", booking_plural: "Appointments",
      customer_single: "Patient", customer_plural: "Patients",
    },
    slotInterval: 15,
    services: [
      { name: "Initial assessment", minutes: 45, location: "onsite" },
      { name: "Follow-up consultation", minutes: 20, location: "onsite" },
      { name: "Physiotherapy session", minutes: 40, location: "onsite" },
      { name: "Vaccination", minutes: 15, location: "onsite" },
    ],
  },
  {
    // Same words a GP practice uses, different treatments. Kept as its
    // own tile because "clinic"'s seeded services (initial assessment,
    // physiotherapy, vaccination) had nothing dental in them, and a real
    // dental practice went live with that generic scaffold and
    // placeholder prices publicly visible on its booking page (GetBooqin
    // clinic audit's TR-01 finding).
    id: "dental",
    label: "Dental Practice",
    terms: {
      resource_single: "Dentist", resource_plural: "Dentists",
      service_single: "Treatment", service_plural: "Treatments",
      booking_single: "Appointment", booking_plural: "Appointments",
      customer_single: "Patient", customer_plural: "Patients",
    },
    slotInterval: 15,
    services: [
      { name: "Scale & polish", minutes: 30, location: "onsite" },
      { name: "Extraction", minutes: 30, location: "onsite" },
      { name: "Root canal", minutes: 60, location: "onsite" },
      { name: "Crown fitting", minutes: 45, location: "onsite" },
    ],
  },
  {
    id: "salon",
    label: "Salon / Spa / Barber",
    terms: {
      resource_single: "Stylist", resource_plural: "Stylists",
      service_single: "Service", service_plural: "Services",
      booking_single: "Appointment", booking_plural: "Appointments",
      customer_single: "Client", customer_plural: "Clients",
    },
    slotInterval: 15,
    services: [
      { name: "Cut & finish", minutes: 60 },
      { name: "Balayage & toner", minutes: 150 },
      { name: "Gel manicure", minutes: 45 },
      { name: "Beard trim", minutes: 20 },
    ],
  },
  {
    id: "automotive",
    label: "Automotive / Repair Shop",
    terms: {
      resource_single: "Bay", resource_plural: "Bays",
      service_single: "Job", service_plural: "Jobs",
      booking_single: "Booking", booking_plural: "Bookings",
      customer_single: "Customer", customer_plural: "Customers",
    },
    slotInterval: 60,
    services: [
      { name: "MOT test", minutes: 60 },
      { name: "Full service", minutes: 180 },
      { name: "Tyre change", minutes: 45 },
      { name: "Diagnostics", minutes: 90 },
    ],
  },
  {
    id: "legal",
    label: "Legal / Consulting",
    terms: {
      resource_single: "Consultant", resource_plural: "Consultants",
      service_single: "Consultation type", service_plural: "Consultation types",
      booking_single: "Consultation", booking_plural: "Consultations",
      customer_single: "Client", customer_plural: "Clients",
    },
    slotInterval: 30,
    services: [
      { name: "Discovery call", minutes: 30, location: "video" },
      { name: "Strategy session", minutes: 60, location: "video" },
      { name: "Document review", minutes: 90 },
      { name: "Quarterly review", minutes: 60 },
    ],
  },
  {
    id: "education",
    label: "Education / Tutoring",
    terms: {
      resource_single: "Tutor", resource_plural: "Tutors",
      service_single: "Course", service_plural: "Courses",
      booking_single: "Lesson", booking_plural: "Lessons",
      customer_single: "Student", customer_plural: "Students",
    },
    slotInterval: 30,
    services: [
      { name: "1:1 tuition", minutes: 60 },
      { name: "Group class", minutes: 90 },
      { name: "Trial lesson", minutes: 30 },
      { name: "Exam prep block", minutes: 120 },
    ],
  },
  {
    id: "fitness",
    label: "Fitness / Wellness",
    terms: {
      resource_single: "Trainer", resource_plural: "Trainers",
      service_single: "Class", service_plural: "Classes",
      booking_single: "Session", booking_plural: "Sessions",
      customer_single: "Member", customer_plural: "Members",
    },
    slotInterval: 30,
    services: [
      { name: "Personal training", minutes: 60 },
      { name: "Group class", minutes: 45 },
      { name: "Assessment", minutes: 30 },
      { name: "Recovery session", minutes: 30 },
    ],
  },
  {
    id: "realestate",
    label: "Real Estate / Property Viewings",
    terms: {
      resource_single: "Agent", resource_plural: "Agents",
      service_single: "Viewing type", service_plural: "Viewing types",
      booking_single: "Viewing", booking_plural: "Viewings",
      customer_single: "Prospect", customer_plural: "Prospects",
    },
    slotInterval: 30,
    services: [
      { name: "Property viewing", minutes: 30 },
      { name: "Second viewing", minutes: 45 },
      { name: "Valuation visit", minutes: 60 },
      { name: "Open house slot", minutes: 120 },
    ],
  },
  {
    id: "restaurant",
    label: "Restaurant / Table Reservations",
    terms: {
      resource_single: "Table", resource_plural: "Tables",
      service_single: "Sitting", service_plural: "Sittings",
      booking_single: "Reservation", booking_plural: "Reservations",
      customer_single: "Guest", customer_plural: "Guests",
    },
    slotInterval: 30,
    services: [
      { name: "Lunch sitting", minutes: 90 },
      { name: "Dinner sitting", minutes: 120 },
      { name: "Private dining", minutes: 180 },
      { name: "Bar seating", minutes: 60 },
    ],
  },
  {
    id: "homeservice",
    label: "Home Services / Trades",
    terms: {
      resource_single: "Engineer", resource_plural: "Engineers",
      service_single: "Service", service_plural: "Services",
      booking_single: "Job", booking_plural: "Jobs",
      customer_single: "Customer", customer_plural: "Customers",
    },
    slotInterval: 60,
    services: [
      { name: "Quotation visit", minutes: 30, location: "onsite" },
      { name: "Standard callout", minutes: 120, location: "onsite" },
      { name: "Annual service", minutes: 60, location: "onsite" },
      { name: "Emergency callout", minutes: 90, location: "onsite" },
    ],
  },
];

export function starterTemplate(id: string | null | undefined): StarterTemplate {
  return STARTER_TEMPLATES.find((t) => t.id === id) ?? STARTER_TEMPLATES[0];
}

export function templateChoices(): Array<{ value: string; label: string }> {
  return STARTER_TEMPLATES.map((t) => ({ value: t.id, label: t.label }));
}

/**
 * Suggestion chips for the vocabulary editor — every distinct word any
 * starter template uses for a given slot, so the eleven templates stay
 * the single source of these and a chip can never name a noun the
 * product has never shipped. Deliberately not a closed list: the input
 * next to the chips is free text.
 */
export function termSuggestions(key: keyof Terms): string[] {
  const seen: string[] = [];
  for (const template of STARTER_TEMPLATES) {
    const word = template.terms[key];
    if (!seen.includes(word)) seen.push(word);
  }
  return seen;
}

/**
 * The same suggestions, but carrying the plural that belongs with each
 * singular.
 *
 * A suggestion that fills only the singular leaves the merchant to type
 * the plural themselves, every time, for every row — which makes the
 * two fields read as the same question asked twice. The plurals are
 * already sitting in the templates beside the singulars, and they are
 * the ones that are not simply "+s": Person/People, Class/Classes.
 */
export function termSuggestionPairs(single: keyof Terms, plural: keyof Terms): { single: string; plural: string }[] {
  const out: { single: string; plural: string }[] = [];
  for (const template of STARTER_TEMPLATES) {
    const word = template.terms[single];
    if (!out.some((s) => s.single === word)) out.push({ single: word, plural: template.terms[plural] });
  }
  return out;
}

/**
 * A reasonable plural for a word the merchant typed, for the common
 * English cases. Only ever used to *prefill* the plural field while it
 * still agrees with the singular — never to overwrite a plural someone
 * has set, because the whole point of the field is the words this rule
 * gets wrong.
 */
export function guessPlural(single: string): string {
  const word = single.trim();
  if (!word) return "";
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}
