import { useEffect, useState } from "react";
import { data, useFetcher } from "react-router";
import type { Route } from "./+types/book.$connectionId";
import {
  Data,
  Bookings,
  Settings as CoreSettings,
  getPublicConnection,
  isGetBooqinError,
} from "getbooqin-core";
import { vocabFor } from "~/lib/presets";
import { AlertError, Field, Input } from "~/components/ui";
import { LogoMark } from "~/components/onboarding";
import { throttle, clientIp } from "~/lib/http.server";

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
    currencySymbol: settings.currency_symbol,
    timezone: settings.timezone,
    requirePhone: settings.require_phone,
    intakeFields: settings.intake_fields,
    allowCancel: settings.allow_cancel,
    consentText: settings.consent_text,
  };
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const connection = await getPublicConnection(params.connectionId!);
  if (!connection) throw data("This booking page isn't available.", { status: 404 });

  const settings = await CoreSettings.getSettings(connection.shop, connection.platform);
  const vocab = vocabFor(settings.preset);

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
        date: Bookings.localDate(booking, settings.timezone),
        time: Bookings.localTime(booking, settings.timezone),
        priceLabel: booking.price > 0 ? `${settings.currency_symbol}${booking.price.toFixed(2)}` : "",
      },
      canCancel: Bookings.customerCanCancel(booking, settings),
    };
  }

  const [services, resources] = await Promise.all([
    Data.catalogServices(connection.shop, connection.platform),
    Data.resources(connection.shop, connection.platform),
  ]);

  return {
    mode: "book" as const,
    connectionId: connection.id,
    businessName: settings.business_name,
    vocab,
    settings: publicSettings(settings),
    services: services.map((s) => ({ id: s.id, name: s.name, durationMin: s.durationMin, price: s.price, description: s.description })),
    resources: resources.map((r) => ({ id: r.id, name: r.name })),
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
        date: Bookings.localDate(booking, settings.timezone),
        time: Bookings.localTime(booking, settings.timezone),
        // Payment collection isn't built into this page yet — but the
        // confirmation shouldn't claim "you're booked" outright when the
        // service actually requires payment the merchant has to chase down
        // themselves (Bookings.needsPayment reads this straight off the row).
        needsPayment: Bookings.needsPayment(booking),
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
  return <BookingFlow loaderData={loaderData} />;
}

/* ---------------------------------------------------------- Manage view */

function ManageBooking({
  connectionId, businessName, vocab, initial, canCancelInitial,
}: {
  connectionId: string;
  businessName: string;
  vocab: ReturnType<typeof vocabFor>;
  initial: { uid: string; status: string; serviceName: string; resourceName: string; date: string; time: string; priceLabel: string };
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
          <span className="text-muted">{initial.date} at {initial.time}</span>
          {initial.priceLabel && <span className="text-muted">{initial.priceLabel}</span>}
          <span className={`mt-1 w-fit rounded-full px-[9px] py-[2px] text-[12px] font-medium ${cancelled ? "bg-neutral-bg text-neutral" : "bg-ok-bg text-ok"}`}>
            {cancelled ? "Cancelled" : initial.status === "pending" ? "Pending confirmation" : "Confirmed"}
          </span>
        </div>
        {canCancel && (
          <fetcher.Form method="post" className="mt-4">
            <input type="hidden" name="_intent" value="cancel" />
            <input type="hidden" name="uid" value={initial.uid} />
            <button type="submit" className="btn-sec w-full justify-center" disabled={fetcher.state !== "idle"}>
              {fetcher.state !== "idle" ? "Cancelling…" : `Cancel this ${vocab.bookingOne}`}
            </button>
          </fetcher.Form>
        )}
      </div>
      <p className="text-center text-body text-muted">
        Need to change the time instead? Contact {businessName} directly.
      </p>
    </Shell>
  );
}

/* ----------------------------------------------------------- Booking flow */

type BookLoaderData = Extract<Route.ComponentProps["loaderData"], { mode: "book" }>;

type Step = "service" | "resource" | "time" | "details" | "confirm";

