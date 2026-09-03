import { useEffect, useState } from "react";
import { data, useFetcher } from "react-router";
import type { Route } from "./+types/book.$connectionId";
import {
  Data,
  Bookings,
  Settings as CoreSettings,
  ConsultationSummary,
  FeatureFlags,
  getPublicConnection,
  isGetBooqinError,
} from "getbooqin-core";
import type { PatientSummary } from "getbooqin-core";
import { formatInZone, wallClockToUtc, zoneAbbr } from "getbooqin-core/booking/tz";
import { vocabFor } from "~/lib/presets";
import { AlertError, Badge, ConfirmDialog, Field, FormErrorSummary, Input } from "~/components/ui";
import { LogoMark } from "~/components/onboarding";
import { throttle, clientIp } from "~/lib/http.server";
import { contactFieldErrors } from "~/lib/validation";

export const meta: Route.MetaFunction = ({ data: loaderData }) =>
  loaderData ? [{ title: `Book with ${loaderData.businessName} · GetBooqin` }] : [{ title: "Book · GetBooqin" }];

// Only the fields the public page actually needs — never spread the raw
// Settings object into loader data. settings.gateways can hold a merchant's
// own Stripe/PayPal secret key (BYO-credentials, not OAuth — see
// PaymentManager/gateways/stripe.ts), and settings.admin_email/video/chat_*
// are internal-only; React Router serializes whatever a loader returns
// straight to the browser, so leaking that object here would leak
// credentials, not just over-fetch.
function publicSettings(settings: CoreSettings.Settings) {
  return {
    businessName: settings.business_name,
    // Business header (Defect Dossier's BQ-33 finding) — the page
    // previously showed only the name, with none of a business's already-
    // collected contact details reaching a prospective client.
    businessDescription: settings.business_description,
    businessAddress: settings.business_address,
    businessPhone: settings.business_phone,
    currencySymbol: settings.currency_symbol,
    timezone: settings.timezone,
    requirePhone: settings.require_phone,
    intakeFields: settings.intake_fields,
    allowCancel: settings.allow_cancel,
    consentText: settings.consent_text,
  };
}

