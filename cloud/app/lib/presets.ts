/* Industry presets — cosmetic UI layer only (onboarding preview + marketing
   tiles). Ids are kept identical to core's real preset system
   (getbooqin-core's Presets.PRESETS / Settings.applyPreset) so a preset
   chosen here can be posted straight through: "auto"/"trades" in the design
   handoff became "automotive"/"homeservice" to match. Core only carries
   `terms` + a couple of scheduling defaults; this file adds the richer
   preview data (sample services, hours, tint) used before a real store
   exists to attach real Services/Settings to. */

export type PresetId =
  | "generic" | "clinic" | "salon" | "automotive" | "legal"
  | "education" | "fitness" | "realestate" | "restaurant" | "homeservice";

export type Preset = {
  id: PresetId;
  label: string;
  unit: string;               // what the industry counts, for marketing copy
  tint: string;               // swatch on the preset tile
  vocab: {
    booking: string;          // "Booking" | "Appointment" | "Job" | "Reservation"
    customer: string;         // "Customer" | "Patient" | "Client" | "Guest"
    resource: string;         // "Team member" | "Practitioner" | "Stylist"
    services: string;         // section heading for bookable things
    resources: string;        // section heading for who/what takes them
  };
  services: { name: string; minutes: number }[];
  hours: string;              // human summary shown in onboarding
  open: boolean[];            // Mon..Sun
  range: string;              // default open range for open days
};

