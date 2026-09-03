import { useEffect } from "react";
import { Form, data } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.bookings.$bookingId";
import { Bookings, Data, Settings, ConsultationSummary, FeatureFlags } from "getbooqin-core";
import { formatInZone } from "getbooqin-core/booking/tz";
import { requireTenant } from "~/tenant.server";
import { AlertError, Badge, Field, Input, Toggle, ConfirmDialog, useToast } from "~/components/ui";
import { useVocabulary, vocabFor } from "~/lib/presets";
import { dashboardPreset } from "~/lib/dashboardMeta";

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: `${vocabFor(dashboardPreset(matches)).bookingTitle} · GetBooqin` },
];

// Visit Summary status pill for the entry card below — separate from
// ui.tsx's Badge component, whose STATUS map is keyed to booking/payment
// statuses, not ConsultationSummary's (draft/under_review/approved/sent).
const SUMMARY_STATUS_META: Record<string, [string, string]> = {
  draft: ["badge-pending", "Draft"],
  under_review: ["badge-pending", "Needs review"],
  approved: ["badge-ok", "Approved"],
  sent: ["badge-ok", "Sent"],
};

export async function loader({ request, params }: Route.LoaderArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  const id = Number(params.bookingId);

  const booking = await Bookings.get(shop, id);
  if (!booking) throw data("Booking not found", { status: 404 });

  const [service, resource, customer, resourceOptions, settings, conflict] = await Promise.all([
    Data.catalogService(shop, booking.serviceId),
    Data.resource(shop, booking.resourceId),
    Data.customer(shop, booking.customerId),
    Data.resourcesForService(shop, platform, booking.serviceId),
    Settings.getSettings(shop, platform),
    Bookings.scheduleConflict(shop, booking),
  ]);

  const allowedTransitions = Bookings.TRANSITIONS[booking.status as Bookings.BookingStatus] ?? [];
  // Completed/no-show only mean something once the appointment has actually
  // happened — computed here, not on the client, so server-render and
  // hydration never disagree about "now" (Defect Dossier's BQ-26 finding).
  const hasStarted = booking.startUtc <= new Date();

  // Visit Summary (Clinic preset only — see
  // docs/patient-summary-cloud-integration-plan.md Part 3 §1). The entry
  // card below only ever shows for a completed clinic booking with the
  // feature enabled (both the env flag and the shop's own toggle) — same
  // gate the new .summary route's loader enforces server-side, so a direct
  // link can't reach it either when this is off.
  const visitSummariesAvailable =
    settings.preset === "clinic" &&
    FeatureFlags.VISIT_SUMMARIES_ENABLED &&
    settings.visit_summaries_enabled &&
    booking.status === "completed";

  // "Record consultation" — the same feature, entered while the booking is
  // still `confirmed` instead of `completed` (recording has to start before
  // the visit is marked done). Same gates as visitSummariesAvailable minus
  // the status check, which is the opposite status — the two are mutually
  // exclusive, so only one of these two cards ever renders for a given
  // booking (docs/recording-poc-ux-spec.md §3.1).
  const recordConsultationAvailable =
    settings.preset === "clinic" &&
    FeatureFlags.VISIT_SUMMARIES_ENABLED &&
    settings.visit_summaries_enabled &&
    booking.status === "confirmed";

  const visitSummaryRow = visitSummariesAvailable
    ? await ConsultationSummary.getForBooking({ shop, platform, bookingId: id })
    : null;

  const visitSummary =
    visitSummaryRow && visitSummaryRow.status !== "discarded"
      ? {
          status: visitSummaryRow.status,
          createdAt: visitSummaryRow.createdAt.toISOString(),
          approvedAt: visitSummaryRow.approvedAt ? visitSummaryRow.approvedAt.toISOString() : null,
          sentAt: visitSummaryRow.sentAt ? visitSummaryRow.sentAt.toISOString() : null,
        }
      : null;

  return {
    booking, service, resource, customer, resourceOptions, settings, allowedTransitions, conflict, hasStarted,
    labels: Bookings.statusLabels(),
    visitSummariesAvailable,
    recordConsultationAvailable,
    visitSummary,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  const id = Number(params.bookingId);
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "");

  // Every branch used to redirect to this same URL on success — a re-render
  // with no toast, no flash, nothing (Defect Dossier's BQ-25 finding).
  // Returning a specific outcome instead of redirecting lets the component
  // fire the right toast message without a pointless navigation.
  try {
    if (intent === "status") {
      const newStatus = String(form.get("status"));
      await Bookings.setStatus(shop, id, newStatus);
      return { statusChanged: newStatus };
    } else if (intent === "decline") {
      await Bookings.decline(shop, id, String(form.get("reason") ?? ""));
      return { statusChanged: "declined" };
    } else if (intent === "cancel") {
      await Bookings.setStatus(shop, id, "cancelled", String(form.get("reason") ?? ""));
      return { statusChanged: "cancelled" };
    } else if (intent === "reschedule") {
      const booking = await Bookings.get(shop, id);
      const settings = await Settings.getSettings(shop, platform);
      await Bookings.reschedule(
        shop,
        platform,
        settings.timezone,
        id,
        String(form.get("date")),
        String(form.get("time")),
        Number(form.get("resource_id") ?? booking?.resourceId ?? 0),
        { override: form.get("override") === "on" }
      );
      return { rescheduled: true };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Something went wrong." };
  }

  return { error: "Unknown request." };
}

// Consistent imperative verbs instead of a blanket "Mark {status}" — that
// read as "Mark Confirmed"/"Mark Declined"/"Mark Cancelled" for actions
// that don't need the "Mark" prefix at all, while genuinely retrospective
// ones ("no one showed up") keep it (Defect Dossier's BQ-26 finding, item 4).
const TRANSITION_VERBS: Partial<Record<Bookings.BookingStatus, string>> = {
  confirmed: "Confirm",
  declined: "Decline",
  completed: "Mark completed",
  no_show: "Mark as no-show",
  pending: "Reopen",
};

export default function BookingDetail({ loaderData, actionData, params }: Route.ComponentProps) {
  const { booking, service, resource, customer, resourceOptions, settings, allowedTransitions, labels, visitSummariesAvailable, recordConsultationAvailable, visitSummary, conflict, hasStarted } = loaderData;
  const v = useVocabulary();
  const base = `/dashboard/${params.connectionId}`;
  const canCancel = ["pending", "confirmed"].includes(booking.status);
  const transitionsExceptCancel = allowedTransitions.filter((s) => s !== "cancelled");
  // The visually recommended (filled) action should be the one the booking's
  // own state actually calls for — Pending's is approving it; a Confirmed
  // booking that's already happened is waiting to be closed out; a
  // Confirmed booking still ahead of it has no terminal action to
  // recommend, so Reschedule stays the only emphasis (Defect Dossier's
  // BQ-26 finding, item 3).
  const primaryTarget: Bookings.BookingStatus | null =
    booking.status === "pending" ? "confirmed" : booking.status === "confirmed" && hasStarted ? "completed" : null;
  const toast = useToast();

  useEffect(() => {
    if (!actionData) return;
    if ("statusChanged" in actionData && actionData.statusChanged) {
      toast(`${v.bookingOne.charAt(0).toUpperCase() + v.bookingOne.slice(1)} ${labels[actionData.statusChanged as keyof typeof labels].toLowerCase()}`);
    } else if ("rescheduled" in actionData && actionData.rescheduled) {
      toast(`${v.bookingOne.charAt(0).toUpperCase() + v.bookingOne.slice(1)} rescheduled — ${formatInZone(booking.startUtc, settings.timezone)}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionData]);

  // booking.id is a global auto-increment shared by every connection, not a
  // per-connection sequence — the first booking of a brand-new account
  // could read "Booking #18" (UX audit's #8 finding). The uid is already an
  // unguessable per-booking id used for manage/summary links; a short
  // uppercase suffix of it reads as a real reference without a schema
  // change or an extra query.
  const bookingRef = booking.uid.slice(-6).toUpperCase();

  return (
    <div className="flex flex-col gap-[18px]">
      <div>
        <a href={`${base}/bookings`} className="btn-link">
          &larr; All {v.bookingMany}
        </a>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="page-title">{v.bookingOne.charAt(0).toUpperCase() + v.bookingOne.slice(1)} #{bookingRef}</h1>
          <Badge status={booking.status as any} label={labels[booking.status as keyof typeof labels]} />
        </div>

        {(transitionsExceptCancel.length > 0 || canCancel) && (
          <div className="flex flex-wrap gap-2">
            <Form method="post" className="flex flex-wrap gap-2">
              <input type="hidden" name="_action" value="status" />
              {transitionsExceptCancel.map((s) => {
                // Completed/no-show describe how the appointment went, so
                // neither means anything before it's actually happened
                // (Defect Dossier's BQ-26 finding, item 1) — the server
                // rejects this too; disabling here just explains why up
                // front instead of via a failed submit.
                const timeGated = (s === "completed" || s === "no_show") && !hasStarted;
                return (
                  <button
                    key={s}
                    type="submit"
                    name="status"
                    value={s}
                    className={s === primaryTarget ? "btn-pri" : "btn-sec"}
                    disabled={timeGated}
                    title={timeGated ? "Available after the consultation starts" : undefined}
                  >
                    {TRANSITION_VERBS[s] ?? labels[s]}
                  </button>
                );
              })}
            </Form>
            {canCancel && (
              <button
                type="button"
                className="btn-del"
                onClick={() =>
                  (document.getElementById("cancel-booking") as HTMLDialogElement | null)?.showModal()
                }
              >
                Cancel {v.bookingOne}
              </button>
            )}
          </div>
        )}
      </div>

      {actionData?.error && <AlertError>{actionData.error}</AlertError>}

      {/* A booking outside its own business's rules (closed day, outside
          hours, a time-off block, an overlap, an inactive resource/service)
          used to render identically to a normal one, anywhere in the app
          (Defect Dossier's BQ-07 finding). Only shown for bookings that
          still occupy a slot — scheduleConflict() itself already reports
          ok for anything cancelled/declined/completed/no_show. */}
      {!conflict.ok && canCancel && (
        <div className="alert-error" role="alert">
          This {v.bookingOne} is outside your business's own rules: {conflict.reasons.join(" ")}{" "}
          <a href="#reschedule" className="font-semibold underline">
            Reschedule it
          </a>{" "}
          or update your hours/time off to match.
        </div>
      )}

      <div className="grid grid-cols-[1.35fr_1fr] gap-[14px]">
        <div className="flex flex-col gap-[14px]">
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Details</h2>
            </div>
            <div className="card-body">
              <div className="kv">
                <span className="kv-key">When</span>
                <span className="kv-val num">{formatInZone(booking.startUtc, settings.timezone)}</span>
              </div>
              <div className="kv">
                <span className="kv-key">{v.serviceOne ? v.serviceOne.charAt(0).toUpperCase() + v.serviceOne.slice(1) : "Service"}</span>
                <span className="kv-val">{service?.name ?? "—"}</span>
              </div>
              <div className="kv">
                <span className="kv-key">{v.resourceOne ? v.resourceOne.charAt(0).toUpperCase() + v.resourceOne.slice(1) : "Resource"}</span>
                <span className="kv-val">{resource?.name ?? "—"}</span>
              </div>
              {booking.notes && (
                <div className="kv">
                  <span className="kv-key">Notes</span>
                  <span className="kv-val">{booking.notes}</span>
                </div>
              )}
            </div>
          </div>

          {recordConsultationAvailable && (
            <div className="card">
              <div className="card-header">
                <h2 className="card-title">Record consultation</h2>
              </div>
              <div className="card-body flex flex-col gap-3">
                <p className="m-0 text-body text-muted">
                  Record today&rsquo;s consultation and have it transcribed automatically — you&rsquo;ll review the
                  transcript before it becomes a visit summary.
                </p>
                <a href={`${base}/bookings/${booking.id}/summary`} className="btn-pri w-fit">
                  <span aria-hidden="true">●</span> Record consultation
                </a>
              </div>
            </div>
          )}

          {visitSummariesAvailable && (
            <div className="card">
              <div className="card-header">
                <h2 className="card-title">Visit summary</h2>
                {visitSummary && (
                  <span className={SUMMARY_STATUS_META[visitSummary.status]?.[0] ?? "badge-neutral"}>
                    {SUMMARY_STATUS_META[visitSummary.status]?.[1] ?? visitSummary.status}
                  </span>
                )}
              </div>
              <div className="card-body flex flex-col gap-3">
                {!visitSummary ? (
                  <>
                    <p className="m-0 text-body text-muted">
                      Turn today&rsquo;s consultation into a plain-language summary {customer?.firstName || `the ${v.customerOne}`} can
                      keep — reviewed and approved by you before it&rsquo;s sent.
                    </p>
                    <a href={`${base}/bookings/${booking.id}/summary`} className="btn-pri w-fit">
                      + Create visit summary
                    </a>
                  </>
                ) : (
                  <>
                    <p className="m-0 text-body text-muted">
                      {visitSummary.status === "sent" && visitSummary.sentAt
                        ? `Sent ${formatInZone(visitSummary.sentAt, settings.timezone)}`
                        : visitSummary.status === "approved" && visitSummary.approvedAt
                          ? `Approved by ${resource?.name ?? "—"}, ${formatInZone(visitSummary.approvedAt, settings.timezone)}`
                          : `Drafted ${formatInZone(visitSummary.createdAt, settings.timezone)}`}
                    </p>
                    <a href={`${base}/bookings/${booking.id}/summary`} className="btn-sec w-fit">
                      {visitSummary.status === "approved"
                        ? `Send to ${v.customerOne} →`
                        : visitSummary.status === "sent"
                          ? "View summary →"
                          : "Review now →"}
                    </a>
                  </>
                )}
              </div>
            </div>
          )}

          {canCancel && (
            <div className="card" id="reschedule">
              <div className="card-header">
                <h2 className="card-title">Reschedule</h2>
              </div>
              <div className="card-body">
                <Form method="post" className="flex flex-col gap-[14px]">
                  <input type="hidden" name="_action" value="reschedule" />
                  {/* flex-wrap + explicit min-widths instead of a fixed
                      3-column grid — at ~900px that grid squeezed each
                      input to ~90px, clipping the date's year and the
                      time's AM/PM (UX audit's #11 finding). A date input
                      needs ~140px and a time input ~110px to stay readable;
                      below that they now wrap instead of shrinking. */}
                  <div className="flex flex-wrap gap-3">
                    <Field label="Date">
                      <Input type="date" name="date" required className="min-w-[140px]" />
                    </Field>
                    <Field label="Time">
                      {/* Forces 24-hour display regardless of browser
                          locale, matching the rest of the app and avoiding
                          the AM/PM clipping the weekly-hours editor had at
                          narrow widths (UX audit's C6 finding) — display
                          only, the submitted value is always "HH:mm". */}
                      <Input type="time" name="time" lang="en-GB" required className="min-w-[110px]" />
                    </Field>
                    <Field label={v.resourceOne ? v.resourceOne.charAt(0).toUpperCase() + v.resourceOne.slice(1) : "Resource"}>
                      <select name="resource_id" defaultValue={String(booking.resourceId)} className="input min-w-[160px]">
                        {resourceOptions.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  {/* Unchecked by default — a violation is a blocking error
                      unless a merchant explicitly opts into overriding it
                      (UX audit's #1 finding: this must never be silent).
                      Never bypasses time off or a real conflict — see
                      assertSlotBookable's own comment on why those two
                      stay hard stops regardless of this checkbox. */}
                  <Toggle name="override" label="Book outside business hours anyway" />
                  <div>
                    {/* A confirmed, still-upcoming booking has no terminal
                        status action to recommend — Reschedule is the one
                        thing worth emphasizing there (Defect Dossier's
                        BQ-26 finding, item 3). */}
                    <button type="submit" className={primaryTarget === null ? "btn-pri" : "btn-sec"}>
                      Reschedule
                    </button>
                  </div>
                </Form>
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-[14px]">
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">{v.customerOne.charAt(0).toUpperCase() + v.customerOne.slice(1)}</h2>
            </div>
            <div className="card-body flex flex-col gap-[10px] text-body">
              <div className="font-medium">
                {customer?.firstName} {customer?.lastName}
              </div>
              <div className="text-muted">{customer?.email}</div>
              {customer?.phone && <div className="text-muted">{customer.phone}</div>}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Payment</h2>
            </div>
            <div className="card-body flex flex-col gap-[10px]">
              <Badge status={booking.paymentStatus as any} />
              {booking.amountDue > 0 && (
                <span className="num text-body text-muted">
                  {booking.currency} {booking.amountDue.toFixed(2)}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        id="cancel-booking"
        title={`Cancel this ${v.bookingOne}?`}
        body={`The ${v.customerOne} will be notified. This can't be undone.`}
        confirmLabel={`Cancel ${v.bookingOne}`}
        cancelLabel={`Keep ${v.bookingOne}`}
      >
        <Form method="post" id="cancel-booking-form" className="flex flex-col gap-2">
          <input type="hidden" name="_action" value="cancel" />
          <Field label="Reason" hint="Optional, shown to the customer.">
            <Input name="reason" placeholder="Reason (optional)" />
          </Field>
        </Form>
      </ConfirmDialog>
    </div>
  );
}