// Schedule.dayOfWeek is 0 (Sun) - 6 (Sat); reordered to a natural Mon-first
// read for the business-hours summary.
const HOURS_DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const HOURS_DAY_ABBR: Record<number, string> = { 0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat" };

/**
 * "Mon–Fri 09:00–18:00, Sat 10:00–14:00" — groups consecutive open days
 * sharing the exact same hours, the same idea as the onboarding preview's
 * summarizeHours() but supporting hours that vary by day (a whole
 * business's hours are the union of possibly-different resource
 * schedules, see Data.businessHours). Closed days are omitted rather than
 * spelled out; the open days already say what's bookable.
 */
function formatBusinessHours(hours: Array<{ dayOfWeek: number; open: boolean; start: string; end: string }>): string {
  const byDay = new Map(hours.map((h) => [h.dayOfWeek, h]));
  const ordered = HOURS_DAY_ORDER.map((d) => byDay.get(d)).filter((h): h is NonNullable<typeof h> => !!h && h.open);
  if (ordered.length === 0) return "";

  const groups: { start: string; end: string; days: number[] }[] = [];
  for (const h of ordered) {
    const last = groups[groups.length - 1];
    if (last && last.start === h.start && last.end === h.end && last.days[last.days.length - 1] === HOURS_DAY_ORDER[HOURS_DAY_ORDER.indexOf(h.dayOfWeek) - 1]) {
      last.days.push(h.dayOfWeek);
    } else {
      groups.push({ start: h.start, end: h.end, days: [h.dayOfWeek] });
    }
  }

  return groups
    .map((g) => {
      const dayLabel = g.days.length > 1 ? `${HOURS_DAY_ABBR[g.days[0]]}–${HOURS_DAY_ABBR[g.days[g.days.length - 1]]}` : HOURS_DAY_ABBR[g.days[0]];
      return `${dayLabel} ${g.start}–${g.end}`;
    })
    .join(", ");
}

/* ------------------------------------------------------------------ */
/* Visit Summary patient view — explicit allowlist transform. Never      */
/* spread the parsed PatientSummaryDraft into loader data: review_flags, */
/* withheld, unclear_passages, and every `source` quote are clinician-   */
/* facing review artifacts and must never reach this public, no-login    */
/* page (plan Part 3 §5). Building a fresh object literal per field,     */
/* rather than deleting keys from a copy, is what makes that a compile-  */
/* time guarantee instead of a runtime "don't forget to strip X" rule.   */
/* ------------------------------------------------------------------ */
type PublicItem = { text: string } | null;

function publicItem(item: PatientSummary.Item | null): PublicItem {
  return item ? { text: item.text } : null;
}

function publicItems(items: PatientSummary.Item[]): { text: string }[] {
  return items.map((i) => ({ text: i.text }));
}

function publicMedication(m: PatientSummary.Medication) {
  return { name: m.name, dose: m.dose, frequency: m.frequency, duration: m.duration, purpose: m.purpose };
}

function toPatientView(draft: PatientSummary.PatientSummaryDraft) {
  return {
    outputLanguage: draft.output_language,
    reasonForVisit: publicItem(draft.reason_for_visit),
    discussed: publicItems(draft.discussed),
    examinedOrTested: publicItems(draft.examined_or_tested),
    clinicianAssessment: publicItem(draft.clinician_assessment),
    plan: {
      medication: draft.plan.medication.map(publicMedication),
      testsOrdered: publicItems(draft.plan.tests_ordered),
      referrals: publicItems(draft.plan.referrals),
      selfCare: publicItems(draft.plan.self_care),
    },
    followUp: publicItem(draft.follow_up),
    safetyNetting: publicItem(draft.safety_netting),
    questionsAnswered: draft.questions_answered.map((q) => ({ question: q.question, answer: q.answer })),
  };
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const connection = await getPublicConnection(params.connectionId!);
  if (!connection) throw data("This booking page isn't available.", { status: 404 });

  const settings = await CoreSettings.getSettings(connection.shop, connection.platform);
  const vocab = vocabFor(settings.preset);

  // Bookings.summaryUrl() builds exactly this query param
  // (?getbooqin_summary={{booking.uid}}) — same tokened, no-login pattern
  // as manageUrl()/getbooqin_booking right below, addressed by the
  // booking's own uid since there's no separate per-summary token (see
  // core/src/booking/consultationSummary.ts's getForBooking(), which
  // always resolves "the current summary for this booking"). Clinic
  // preset only, and only once a summary has actually been sent — a
  // draft/under_review/approved row (still under clinician review) must
  // never be reachable here.
  const summaryUid = new URL(request.url).searchParams.get("getbooqin_summary");
  if (summaryUid) {
    if (settings.preset !== "clinic" || !FeatureFlags.VISIT_SUMMARIES_ENABLED || !settings.visit_summaries_enabled) {
      throw data("This page isn't available.", { status: 404 });
    }

    const booking = await Bookings.getByUid(connection.shop, summaryUid);
    if (!booking) throw data("That summary couldn't be found.", { status: 404 });

    const row = await ConsultationSummary.getForBooking({
      shop: connection.shop,
      platform: connection.platform,
      bookingId: booking.id,
    });
    if (!row || row.status !== "sent") {
      throw data("This visit summary isn't available yet.", { status: 404 });
    }

    const resource = await Data.resource(connection.shop, booking.resourceId);
    const edited = ConsultationSummary.parseEditedJson(row);

    return {
      mode: "summary" as const,
      businessName: settings.business_name,
      patient: toPatientView(edited),
      reviewer: { name: resource?.name ?? "" },
      approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    };
  }

  // Bookings.manageUrl() builds exactly this query param — this is the link
  // a (now-fixed) confirmation/cancel email points customers back to.
  const uid = new URL(request.url).searchParams.get("getbooqin_booking");
  if (uid) {
    const booking = await Bookings.getByUid(connection.shop, uid);
    if (!booking) throw data("That booking couldn't be found.", { status: 404 });
    const [service, resource] = await Promise.all([
      Data.catalogService(connection.shop, booking.serviceId),
      Data.resource(connection.shop, booking.resourceId),
    ]);
    return {
      mode: "manage" as const,
      businessName: settings.business_name,
      vocab,
      booking: {
        uid: booking.uid,
        status: booking.status,
        serviceName: service?.name ?? "",
        resourceName: resource?.name ?? "",
        when: formatInZone(booking.startUtc, Bookings.displayTz(booking, settings.timezone)),
        priceLabel: booking.price > 0 ? `${settings.currency_symbol}${booking.price.toFixed(2)}` : "",
      },
      canCancel: Bookings.customerCanCancel(booking, settings),
    };
  }

  const [services, resources, hours] = await Promise.all([
    Data.catalogServices(connection.shop, connection.platform),
    Data.resources(connection.shop, connection.platform),
    Data.businessHours(connection.shop, connection.platform),
  ]);

  return {
    mode: "book" as const,
    connectionId: connection.id,
    businessName: settings.business_name,
    businessHours: formatBusinessHours(hours),
    vocab,
    settings: publicSettings(settings),
    services: services.map((s) => ({ id: s.id, name: s.name, durationMin: s.durationMin, price: s.price, description: s.description })),
    // title/description/avatarUrl back the "Choose who you'd like to see"
    // step (Defect Dossier's BQ-33 finding) — previously dropped down to
    // just {id, name}, so a resource's own profile never reached the page.
    resources: resources.map((r) => ({ id: r.id, name: r.name, title: r.title, description: r.description ?? "", avatarUrl: r.avatarUrl })),
  };
}

function sanitizeCustomFields(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof key === "string" && (typeof value === "string" || typeof value === "number")) {
      out[key] = String(value).slice(0, 2000);
    }
  }
  return out;
}