function BookingFlow({ loaderData }: { loaderData: BookLoaderData }) {
  const { connectionId, businessName, vocab, settings, services, resources } = loaderData;
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

  const daysFetcher = useFetcher<{ mode: "days"; days: { date: string; label: string; count: number }[] }>();
  const slotsFetcher = useFetcher<{ mode: "slots"; slots: { time: string; label: string }[] }>();
  const bookFetcher = useFetcher<{ error?: string; code?: string; spam?: boolean; booking?: { uid: string; status: string; serviceName: string; resourceName: string; date: string; time: string; needsPayment: boolean } }>();

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
    return <Confirmation businessName={businessName} vocab={vocab} booking={bookFetcher.data.booking} />;
  }

  return (
    <Shell businessName={businessName}>
      {step === "service" && (
        <div className="card p-[18px]">
          <h1 className="ob-h1 mb-3">Book with {businessName}</h1>
          <div className="flex flex-col gap-2">
            {services.length === 0 && <p className="text-body text-muted">No {vocab.services.toLowerCase()} are available to book right now.</p>}
            {services.map((s) => (
              <button key={s.id} type="button" className="tile justify-between text-left" onClick={() => pickService(s.id)}>
                <span className="min-w-0 truncate text-body font-medium">{s.name}</span>
                <span className="ml-auto shrink-0 text-[12px] text-subtle">
                  {s.durationMin} min{s.price > 0 ? ` · ${settings.currencySymbol}${s.price.toFixed(2)}` : ""}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {step === "resource" && service && (
        <div className="card p-[18px]">
          <h1 className="ob-h1 mb-3">Choose a {vocab.resourceOne}</h1>
          <div className="flex flex-col gap-2">
            <button type="button" className="tile justify-between text-left" onClick={() => pickResource(0)}>
              <span className="text-body font-medium">Any {vocab.resourceOne}</span>
            </button>
            {resources.map((r) => (
              <button key={r.id} type="button" className="tile justify-between text-left" onClick={() => pickResource(r.id)}>
                <span className="text-body font-medium">{r.name}</span>
              </button>
            ))}
          </div>
          <button type="button" className="btn-ghost mt-3" onClick={() => setStep("service")}>&larr; Back</button>
        </div>
      )}

      {step === "time" && service && (
        <div className="card p-[18px]">
          <h1 className="ob-h1 mb-3">Choose a time</h1>

          {!date && (
            <>
              <span className="field-label mb-2 block">Next available</span>
              <div className="flex flex-col gap-2">
                {daysFetcher.data?.mode === "days" && daysFetcher.data.days.length === 0 && (
                  <p className="text-body text-muted">No openings in the next few weeks — try again later.</p>
                )}
                {daysFetcher.data?.mode === "days" &&
                  daysFetcher.data.days.map((d) => (
                    <button key={d.date} type="button" className="tile justify-between text-left" onClick={() => setDate(d.date)}>
                      <span className="text-body font-medium">{d.label}</span>
                      <span className="ml-auto text-[12px] text-subtle">{d.count} open</span>
                    </button>
                  ))}
              </div>
            </>
          )}

          <Field label="Or pick a specific date">
            <Input type="date" value={date} onChange={(e) => { setDate(e.target.value); setTime(""); }} min={dateMin} />
          </Field>

          {date && (
            <div className="mt-3 flex flex-col gap-2">
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
          serviceId={service.id}
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
  connectionId, vocab, settings, serviceId, resourceId, date, time, fetcher, onBack,
}: {
  connectionId: string;
  vocab: ReturnType<typeof vocabFor>;
  settings: BookLoaderData["settings"];
  serviceId: number;
  resourceId: number;
  date: string;
  time: string;
  fetcher: ReturnType<typeof useFetcher<{ error?: string; spam?: boolean }>>;
  onBack: () => void;
}) {
  const submitting = fetcher.state !== "idle";
  return (
    <div className="card p-[18px]">
      <h1 className="ob-h1 mb-3">Your details</h1>
      {fetcher.data?.error && <AlertError className="mb-3">{fetcher.data.error}</AlertError>}
      <fetcher.Form method="post" className="flex flex-col gap-[14px]">
        <input type="hidden" name="_intent" value="book" />
        <input type="hidden" name="service_id" value={serviceId} />
        <input type="hidden" name="resource_id" value={resourceId} />
        <input type="hidden" name="date" value={date} />
        <input type="hidden" name="time" value={time} />
        {/* Honeypot — real customers never see or fill this in. */}
        <input type="text" name="hp_company" tabIndex={-1} autoComplete="off" className="sr-only" aria-hidden="true" />

        <div className="grid grid-cols-2 gap-x-4 gap-y-[14px]">
          <Field label="First name"><Input name="first_name" required autoComplete="given-name" /></Field>
          <Field label="Last name"><Input name="last_name" autoComplete="family-name" /></Field>
        </div>
        <Field label="Email"><Input type="email" name="email" required autoComplete="email" /></Field>
        <Field label={`Phone${settings.requirePhone ? "" : " (optional)"}`}>
          <Input type="tel" name="phone" required={settings.requirePhone} autoComplete="tel" />
        </Field>
        {settings.intakeFields.map((f) => (
          <Field key={f.key} label={f.required ? f.label : `${f.label} (optional)`}>
            {f.type === "textarea" ? (
              <textarea name={`intake_${f.key}`} required={f.required} className="input min-h-[80px]" />
            ) : (
              <Input type={f.type === "phone" ? "tel" : f.type} name={`intake_${f.key}`} required={f.required} />
            )}
          </Field>
        ))}
        <Field label="Notes (optional)"><textarea name="notes" className="input min-h-[70px]" /></Field>

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

function Confirmation({
  businessName, vocab, booking,
}: {
  businessName: string;
  vocab: ReturnType<typeof vocabFor>;
  booking: { status: string; serviceName: string; resourceName: string; date: string; time: string; needsPayment: boolean };
}) {
  return (
    <Shell businessName={businessName}>
      <div className="card p-[18px] text-center">
        <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-ok-bg text-[20px] text-ok">✓</span>
        <h1 className="ob-h1 mb-1">
          {booking.status === "pending" ? `Request sent` : `You're booked!`}
        </h1>
        <p className="m-0 text-body text-muted">
          {booking.serviceName}{booking.resourceName ? ` with ${booking.resourceName}` : ""} — {booking.date} at {booking.time}
        </p>
        {booking.status === "pending" && (
          <p className="mt-2 text-body text-muted">{businessName} will confirm this {vocab.bookingOne} shortly.</p>
        )}
        {booking.needsPayment && (
          <p className="mt-2 text-body text-muted">{businessName} will be in touch about payment for this {vocab.bookingOne}.</p>
        )}
        <p className="mt-3 text-[12px] text-subtle">A confirmation has been sent to your email.</p>
      </div>
    </Shell>
  );
}
