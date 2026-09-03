import { useEffect, useState } from "react";
import { Form, redirect, useNavigate, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.bookings";
import { Bookings, Data, Settings, Waitlist, isGetBooqinError, FeatureFlags } from "getbooqin-core";
import { formatInZone } from "getbooqin-core/booking/tz";
import { requireTenant } from "~/tenant.server";
import { PageHeader, Badge, EmptyState, Field, Input, AlertError, DataTable, Toggle, useToast, FormErrorSummary } from "~/components/ui";
import { useVocabulary, vocabFor } from "~/lib/presets";
import { dashboardPreset } from "~/lib/dashboardMeta";
import { contactFieldErrors } from "~/lib/validation";

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: `${vocabFor(dashboardPreset(matches)).bookingTitle} · GetBooqin` },
];

export async function loader({ request, params }: Route.LoaderArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "";
  const search = url.searchParams.get("q") || "";
  const filtered = !!(status || search);

  const [rows, totalCount, settings, services, resources, customers] = await Promise.all([
    Bookings.query(shop, platform, {
      ...(status ? { status } : {}),
      ...(search ? { search } : {}),
      limit: 100,
    }),
    // Only needed to tell "nothing booked yet" apart from "this filter
    // matched nothing" — a brand-new account with zero bookings used to see
    // "No bookings match this filter" and a "Clear filters" button with no
    // filter applied, implying data existed and was hidden (UX audit's N2
    // finding). Skipped when a filter is active since it wouldn't be shown.
    filtered ? Promise.resolve(-1) : Bookings.count(shop, platform, {}),
    Settings.getSettings(shop, platform),
    Data.catalogServices(shop, platform),
    Data.resources(shop, platform),
    // Backs the Add-consultation dialog's client search/typeahead — staff
    // used to retype name, email and phone from scratch for a repeat
    // client every time (Defect Dossier's BQ-31 finding). Capped at the
    // 300 most recent so this stays a cheap single query even for a
    // long-running shop.
    Data.customers(shop, platform, "", 300, 0),
  ]);
  const withNames = await Data.attachServiceNames(shop, rows);
  // "Needs attention" — a booking that violates its own business's rules
  // (closed day, outside hours, time off, an overlap, an inactive service/
  // resource) used to render identically to a perfectly normal one
  // (Defect Dossier's BQ-07 finding). Checked in parallel, not sequentially
  // — this page is capped at 100 rows, so the added latency stays small.
  const conflicts = await Promise.all(withNames.map((b) => Bookings.scheduleConflict(shop, b)));
  const bookingsWithConflicts = withNames.map((b, i) => ({ ...b, conflict: conflicts[i] }));

  // Same shape as shopify-openslot's app.bookings.tsx "Add booking
  // manually" modal (this feature's original home — see that file for the
  // reference implementation) — precomputed server-side so the resource
  // picker in the add-booking dialog only ever offers resources actually
  // assigned to the chosen service, not every resource in the shop.
  const resourcesByService: Record<number, { id: number; name: string }[]> = {};
  for (const service of services) {
    const forService = await Data.resourcesForService(shop, platform, service.id);
    resourcesByService[service.id] = forService.map((r) => ({ id: r.id, name: r.name }));
  }

  return {
    bookings: bookingsWithConflicts,
    status,
    search,
    filtered,
    totalCount,
    statuses: Bookings.STATUSES,
    labels: Bookings.statusLabels(),
    timezone: settings.timezone,
    requirePhone: settings.require_phone,
    // A Payment column with nothing to show whenever the shop has no
    // gateway connected read as broken, not empty (Defect Dossier's BQ-30
    // finding).
    paymentsAvailable: FeatureFlags.PAYMENTS_ENABLED && settings.enabled_gateways.length > 0,
    serviceOptions: services.map((s) => ({ id: s.id, name: s.name })),
    resourceOptions: resources.map((r) => ({ id: r.id, name: r.name })),
    resourcesByService,
    customerOptions: customers.map((c) => ({
      id: c.id, firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone,
    })),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "");

  if (intent === "create_manual") {
    const settings = await Settings.getSettings(shop, platform);
    // Mirrors DetailsForm's client-side check on the public form — same
    // helper, same field-level shape (Defect Dossier's BQ-24 finding).
    const fieldErrors = contactFieldErrors(
      {
        first_name: String(form.get("first_name") || ""),
        email: String(form.get("email") || ""),
        phone: String(form.get("phone") || ""),
      },
      settings.require_phone
    );
    if (Object.keys(fieldErrors).length > 0) return { fieldErrors };
    try {
      const booking = await Bookings.create(shop, platform, settings.timezone, {
        service_id: Number(form.get("service_id") || 0),
        resource_id: Number(form.get("resource_id") || 0) || undefined,
        date: String(form.get("date") || ""),
        time: String(form.get("time") || ""),
        first_name: String(form.get("first_name") || ""),
        last_name: String(form.get("last_name") || ""),
        email: String(form.get("email") || ""),
        phone: String(form.get("phone") || ""),
        notes: String(form.get("notes") || ""),
        source: "form",
        // Staff typing in a phone/walk-in booking are entering their own
        // data, not a stranger's request — auto_confirm's approval gate
        // exists to triage public requests, not a merchant's own entry
        // (Defect Dossier's BQ-27 finding). Still overridable to Pending
        // when the slot is genuinely provisional.
        force_status: (String(form.get("status") || "confirmed") === "pending" ? "pending" : "confirmed") as "pending" | "confirmed",
        override: form.get("override") === "on",
      });
      const service = await Data.catalogService(shop, booking.serviceId);
      const when = formatInZone(booking.startUtc, settings.timezone);
      const bookingNoun = vocabFor(settings.preset).bookingOne;
      return redirect(
        `/dashboard/${params.connectionId}/bookings?booked=${encodeURIComponent(`${service?.name ?? bookingNoun} booked — ${when}`)}`
      );
    } catch (err) {
      // The add-booking dialog's date/time are free-text, not a slot
      // picker (matching shopify-openslot's own "Add booking manually",
      // this feature's original home) — so a staff member can freely type
      // a time the schedule doesn't actually offer. Rather than build a
      // whole slot-picker into a staff modal, offer the one productive
      // next step for exactly the two errors that mean "the time itself
      // was the problem, not the request": add the same request to the
      // waitlist instead of a dead-end error. Any other error (bad email,
      // missing name, ...) isn't slot-shaped and shouldn't offer this.
      if (isGetBooqinError(err) && (err.code === "getbooqin_slot_not_offered" || err.code === "getbooqin_slot_taken")) {
        return { error: err.message, canWaitlist: true };
      }
      return { error: err instanceof Error ? err.message : "Something went wrong." };
    }
  }

  if (intent === "join_waitlist") {
    try {
      const settings = await Settings.getSettings(shop, platform);
      await Waitlist.join(shop, platform, settings.timezone, {
        service_id: Number(form.get("service_id") || 0),
        resource_id: Number(form.get("resource_id") || 0) || undefined,
        window_start: String(form.get("date") || ""),
        time: String(form.get("time") || ""),
        first_name: String(form.get("first_name") || ""),
        last_name: String(form.get("last_name") || ""),
        email: String(form.get("email") || ""),
        phone: String(form.get("phone") || ""),
        notes: String(form.get("notes") || ""),
      });
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Something went wrong." };
    }
    return redirect(`/dashboard/${params.connectionId}/bookings?waitlisted=1`);
  }

  return { error: "Unknown request." };
}