async function handleBook(connectionId: string, request: Request, form: FormData) {
  const connection = await getPublicConnection(connectionId);
  if (!connection) return { error: "This booking page isn't available." };

  // Honeypot: real customers never fill this in — named so browser autofill
  // never volunteers a value into it, same convention as the Shopify widget's
  // App Proxy route. Silently "succeeds" from the caller's point of view
  // rather than surfacing an error a bot would learn from.
  if (String(form.get("hp_company") || "").trim() !== "") {
    return { spam: true };
  }

  try {
    throttle(`book:${connectionId}:${clientIp(request)}`, 8);

    const settings = await CoreSettings.getSettings(connection.shop, connection.platform);
    const intakeValues: Record<string, string> = {};
    for (const field of settings.intake_fields) {
      intakeValues[field.key] = String(form.get(`intake_${field.key}`) || "");
    }

    // Mirrors the client-side check in DetailsForm — required-phone is
    // business configuration, so a request that skips (or defeats) the
    // client check must still be rejected server-side with the same
    // field-level shape the form knows how to render (Defect Dossier's
    // BQ-24 finding, item 4).
    const fieldErrors = contactFieldErrors(
      {
        first_name: String(form.get("first_name") || ""),
        email: String(form.get("email") || ""),
        phone: String(form.get("phone") || ""),
      },
      settings.require_phone
    );
    for (const field of settings.intake_fields) {
      if (field.required && !intakeValues[field.key]?.trim()) {
        fieldErrors[`intake_${field.key}`] = `Enter ${field.label.toLowerCase()}.`;
      }
    }
    if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

    const booking = await Bookings.create(connection.shop, connection.platform, settings.timezone, {
      service_id: Number(form.get("service_id") || 0),
      resource_id: Number(form.get("resource_id") || 0) || undefined,
      date: String(form.get("date") || ""),
      time: String(form.get("time") || ""),
      first_name: String(form.get("first_name") || ""),
      last_name: String(form.get("last_name") || ""),
      email: String(form.get("email") || ""),
      phone: String(form.get("phone") || ""),
      notes: String(form.get("notes") || ""),
      custom_fields: sanitizeCustomFields(intakeValues),
      source: "form",
    });

    const [service, resource] = await Promise.all([
      Data.catalogService(connection.shop, booking.serviceId),
      Data.resource(connection.shop, booking.resourceId),
    ]);

    return {
      booking: {
        uid: booking.uid,
        status: booking.status,
        serviceName: service?.name ?? "",
        resourceName: resource?.name ?? "",
        when: formatInZone(booking.startUtc, Bookings.displayTz(booking, settings.timezone)),
        startIso: booking.startUtc.toISOString(),
        endIso: booking.endUtc.toISOString(),
        // Payment collection isn't built into this page yet — but the
        // confirmation shouldn't claim "you're booked" outright when the
        // service actually requires payment the merchant has to chase down
        // themselves (Bookings.needsPayment reads this straight off the row).
        needsPayment: Bookings.needsPayment(booking),
        // The confirmation used to say "confirmed" and "a confirmation has
        // been sent" regardless of actual status, and gave a customer whose
        // settings allow cancelling no way to act on it — no reference, no
        // manage link, no cutoff, no calendar file (Defect Dossier's BQ-28
        // finding).
        canCancel: Bookings.customerCanCancel(booking, settings),
        cancelCutoffHours: settings.cancel_cutoff_hours,
      },
    };
  } catch (err) {
    if (isGetBooqinError(err)) return { error: err.message, code: err.code };
    throw err;
  }
}

async function handleCancel(connectionId: string, request: Request, form: FormData) {
  const connection = await getPublicConnection(connectionId);
  if (!connection) return { error: "This booking page isn't available." };

  try {
    throttle(`manage:${connectionId}:${clientIp(request)}`, 8);

    const uid = String(form.get("uid") || "");
    const booking = await Bookings.getByUid(connection.shop, uid);
    if (!booking) return { error: "That booking couldn't be found." };

    const settings = await CoreSettings.getSettings(connection.shop, connection.platform);
    if (!Bookings.customerCanCancel(booking, settings)) {
      return { error: "This booking can no longer be cancelled here — please contact the business directly." };
    }

    await Bookings.setStatus(connection.shop, booking.id, "cancelled", "cancelled by customer");
    return { cancelled: true };
  } catch (err) {
    if (isGetBooqinError(err)) return { error: err.message, code: err.code };
    throw err;
  }
}

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "POST") return { error: "Method not allowed." };
  const form = await request.formData();
  const intent = String(form.get("_intent") || "");
  const connectionId = params.connectionId!;

  if (intent === "book") return handleBook(connectionId, request, form);
  if (intent === "cancel") return handleCancel(connectionId, request, form);
  return { error: "Unknown request." };
}

/* ================================================================== */

function Shell({ businessName, children }: { businessName: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center bg-canvas px-4 py-8 sm:px-8">
      <div className="flex w-full max-w-[480px] flex-col gap-5">
        <div className="flex items-center gap-[10px]">
          <LogoMark size={26} />
          <span className="min-w-0 truncate text-[15px] font-semibold">{businessName}</span>
        </div>
        {children}
        <p className="mt-2 text-center text-[11.5px] text-subtle">Booking powered by GetBooqin</p>
      </div>
    </div>
  );
}

export default function BookingPage({ loaderData, params }: Route.ComponentProps) {
  if (loaderData.mode === "manage") {
    return <ManageBooking connectionId={params.connectionId!} businessName={loaderData.businessName} vocab={loaderData.vocab} initial={loaderData.booking} canCancelInitial={loaderData.canCancel} />;
  }
  if (loaderData.mode === "summary") {
    return <PatientSummaryView loaderData={loaderData} />;
  }
  return <BookingFlow loaderData={loaderData} />;
}

/* ---------------------------------------------------- Visit summary view */

type SummaryLoaderData = Extract<Route.ComponentProps["loaderData"], { mode: "summary" }>;