export const PRESETS: Preset[] = [
  {
    id: "generic", label: "Generic / Other", unit: "Appointments", tint: "#c9c2d4",
    vocab: { booking: "Booking", customer: "Customer", resource: "Team member", services: "Services", resources: "Staff & resources" },
    services: [
      { name: "Standard appointment", minutes: 60 },
      { name: "Short appointment", minutes: 30 },
      { name: "Consultation", minutes: 30 },
      { name: "Follow-up", minutes: 45 },
    ],
    hours: "Mon–Fri 09:00–17:00, weekends closed",
    open: [true, true, true, true, true, false, false], range: "09:00–17:00",
  },
  {
    id: "clinic", label: "Clinic / Healthcare", unit: "Patient visits", tint: "#8fbfd6",
    vocab: { booking: "Appointment", customer: "Patient", resource: "Practitioner", services: "Treatments", resources: "Practitioners & rooms" },
    services: [
      { name: "Initial assessment", minutes: 45 },
      { name: "Follow-up consultation", minutes: 20 },
      { name: "Physiotherapy session", minutes: 40 },
      { name: "Vaccination", minutes: 15 },
    ],
    hours: "Mon–Fri 08:00–18:00, Sat mornings",
    open: [true, true, true, true, true, true, false], range: "08:00–18:00",
  },
  {
    id: "salon", label: "Salon / Spa / Barber", unit: "Chair time", tint: "#e0a8c8",
    vocab: { booking: "Booking", customer: "Client", resource: "Stylist", services: "Services", resources: "Stylists & chairs" },
    services: [
      { name: "Cut & finish", minutes: 60 },
      { name: "Balayage & toner", minutes: 150 },
      { name: "Gel manicure", minutes: 45 },
      { name: "Beard trim", minutes: 20 },
    ],
    hours: "Tue–Sat 09:00–18:00",
    open: [false, true, true, true, true, true, false], range: "09:00–18:00",
  },
  {
    id: "automotive", label: "Automotive / Repair Shop", unit: "Bay slots", tint: "#9aa4b2",
    vocab: { booking: "Job", customer: "Vehicle owner", resource: "Technician", services: "Jobs", resources: "Technicians & bays" },
    services: [
      { name: "MOT test", minutes: 60 },
      { name: "Full service", minutes: 180 },
      { name: "Tyre change", minutes: 45 },
      { name: "Diagnostics", minutes: 90 },
    ],
    hours: "Mon–Fri 08:00–17:30",
    open: [true, true, true, true, true, false, false], range: "08:00–17:30",
  },
  {
    id: "legal", label: "Legal / Consulting", unit: "Billable meetings", tint: "#a9a0c9",
    vocab: { booking: "Meeting", customer: "Client", resource: "Adviser", services: "Meeting types", resources: "Advisers & rooms" },
    services: [
      { name: "Discovery call", minutes: 30 },
      { name: "Strategy session", minutes: 60 },
      { name: "Document review", minutes: 90 },
      { name: "Quarterly review", minutes: 60 },
    ],
    hours: "Mon–Fri 09:00–18:00",
    open: [true, true, true, true, true, false, false], range: "09:00–18:00",
  },
  {
    id: "education", label: "Education / Tutoring", unit: "Lessons", tint: "#e0c48f",
    vocab: { booking: "Lesson", customer: "Student", resource: "Tutor", services: "Subjects", resources: "Tutors & rooms" },
    services: [
      { name: "1:1 tuition", minutes: 60 },
      { name: "Group class", minutes: 90 },
      { name: "Trial lesson", minutes: 30 },
      { name: "Exam prep block", minutes: 120 },
    ],
    hours: "Mon–Fri 15:00–20:00, Sat 09:00–14:00",
    open: [true, true, true, true, true, true, false], range: "15:00–20:00",
  },
  {
    id: "fitness", label: "Fitness / Wellness", unit: "Classes", tint: "#8fd6b4",
    vocab: { booking: "Class booking", customer: "Member", resource: "Instructor", services: "Classes", resources: "Instructors & studios" },
    services: [
      { name: "Personal training", minutes: 60 },
      { name: "Group class", minutes: 45 },
      { name: "Assessment", minutes: 30 },
      { name: "Recovery session", minutes: 30 },
    ],
    hours: "Mon–Sun 06:00–21:00",
    open: [true, true, true, true, true, true, true], range: "06:00–21:00",
  },
  {
    id: "realestate", label: "Real Estate / Property Viewings", unit: "Viewings", tint: "#c9b48f",
    vocab: { booking: "Viewing", customer: "Buyer", resource: "Agent", services: "Viewing types", resources: "Agents" },
    services: [
      { name: "Property viewing", minutes: 30 },
      { name: "Second viewing", minutes: 45 },
      { name: "Valuation visit", minutes: 60 },
      { name: "Open house slot", minutes: 120 },
    ],
    hours: "Mon–Sat 09:00–19:00",
    open: [true, true, true, true, true, true, false], range: "09:00–19:00",
  },
  {
    id: "restaurant", label: "Restaurant / Table Reservations", unit: "Covers", tint: "#e09a8f",
    vocab: { booking: "Reservation", customer: "Guest", resource: "Table", services: "Sittings", resources: "Tables & sections" },
    services: [
      { name: "Lunch sitting", minutes: 90 },
      { name: "Dinner sitting", minutes: 120 },
      { name: "Private dining", minutes: 180 },
      { name: "Bar seating", minutes: 60 },
    ],
    hours: "Tue–Sun 12:00–23:00",
    open: [false, true, true, true, true, true, true], range: "12:00–23:00",
  },
  {
    id: "homeservice", label: "Home Services / Trades", unit: "Site visits", tint: "#8fc3d6",
    vocab: { booking: "Job", customer: "Customer", resource: "Engineer", services: "Job types", resources: "Engineers & vans" },
    services: [
      { name: "Quotation visit", minutes: 30 },
      { name: "Standard callout", minutes: 120 },
      { name: "Annual service", minutes: 60 },
      { name: "Emergency callout", minutes: 90 },
    ],
    hours: "Mon–Sat 07:30–17:00",
    open: [true, true, true, true, true, true, false], range: "07:30–17:00",
  },
];

export const DAY_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

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
  serviceCount: number;
  resourceCount: number;
  connectedChannels: number;
  remindersOn: boolean;
};

export function setupTasks(f: SetupFacts) {
  const v = vocabFor(f.presetId);
  return [
    { key: "preset", name: "Choose your industry preset", hint: "Sets services, vocabulary and reminders", done: !!f.presetId },
    { key: "services", name: `Add your ${v.services.toLowerCase()}`, hint: `${f.serviceCount} added`, done: f.serviceCount > 0 },
    { key: "resources", name: `Add ${v.resources.toLowerCase()}`, hint: `At least one person or room must take ${v.bookingMany}`, done: f.resourceCount > 0 },
    { key: "channel", name: "Connect a channel", hint: f.connectedChannels > 0 ? `${f.connectedChannels} connected` : "Shopify or Stripe", done: f.connectedChannels > 0 },
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