function customerLabel(c: { firstName: string; lastName: string; email: string }): string {
  return `${c.firstName} ${c.lastName} — ${c.email}`.replace(/\s+—/, " —").trim();
}

export default function BookingsList({ loaderData, actionData, params }: Route.ComponentProps) {
  const { bookings, status, search, filtered, totalCount, statuses, labels, timezone, requirePhone, paymentsAvailable, serviceOptions, resourceOptions, resourcesByService, customerOptions } = loaderData;
  const base = `/dashboard/${params.connectionId}`;
  const noBookingsAtAll = !filtered && totalCount === 0;
  const v = useVocabulary();
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle" && navigation.formData?.get("_action") === "create_manual";
  const submittingWaitlist = navigation.state !== "idle" && navigation.formData?.get("_action") === "join_waitlist";

  const [addServiceId, setAddServiceId] = useState("");
  const addResourceOptions = addServiceId ? resourcesByService[Number(addServiceId)] ?? [] : resourceOptions;
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [formResetKey, setFormResetKey] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [addError, setAddError] = useState<{ error: string; canWaitlist?: boolean } | null>(null);

  // Mirrors DetailsForm's client-side validation on the public booking form
  // — this dialog relied entirely on native HTML5 validation too (Defect
  // Dossier's BQ-24 finding).
  useEffect(() => {
    if (actionData && "fieldErrors" in actionData && actionData.fieldErrors) setErrors(actionData.fieldErrors);
    if (actionData && "error" in actionData && actionData.error) setAddError({ error: actionData.error, canWaitlist: "canWaitlist" in actionData ? actionData.canWaitlist : false });
  }, [actionData]);

  // The slot-shaped error above ("that time was just taken") stayed on
  // screen even after changing the very field it was complaining about —
  // picking a different time still showed "just taken" for the old one
  // (Defect Dossier's R2-08 finding). Cleared the same way the per-field
  // errors already are, on whichever of the four fields the error could be
  // about.
  function clearAddFormError() {
    setAddError(null);
  }

  function clearAddError(name: string) {
    setErrors((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }

  function handleAddSubmit(event: React.FormEvent<HTMLFormElement>) {
    const form = new FormData(event.currentTarget);
    const next = contactFieldErrors(
      {
        first_name: String(form.get("first_name") || ""),
        email: String(form.get("email") || ""),
        phone: String(form.get("phone") || ""),
      },
      requirePhone
    );
    if (Object.keys(next).length > 0) {
      event.preventDefault();
      setErrors(next);
    }
  }

  // Picking an existing client from the datalist fills in the plain fields
  // below rather than submitting a separate id — the dialog posts a fresh
  // name/email/phone either way (Bookings.create resolves the customer by
  // email, so this still lands on the same record), and staff no longer
  // have to retype it from scratch for a repeat client (Defect Dossier's
  // BQ-31 finding).
  function handlePickCustomer(event: React.ChangeEvent<HTMLInputElement>) {
    const match = customerOptions.find((c) => customerLabel(c) === event.target.value);
    if (!match) return;
    const form = event.currentTarget.form;
    if (!form) return;
    const firstName = form.elements.namedItem("first_name") as HTMLInputElement | null;
    const lastName = form.elements.namedItem("last_name") as HTMLInputElement | null;
    const email = form.elements.namedItem("email") as HTMLInputElement | null;
    const phone = form.elements.namedItem("phone") as HTMLInputElement | null;
    if (firstName) firstName.value = match.firstName;
    if (lastName) lastName.value = match.lastName;
    if (email) email.value = match.email;
    if (phone) phone.value = match.phone;
    clearAddError("first_name");
    clearAddError("email");
    clearAddError("phone");
  }

  // The create/waitlist actions redirect back to this same URL on success
  // (React Router revalidates in place rather than navigating), so the
  // dialog never used to close and its stale inputs never cleared — a
  // successful booking looked identical to nothing happening at all
  // (Defect Dossier's BQ-02 finding). A query param carries the toast
  // message across that redirect; once shown, close the dialog, remount
  // its form fresh, and strip the param so a reload doesn't refire it.
  useEffect(() => {
    const booked = searchParams.get("booked");
    const waitlisted = searchParams.get("waitlisted");
    if (!booked && waitlisted !== "1") return;
    (document.getElementById("add-booking") as HTMLDialogElement | null)?.close();
    toast(booked || "Added to the waitlist — we'll offer this time automatically if it frees up.");
    setFormResetKey((k) => k + 1);
    setAddServiceId("");
    setErrors({});
    setAddError(null);
    navigate(`${base}/bookings`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        title={v.bookingTitle}
        actions={
          serviceOptions.length > 0 ? (
            <button
              type="button"
              className="btn-pri"
              onClick={() => (document.getElementById("add-booking") as HTMLDialogElement | null)?.showModal()}
            >
              + Add {v.bookingOne}
            </button>
          ) : undefined
        }
      />

      <div className="card">
        <div className="card-header">
          <Form method="get" className="flex w-full flex-wrap items-center gap-2">
            <select name="status" defaultValue={status} aria-label="Filter by status" className="input w-auto">
              <option value="">All statuses</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {labels[s]}
                </option>
              ))}
            </select>
            <input
              name="q"
              defaultValue={search}
              placeholder="Search customer name, email, phone"
              className="input flex-1"
            />
            <button type="submit" className="btn-sec">
              Filter
            </button>
          </Form>
        </div>
      </div>

      <DataTable
        cols={paymentsAvailable ? "1.05fr 1.25fr .95fr 1.15fr .8fr .8fr 28px" : "1.05fr 1.25fr .95fr 1.15fr .8fr 28px"}
        columns={[
          "When",
          v.serviceOne ? v.serviceOne.charAt(0).toUpperCase() + v.serviceOne.slice(1) : "Service",
          v.resourceOneTitle || "Resource",
          v.customerOne ? v.customerOne.charAt(0).toUpperCase() + v.customerOne.slice(1) : "Customer",
          "Status",
          ...(paymentsAvailable ? ["Payment"] : []),
          "",
        ]}
        rows={bookings}
        rowKey={(b) => String(b.id)}
        href={(b) => `${base}/bookings/${b.id}`}
        renderRow={(b) => [
          <span className="num min-w-0 flex items-center gap-[6px]">
            {formatInZone(b.startUtc, timezone)}
            {!b.conflict.ok && (
              <span className="badge-pending" title={b.conflict.reasons.join(" ")} aria-label={`Needs attention: ${b.conflict.reasons.join(" ")}`}>
                Needs attention
              </span>
            )}
          </span>,
          <span className="min-w-0 truncate">{b.serviceName}</span>,
          <span className="min-w-0 truncate">{b.resource.name}</span>,
          <span className="min-w-0 truncate">
            {b.customer.firstName} {b.customer.lastName}
          </span>,
          <Badge status={b.status as any} label={labels[b.status as keyof typeof labels]} />,
          ...(paymentsAvailable ? [<Badge status={b.paymentStatus as any} />] : []),
          <span className="text-faint">›</span>,
        ]}
        // Below 640px the 7-column grid squeezed every cell into
        // overlapping, off-screen text — status/payment pills sat past the
        // viewport edge and the service name painted over the time (UX
        // audit's #2 finding). Same stacked-card fallback Resources/Time
        // off already use.
        mobileCard={(b) => (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate font-medium">
                {b.customer.firstName} {b.customer.lastName}
              </span>
              <Badge status={b.status as any} label={labels[b.status as keyof typeof labels]} />
            </div>
            <span className="num text-muted">{formatInZone(b.startUtc, timezone)}</span>
            <span className="min-w-0 truncate text-muted">
              {b.serviceName} · {b.resource.name}
            </span>
            <div className="flex items-center gap-2">
              {paymentsAvailable && <Badge status={b.paymentStatus as any} />}
              {!b.conflict.ok && <span className="badge-pending">Needs attention</span>}
            </div>
          </>
        )}
        empty={
          <EmptyState
            icon={
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="2.5" y="3.5" width="13" height="12" rx="2" />
                <path d="M2.5 7h13M6 2v3M12 2v3" strokeLinecap="round" />
              </svg>
            }
            title={noBookingsAtAll ? `No ${v.bookingMany} yet` : `No ${v.bookingMany} match this filter`}
            body={
              noBookingsAtAll
                ? "Once someone books, it shows up here."
                : "Try a different status or search term."
            }
            action={
              noBookingsAtAll ? undefined : (
                <a href={`${base}/bookings`} className="btn-sec">
                  Clear filters
                </a>
              )
            }
          />
        }
      />

      {/* Add-booking dialog — lets staff enter a walk-in/phone {v.bookingOne}
          on a customer's behalf, the same feature shopify-openslot's
          app.bookings.tsx already ships as "Add booking manually", ported
          here so the standalone dashboard has it too. Native <dialog>,
          same idiom as ConfirmDialog/the cancel-booking dialog elsewhere in
          this app — m-auto centers it against Tailwind's preflight
          zeroing <dialog>'s default margin. */}
      <dialog
        id="add-booking"
        className="m-auto w-full max-w-[480px] rounded-modal p-0 shadow-modal backdrop:bg-[rgba(19,17,24,0.42)]"
      >
        <div className="flex flex-col gap-4 p-[22px]">
          <h2 className="m-0 text-[16px] font-semibold">Add {v.bookingOne}</h2>
          {addError && (
            <AlertError>
              {addError.error}
              {addError.canWaitlist && " Add this request to the waitlist instead, and we'll offer it automatically if the time frees up."}
            </AlertError>
          )}
          <FormErrorSummary errors={errors} />
          <Form method="post" key={formResetKey} className="flex flex-col gap-[14px]" onSubmit={handleAddSubmit} noValidate>
            {/* No hidden _action input here on purpose — FormData.get()
                returns the *first* entry for a repeated key, and a hidden
                input sitting earlier in the DOM than either submit button
                would always win regardless of which button was actually
                clicked (silently resubmitted "create_manual" no matter
                what, found by actually clicking "Add to waitlist instead"
                and watching it just repeat the same failed create). Each
                submit button below carries its own name="_action" — the
                one and only source of intent. */}
            <div className="grid grid-cols-2 gap-3">
              <Field label={v.serviceOne ? v.serviceOne.charAt(0).toUpperCase() + v.serviceOne.slice(1) : "Service"}>
                <select
                  name="service_id"
                  className="input"
                  required
                  value={addServiceId}
                  onChange={(e) => { setAddServiceId(e.target.value); clearAddFormError(); }}
                >
                  <option value="">Choose a {v.serviceOne}</option>
                  {serviceOptions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={v.resourceOne ? v.resourceOne.charAt(0).toUpperCase() + v.resourceOne.slice(1) : "Resource"}>
                <select name="resource_id" className="input" defaultValue="" onChange={clearAddFormError}>
                  <option value="">Any available</option>
                  {addResourceOptions.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="flex flex-wrap gap-3">
              <Field label="Date">
                <Input type="date" name="date" required className="min-w-[140px]" onChange={clearAddFormError} />
              </Field>
              <Field label="Time">
                <Input type="time" name="time" lang="en-GB" required className="min-w-[110px]" onChange={clearAddFormError} />
              </Field>
            </div>
            {customerOptions.length > 0 && (
              <Field label={`Search existing ${v.customerOne}`} hint="Pick one to fill in the fields below, or just type a new client's details.">
                <Input list="add-booking-customers" placeholder="Name or email…" onChange={handlePickCustomer} />
                <datalist id="add-booking-customers">
                  {customerOptions.map((c) => (
                    <option key={c.id} value={customerLabel(c)} />
                  ))}
                </datalist>
              </Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="First name" required error={errors.first_name}>
                <Input id="first_name" name="first_name" required autoComplete="given-name" onChange={() => clearAddError("first_name")} />
              </Field>
              <Field label="Last name">
                <Input id="last_name" name="last_name" autoComplete="family-name" />
              </Field>
            </div>
            <Field label="Email" required error={errors.email}>
              <Input id="email" type="email" name="email" required autoComplete="email" onChange={() => clearAddError("email")} />
            </Field>
            <Field label="Phone" required={requirePhone} error={errors.phone}>
              <Input id="phone" type="tel" name="phone" required={requirePhone} autoComplete="tel" onChange={() => clearAddError("phone")} />
            </Field>
            <Field label="Notes">
              <textarea name="notes" className="input min-h-[70px]" />
            </Field>
            <Field label="Status" hint="Staff-entered bookings default to Confirmed — this rule normally only triages public requests.">
              <select name="status" className="input" defaultValue="confirmed">
                <option value="confirmed">Confirmed</option>
                <option value="pending">Pending</option>
              </select>
            </Field>
            {/* Unchecked by default — a violation is a blocking error unless
                staff explicitly opts in, same as the Reschedule form's
                identical toggle (Defect Dossier's BQ-04 finding: this was
                the one place that couldn't create a real out-of-hours
                appointment without a book-then-reschedule workaround). */}
            <Toggle name="override" label="Book outside business hours anyway" />
            <div className="mt-1 flex justify-end gap-2">
              <button
                type="button"
                className="btn-sec"
                onClick={(e) => (e.currentTarget.closest("dialog") as HTMLDialogElement | null)?.close()}
              >
                Cancel
              </button>
              {addError?.canWaitlist && (
                // Same form, same fields (service/resource/date/time/customer) —
                // only the intent differs. A submit button's own name/value
                // wins over the form's hidden `_action=create_manual` input
                // when it's the one clicked, so this needs no JS to switch
                // intents, just a second real submit button.
                <button type="submit" name="_action" value="join_waitlist" className="btn-sec" disabled={submittingWaitlist}>
                  {submittingWaitlist ? "Adding…" : "Add to waitlist instead"}
                </button>
              )}
              <button type="submit" name="_action" value="create_manual" className="btn-pri" disabled={submitting}>
                {submitting ? "Creating…" : `Create ${v.bookingOne}`}
              </button>
            </div>
          </Form>
        </div>
      </dialog>
    </div>
  );
}