function PatientSummaryView({ loaderData }: { loaderData: SummaryLoaderData }) {
  const { businessName, patient, reviewer, approvedAt } = loaderData;
  const isNl = patient.outputLanguage === "nl";
  const lang = isNl ? "nl" : "en";
  const reviewerName = reviewer.name || (isNl ? "uw zorgverlener" : "your clinician");
  const dateLabel = approvedAt
    ? new Intl.DateTimeFormat(isNl ? "nl-NL" : "en-GB", { dateStyle: "long" }).format(new Date(approvedAt))
    : "";

  const planCount =
    patient.plan.medication.length + patient.plan.testsOrdered.length + patient.plan.referrals.length + patient.plan.selfCare.length;

  return (
    <Shell businessName={businessName}>
      <div className="card p-[18px]" lang={lang}>
        <h1 className="ob-h1 mb-3">{isNl ? "Uw bezoeksamenvatting" : "Your visit summary"}</h1>

        {/* Trust banner (plan Part 3 §5) — prominent, not fine print like
            book page's own consent_text styling. */}
        <div className="mb-4 rounded-[10px] border border-brand-200 bg-brand-50 px-[15px] py-[13px]">
          <p className="m-0 text-[13px] font-medium text-ink">
            {isNl
              ? `Deze samenvatting is met AI-hulp opgesteld op basis van uw gesprek, en gecontroleerd en goedgekeurd door ${reviewerName}${dateLabel ? ` op ${dateLabel}` : ""}.`
              : `This summary was drafted with AI assistance based on your visit, and reviewed and approved by ${reviewerName}${dateLabel ? ` on ${dateLabel}` : ""}.`}
          </p>
        </div>

        <div className="flex flex-col gap-4 text-body">
          <PatientField label={isNl ? "Reden van uw bezoek" : "Reason for your visit"} item={patient.reasonForVisit} />
          <PatientList label={isNl ? "Wat we hebben besproken" : "What we discussed"} items={patient.discussed} />
          <PatientList label={isNl ? "Onderzoeken" : "Examinations & tests"} items={patient.examinedOrTested} />
          <PatientField label={isNl ? "Beoordeling van de arts" : "Doctor's assessment"} item={patient.clinicianAssessment} />

          {planCount > 0 && (
            <div>
              <h2 className="mb-2 text-[14px] font-semibold">Plan</h2>
              <div className="flex flex-col gap-3">
                {patient.plan.medication.length > 0 && (
                  <div>
                    <h3 className="mb-1 text-[12.5px] font-semibold text-ink-2">{isNl ? "Medicatie" : "Medication"}</h3>
                    <ul className="m-0 flex list-none flex-col gap-2 p-0">
                      {patient.plan.medication.map((m, i) => (
                        <li key={i} className="rounded-[8px] border border-line px-3 py-2">
                          <div className="font-medium">{m.name}</div>
                          {(m.dose || m.frequency || m.duration) && (
                            <div className="text-[12.5px] text-muted">{[m.dose, m.frequency, m.duration].filter(Boolean).join(" · ")}</div>
                          )}
                          {m.purpose && <div className="text-[12.5px] text-muted">{m.purpose}</div>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <PatientList label={isNl ? "Onderzoeken aangevraagd" : "Tests ordered"} items={patient.plan.testsOrdered} bare />
                <PatientList label={isNl ? "Doorverwijzingen" : "Referrals"} items={patient.plan.referrals} bare />
                <PatientList label={isNl ? "Zelfzorg" : "Self-care"} items={patient.plan.selfCare} bare />
              </div>
            </div>
          )}

          <PatientField label={isNl ? "Vervolgafspraak" : "Follow-up"} item={patient.followUp} />
          <PatientField label={isNl ? "Wanneer contact opnemen" : "When to seek help"} item={patient.safetyNetting} />

          {patient.questionsAnswered.length > 0 && (
            <div>
              <h2 className="mb-2 text-[14px] font-semibold">{isNl ? "Uw vragen" : "Questions you asked"}</h2>
              <div className="flex flex-col gap-2">
                {patient.questionsAnswered.map((q, i) => (
                  <div key={i} className="rounded-[8px] border border-line px-3 py-2">
                    <div className="font-medium">{q.question}</div>
                    <div className="text-muted">{q.answer}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      <p className="text-center text-body text-muted">
        {isNl
          ? `Vragen over deze samenvatting? Neem rechtstreeks contact op met ${businessName}.`
          : `Questions about this summary? Contact ${businessName} directly.`}
      </p>
    </Shell>
  );
}

function PatientField({ label, item }: { label: string; item: PublicItem }) {
  if (!item) return null;
  return (
    <div>
      <h2 className="mb-1 text-[14px] font-semibold">{label}</h2>
      <p className="m-0 whitespace-pre-wrap">{item.text}</p>
    </div>
  );
}

function PatientList({ label, items, bare = false }: { label: string; items: { text: string }[]; bare?: boolean }) {
  if (items.length === 0) return null;
  return (
    <div>
      {bare ? (
        <h3 className="mb-1 text-[12.5px] font-semibold text-ink-2">{label}</h3>
      ) : (
        <h2 className="mb-1 text-[14px] font-semibold">{label}</h2>
      )}
      <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
        {items.map((it, i) => (
          <li key={i}>{it.text}</li>
        ))}
      </ul>
    </div>
  );
}

/* ---------------------------------------------------------- Manage view */

function ManageBooking({
  connectionId, businessName, vocab, initial, canCancelInitial,
}: {
  connectionId: string;
  businessName: string;
  vocab: ReturnType<typeof vocabFor>;
  initial: { uid: string; status: string; serviceName: string; resourceName: string; when: string; priceLabel: string };
  canCancelInitial: boolean;
}) {
  const fetcher = useFetcher<{ cancelled?: boolean; error?: string }>();
  const cancelled = fetcher.data?.cancelled || initial.status === "cancelled";
  const canCancel = canCancelInitial && !cancelled;

  return (
    <Shell businessName={businessName}>
      <div className="card p-[18px]">
        <h1 className="ob-h1 mb-1">Your {vocab.bookingOne}</h1>
        {fetcher.data?.error && <AlertError className="mb-3">{fetcher.data.error}</AlertError>}
        <div className="flex flex-col gap-[6px] text-body">
          <span className="font-medium">{initial.serviceName}</span>
          {initial.resourceName && <span className="text-muted">with {initial.resourceName}</span>}
          <span className="text-muted">{initial.when}</span>
          {initial.priceLabel && <span className="text-muted">{initial.priceLabel}</span>}
          {/* Shares the dashboard's own Badge/status colour map instead of
              a bespoke chip here — the bespoke one only ever distinguished
              cancelled-vs-not, so "Pending confirmation" rendered in the
              same green as "Confirmed" (Defect Dossier's R2-06 finding). */}
          <span className="mt-1 w-fit">
            <Badge status={cancelled ? "cancelled" : (initial.status as "pending" | "confirmed")} label={cancelled ? "Cancelled" : initial.status === "pending" ? "Pending confirmation" : "Confirmed"} />
          </span>
        </div>
        {canCancel && (
          <button
            type="button"
            className="btn-sec mt-4 w-full justify-center"
            onClick={() => (document.getElementById("cancel-booking") as HTMLDialogElement | null)?.showModal()}
          >
            Cancel this {vocab.bookingOne}
          </button>
        )}
      </div>
      <p className="text-center text-body text-muted">
        Need to change the time instead? Contact {businessName} directly.
      </p>

      {canCancel && (
        <ConfirmDialog
          id="cancel-booking"
          title={`Cancel your ${initial.serviceName} on ${initial.when}?`}
          body="This can't be undone. We'll let the business know."
          confirmLabel={`Cancel ${vocab.bookingOne}`}
          cancelLabel={`Keep ${vocab.bookingOne}`}
        >
          <fetcher.Form method="post" id="cancel-booking-form">
            <input type="hidden" name="_intent" value="cancel" />
            <input type="hidden" name="uid" value={initial.uid} />
          </fetcher.Form>
        </ConfirmDialog>
      )}
    </Shell>
  );
}

/* ----------------------------------------------------------- Booking flow */

type BookLoaderData = Extract<Route.ComponentProps["loaderData"], { mode: "book" }>;

type Step = "service" | "resource" | "time" | "details" | "confirm";

// Persistent "what you're booking" line, shown from the moment a service
// is picked through the details step — previously nothing named the
// service until the very last ("Choose a time") or success screen, and
// the "Your details" step named neither service, date nor time at all (UX
// audit's #10 finding). Doubles as the review-before-submit summary when
// it renders at the top of the details form.
function SummaryBar({
  service, date, time, timezone,
}: { service: { name: string; durationMin: number } | null; date: string; time: string; timezone: string }) {
  if (!service) return null;
  // Used to have its own bespoke date/zone-abbreviation formatting here,
  // duplicating (and, for the zone abbreviation, less carefully than) the
  // one true formatInZone used everywhere else — including the same
  // locale-dependent "GMT+2" vs "CEST" bug, now fixed at the source
  // (Defect Dossier's BQ-10 finding). date/time are the wall-clock values
  // the customer just picked in the business's own zone, so they round-trip
  // through wallClockToUtc first to get a real instant formatInZone can work
  // from.
  const when = date && time ? formatInZone(wallClockToUtc(`${date}T${time}`, timezone), timezone, "EEE d LLL yyyy, HH:mm") : null;
  return (
    <p className="mb-3 text-[12.5px] font-medium text-subtle">
      {service.name} · {service.durationMin} min{when ? ` · ${when}` : ""}
    </p>
  );
}

function BookingFlow({ loaderData }: { loaderData: BookLoaderData }) {
  const { connectionId, businessName, businessHours, vocab, settings, services, resources } = loaderData;
  const [step, setStep] = useState<Step>("service");
  const [serviceId, setServiceId] = useState<number | null>(null);
  const [resourceId, setResourceId] = useState<number>(0);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");

  // Computed post-mount, not during render — the server has no idea what
  // timezone the visitor is in, so an SSR-computed "today" (in the server's
  // own timezone) could disagree with the visitor's actual local date and
  // wrongly block them from picking it. `Bookings.create`'s own
  // min_notice_hours check is what actually enforces this server-side;
  // this is only ever a picker hint.
  const [dateMin, setDateMin] = useState<string | undefined>(undefined);
  useEffect(() => {
    const now = new Date();
    setDateMin(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`);
  }, []);

  const daysFetcher = useFetcher<{ mode: "days"; days: { date: string; label: string; count: number }[]; unbookable: boolean }>();
  const slotsFetcher = useFetcher<{ mode: "slots"; slots: { time: string; label: string }[] }>();
  const bookFetcher = useFetcher<{
    error?: string;
    code?: string;
    spam?: boolean;
    fieldErrors?: Record<string, string>;
    booking?: {
      uid: string;
      status: string;
      serviceName: string;
      resourceName: string;
      when: string;
      startIso: string;
      endIso: string;
      needsPayment: boolean;
      canCancel: boolean;
      cancelCutoffHours: number;
    };
  }>();

  const service = services.find((s) => s.id === serviceId) ?? null;

  function pickService(id: number) {
    setServiceId(id);
    setResourceId(0);
    setDate("");
    setTime("");
    setStep(resources.length <= 1 ? "time" : "resource");
  }

  function pickResource(id: number) {
    setResourceId(id);
    setDate("");
    setTime("");
    setStep("time");
  }

  // Entering the time step with no date yet: ask which of the next few days
  // actually have openings, so the page doesn't default to "today" and show
  // an empty list for a business that's closed today.
  useEffect(() => {
    if (step !== "time" || date || !serviceId) return;
    daysFetcher.load(`/book/${connectionId}/slots?service_id=${serviceId}&resource_id=${resourceId}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, serviceId, resourceId]);

  useEffect(() => {
    if (!date || !serviceId) return;
    slotsFetcher.load(`/book/${connectionId}/slots?service_id=${serviceId}&resource_id=${resourceId}&date=${date}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, serviceId, resourceId]);

  // The one error real customers actually hit in normal use (two people
  // booking near-simultaneously) — re-pull the slot list for the date
  // they're on instead of leaving a now-stale "available" button up.
  useEffect(() => {
    if (bookFetcher.data?.code === "getbooqin_slot_taken" && date && serviceId) {
      setTime("");
      slotsFetcher.load(`/book/${connectionId}/slots?service_id=${serviceId}&resource_id=${resourceId}&date=${date}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookFetcher.data]);

  if (bookFetcher.data?.booking) {
    return <Confirmation connectionId={connectionId} businessName={businessName} vocab={vocab} booking={bookFetcher.data.booking} />;
  }

  return (
    <Shell businessName={businessName}>
      {step === "service" && (
        <div className="card p-[18px]">
          {/* Business header — name, one-line description, address, phone,
              opening hours. The page previously showed only the name and a
              bare list of service durations, none of this already-
              collected business context (Defect Dossier's BQ-33 finding). */}
          <h1 className="ob-h1 mb-1">Book with {businessName}</h1>
          {settings.businessDescription && <p className="m-0 mb-2 text-body text-muted">{settings.businessDescription}</p>}
          {(settings.businessAddress || settings.businessPhone || businessHours) && (
            <div className="mb-3 flex flex-col gap-[2px] text-[12.5px] text-subtle">
              {settings.businessAddress && <span>{settings.businessAddress}</span>}
              {settings.businessPhone && <span>{settings.businessPhone}</span>}
              {businessHours && <span>{businessHours}</span>}
            </div>
          )}
          <div className="flex flex-col gap-2">
            {services.length === 0 && <p className="text-body text-muted">No {vocab.services.toLowerCase()} are available to book right now.</p>}
            {services.map((s) => (
              <button key={s.id} type="button" className="tile flex-col items-stretch gap-[2px] text-left" onClick={() => pickService(s.id)}>
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-body font-medium">{s.name}</span>
                  <span className="ml-auto shrink-0 text-[12px] text-subtle">
                    {s.durationMin} min{s.price > 0 ? ` · ${settings.currencySymbol}${s.price.toFixed(2)}` : ""}
                  </span>
                </div>
                {s.description && <span className="text-[12px] font-normal text-subtle">{s.description}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {step === "resource" && service && (
        <div className="card p-[18px]">
          <h1 className="ob-h1 mb-1">Choose who you'd like to see</h1>
          <SummaryBar service={service} date={date} time={time} timezone={settings.timezone} />
          <div className="flex flex-col gap-2">
            <button type="button" className="tile justify-between text-left" onClick={() => pickResource(0)}>
              <span className="text-body font-medium">Any {vocab.resourceOne}</span>
            </button>
            {/* Name, title, photo and description — this used to be a bare
                name button, with a resource's own profile (already
                collected on their own record) never reaching the page
                (Defect Dossier's BQ-33 finding). */}
            {resources.map((r) => (
              <button key={r.id} type="button" className="tile items-start gap-3 text-left" onClick={() => pickResource(r.id)}>
                <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-50 text-[13px] font-semibold text-brand-600">
                  {r.avatarUrl ? (
                    <img src={r.avatarUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    r.name.slice(0, 1).toUpperCase()
                  )}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-body font-medium">
                    {r.name}
                    {r.title ? <span className="font-normal text-subtle"> · {r.title}</span> : null}
                  </span>
                  {r.description && <span className="text-[12px] text-subtle">{r.description}</span>}
                </span>
              </button>
            ))}
          </div>
          <button type="button" className="btn-ghost mt-3" onClick={() => setStep("service")}>&larr; Back</button>
        </div>
      )}

      {step === "time" && service && (
        <div className="card p-[18px]">
          <h1 className="ob-h1 mb-1">Choose a time</h1>
          <SummaryBar service={service} date={date} time={time} timezone={settings.timezone} />
          {service.description && <p className="mb-3 mt-[-6px] text-[12.5px] text-muted">{service.description}</p>}

          {/* Kept visible after a date is chosen instead of disappearing —
              a client picking one date had no way back to the quick-pick
              list except starting the step over (Defect Dossier's BQ-33
              finding, item 4). The picked day stays highlighted among the
              others. */}
          <span className="field-label mb-2 block">Next available</span>
          <div className="flex flex-col gap-2">
            {daysFetcher.data?.mode === "days" && daysFetcher.data.days.length === 0 && (
              <p className="text-body text-muted">
                {daysFetcher.data.unbookable
                  ? // Zero candidate resources, not zero open slots — no
                    // amount of "check back later" would ever help here
                    // (Defect Dossier's R2-04 finding, item 4).
                    `This isn't bookable online right now — please call us${settings.businessPhone ? ` at ${settings.businessPhone}` : ""}.`
                  : "No openings in the next few weeks — try again later."}
              </p>
            )}
            {daysFetcher.data?.mode === "days" &&
              daysFetcher.data.days.map((d) => (
                <button
                  key={d.date}
                  type="button"
                  className={`tile justify-between text-left ${date === d.date ? "tile-on" : ""}`}
                  onClick={() => { setDate(d.date); setTime(""); }}
                >
                  <span className="text-body font-medium">{d.label}</span>
                  <span className="ml-auto text-[12px] text-subtle">{d.count} open</span>
                </button>
              ))}
          </div>

          <Field label="Or pick a specific date">
            <Input type="date" value={date} onChange={(e) => { setDate(e.target.value); setTime(""); }} min={dateMin} />
          </Field>

          {date && (
            <div className="mt-3 flex flex-col gap-2">
              {/* Timezone shown on the slot grid itself, not just the final
                  summary — a client on the other side of the world from
                  the business had no signal these times weren't already
                  theirs (Defect Dossier's BQ-33 finding, item 5 / BQ-10). */}
              {slotsFetcher.data?.mode === "slots" && slotsFetcher.data.slots.length > 0 && (
                <span className="text-[11.5px] text-subtle">Times shown in {zoneAbbr(new Date(), settings.timezone)}</span>
              )}
              {slotsFetcher.data?.mode === "slots" && slotsFetcher.data.slots.length === 0 && (
                <p className="text-body text-muted">No open times that day — try another date.</p>
              )}
              {slotsFetcher.data?.mode === "slots" && (
                <div className="grid grid-cols-3 gap-2">
                  {slotsFetcher.data.slots.map((s) => (
                    <button
                      key={s.time}
                      type="button"
                      className={`tile justify-center ${time === s.time ? "tile-on" : ""}`}
                      onClick={() => setTime(s.time)}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="mt-4 flex justify-between">
            <button type="button" className="btn-ghost" onClick={() => setStep(resources.length <= 1 ? "service" : "resource")}>&larr; Back</button>
            <button type="button" className="btn-pri" disabled={!time} onClick={() => setStep("details")}>Continue</button>
          </div>
        </div>
      )}

      {step === "details" && service && (
        <DetailsForm
          connectionId={connectionId}
          vocab={vocab}
          settings={settings}
          service={service}
          resourceId={resourceId}
          date={date}
          time={time}
          fetcher={bookFetcher}
          onBack={() => setStep("time")}
        />
      )}
    </Shell>
  );
}

function DetailsForm({
  connectionId, vocab, settings, service, resourceId, date, time, fetcher, onBack,
}: {
  connectionId: string;
  vocab: ReturnType<typeof vocabFor>;
  settings: BookLoaderData["settings"];
  service: { id: number; name: string; durationMin: number };
  resourceId: number;
  date: string;
  time: string;
  fetcher: ReturnType<typeof useFetcher<{ error?: string; spam?: boolean; fieldErrors?: Record<string, string> }>>;
  onBack: () => void;
}) {
  const submitting = fetcher.state !== "idle";
  const [errors, setErrors] = useState<Record<string, string>>({});

  // The server mirrors the same checks (required-phone is business
  // configuration a bypassed client check could miss), so a submit that
  // reaches it and comes back with fieldErrors still needs to render them.
  useEffect(() => {
    if (fetcher.data?.fieldErrors) setErrors(fetcher.data.fieldErrors);
  }, [fetcher.data]);

  function clearError(name: string) {
    setErrors((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    const form = new FormData(event.currentTarget);
    const next = contactFieldErrors(
      {
        first_name: String(form.get("first_name") || ""),
        email: String(form.get("email") || ""),
        phone: String(form.get("phone") || ""),
      },
      settings.requirePhone
    );
    for (const f of settings.intakeFields) {
      if (f.required && !String(form.get(`intake_${f.key}`) || "").trim()) {
        next[`intake_${f.key}`] = `Enter ${f.label.toLowerCase()}.`;
      }
    }
    if (Object.keys(next).length > 0) {
      event.preventDefault();
      setErrors(next);
    }
  }

  return (
    <div className="card p-[18px]">
      <h1 className="ob-h1 mb-1">Your details</h1>
      <SummaryBar service={service} date={date} time={time} timezone={settings.timezone} />
      {fetcher.data?.error && <AlertError className="mb-3">{fetcher.data.error}</AlertError>}
      <div className="mb-3"><FormErrorSummary errors={errors} /></div>
      <fetcher.Form method="post" className="flex flex-col gap-[14px]" onSubmit={handleSubmit} noValidate>
        <input type="hidden" name="_intent" value="book" />
        <input type="hidden" name="service_id" value={service.id} />
        <input type="hidden" name="resource_id" value={resourceId} />
        <input type="hidden" name="date" value={date} />
        <input type="hidden" name="time" value={time} />
        {/* Honeypot — real customers never see or fill this in. */}
        <input type="text" name="hp_company" tabIndex={-1} autoComplete="off" className="sr-only" aria-hidden="true" />

        <div className="grid grid-cols-2 gap-x-4 gap-y-[14px]">
          <Field label="First name" required error={errors.first_name}>
            <Input id="first_name" name="first_name" required autoComplete="given-name" onChange={() => clearError("first_name")} />
          </Field>
          <Field label="Last name">
            <Input id="last_name" name="last_name" autoComplete="family-name" />
          </Field>
        </div>
        <Field label="Email" required error={errors.email}>
          <Input id="email" type="email" name="email" required autoComplete="email" onChange={() => clearError("email")} />
        </Field>
        <Field label="Phone" required={settings.requirePhone} error={errors.phone}>
          <Input id="phone" type="tel" name="phone" required={settings.requirePhone} autoComplete="tel" onChange={() => clearError("phone")} />
        </Field>
        {settings.intakeFields.map((f) => (
          <Field key={f.key} label={f.label} required={f.required} error={errors[`intake_${f.key}`]}>
            {f.type === "textarea" ? (
              <textarea
                id={`intake_${f.key}`}
                name={`intake_${f.key}`}
                required={f.required}
                className="input min-h-[80px]"
                onChange={() => clearError(`intake_${f.key}`)}
              />
            ) : (
              <Input
                id={`intake_${f.key}`}
                type={f.type === "phone" ? "tel" : f.type}
                required={f.required}
                name={`intake_${f.key}`}
                onChange={() => clearError(`intake_${f.key}`)}
              />
            )}
          </Field>
        ))}
        <Field label="Notes"><textarea name="notes" className="input min-h-[70px]" /></Field>

        {settings.consentText && <p className="m-0 text-[11.5px] text-subtle">{settings.consentText}</p>}

        <div className="mt-1 flex justify-between">
          <button type="button" className="btn-ghost" onClick={onBack} disabled={submitting}>&larr; Back</button>
          <button type="submit" className="btn-pri" disabled={submitting}>
            {submitting ? "Booking…" : `Confirm ${vocab.bookingOne}`}
          </button>
        </div>
      </fetcher.Form>
    </div>
  );
}

// yyyymmddThhmmssZ — the one datetime format the .ics spec allows for a
// UTC-anchored DTSTART/DTEND/DTSTAMP.
function icsStamp(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function icsDataUrl(booking: { uid: string; serviceName: string; resourceName: string; startIso: string; endIso: string }, businessName: string): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//GetBooqin//Booking//EN",
    "BEGIN:VEVENT",
    `UID:${booking.uid}@getbooqin`,
    `DTSTAMP:${icsStamp(new Date().toISOString())}`,
    `DTSTART:${icsStamp(booking.startIso)}`,
    `DTEND:${icsStamp(booking.endIso)}`,
    `SUMMARY:${booking.serviceName}${booking.resourceName ? ` with ${booking.resourceName}` : ""}`,
    `DESCRIPTION:Booked with ${businessName}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(lines.join("\r\n"))}`;
}

function Confirmation({
  connectionId, businessName, vocab, booking,
}: {
  connectionId: string;
  businessName: string;
  vocab: ReturnType<typeof vocabFor>;
  booking: {
    uid: string;
    status: string;
    serviceName: string;
    resourceName: string;
    when: string;
    startIso: string;
    endIso: string;
    needsPayment: boolean;
    canCancel: boolean;
    cancelCutoffHours: number;
  };
}) {
  const bookingRef = booking.uid.slice(-6).toUpperCase();
  const manageUrl = `/book/${connectionId}?getbooqin_booking=${booking.uid}`;
  return (
    <Shell businessName={businessName}>
      <div className="card p-[18px] text-center">
        <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-ok-bg text-[20px] text-ok">✓</span>
        <h1 className="ob-h1 mb-1">
          {booking.status === "pending" ? `Request sent` : `You're booked!`}
        </h1>
        <p className="m-0 text-body text-muted">
          {booking.serviceName}{booking.resourceName ? ` with ${booking.resourceName}` : ""} — {booking.when}
        </p>
        <p className="mt-1 text-[12px] text-subtle">Reference #{bookingRef}</p>
        {booking.status === "pending" && (
          <p className="mt-2 text-body text-muted">{businessName} will confirm this {vocab.bookingOne} shortly.</p>
        )}
        {booking.needsPayment && (
          <p className="mt-2 text-body text-muted">{businessName} will be in touch about payment for this {vocab.bookingOne}.</p>
        )}
        {/* Nothing is actually confirmed yet on a pending request — the
            copy used to claim a confirmation had been sent regardless of
            status (Defect Dossier's BQ-28 finding, item 1). */}
        <p className="mt-3 text-[12px] text-subtle">
          {booking.status === "pending"
            ? "We've emailed you a copy of this request."
            : "A confirmation has been sent to your email."}
        </p>

        <div className="mt-4 flex flex-col items-center gap-2 border-t border-line pt-4">
          {/* The manage page only ever offered Cancel — no self-service
              reschedule exists yet — so this promised more than the page
              could deliver (Defect Dossier's R2-06 finding). */}
          <a href={manageUrl} className="btn-sec no-underline hover:no-underline">
            View or cancel this {vocab.bookingOne}
          </a>
          {booking.canCancel && (
            <p className="m-0 text-[12px] text-subtle">
              You can cancel up to {booking.cancelCutoffHours}h before.
            </p>
          )}
          <a
            href={icsDataUrl(booking, businessName)}
            download={`${booking.serviceName || vocab.bookingOne}.ics`}
            className="btn-link text-brand-600"
          >
            + Add to calendar
          </a>
        </div>
      </div>
    </Shell>
  );
}
