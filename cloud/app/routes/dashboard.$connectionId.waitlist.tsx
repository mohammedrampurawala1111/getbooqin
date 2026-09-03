import { useEffect } from "react";
import { Form, redirect, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.waitlist";
import { Waitlist, Data, Settings } from "getbooqin-core";
import { formatInZone } from "getbooqin-core/booking/tz";
import { waitlistStatusLabels, formatWaitlistWindow } from "getbooqin-core/booking/waitlistShared";
import { requireTenant } from "~/tenant.server";
import { AlertError, PageHeader, Field, Input, DataTable, EmptyState, Badge, useToast } from "~/components/ui";
import { useVocabulary } from "~/lib/presets";

export const meta: Route.MetaFunction = () => [{ title: "Waitlist · GetBooqin" }];

export async function loader({ request, params }: Route.LoaderArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  const [entries, services, resources, settings] = await Promise.all([
    Waitlist.list(shop, platform),
    Data.catalogServices(shop, platform, true),
    Data.resources(shop, platform, true),
    Settings.getSettings(shop, platform),
  ]);
  return {
    entries,
    services,
    resources,
    timezone: settings.timezone,
    requirePhone: settings.require_phone,
    waitlistEnabled: settings.waitlist_enabled,
    offerWindowHours: settings.waitlist_offer_window_hours,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  const form = await request.formData();

  if (form.get("_action") === "leave") {
    await Waitlist.leave(shop, Number(form.get("id")));
    return redirect(`/dashboard/${params.connectionId}/waitlist`);
  }

  const settings = await Settings.getSettings(shop, platform);
  try {
    await Waitlist.join(shop, platform, settings.timezone, {
      service_id: Number(form.get("service_id") ?? 0),
      resource_id: Number(form.get("resource_id") ?? 0) || undefined,
      window_start: String(form.get("window_start") ?? ""),
      window_end: String(form.get("window_end") ?? "") || undefined,
      first_name: String(form.get("first_name") ?? ""),
      last_name: String(form.get("last_name") ?? ""),
      email: String(form.get("email") ?? ""),
      phone: String(form.get("phone") ?? ""),
      notes: String(form.get("notes") ?? ""),
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Something went wrong." };
  }
  // Same "?added=1" convention as the Add-consultation dialog's own
  // success redirect (BQ-02) — a plain redirect to this same URL just
  // revalidates the already-mounted route, so nothing tells the dialog
  // (which now owns this form, see BQ-29) it should close.
  return redirect(`/dashboard/${params.connectionId}/waitlist?added=1`);
}

export default function WaitlistPage({ loaderData, actionData, params }: Route.ComponentProps) {
  const { entries, services, resources, timezone, requirePhone, waitlistEnabled, offerWindowHours } = loaderData;
  const v = useVocabulary();
  const labels = waitlistStatusLabels();
  const base = `/dashboard/${params.connectionId}`;
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();

  useEffect(() => {
    if (actionData && "error" in actionData && actionData.error) {
      const dialog = document.getElementById("add-waitlist") as HTMLDialogElement | null;
      if (dialog && !dialog.open) dialog.showModal();
    }
  }, [actionData]);

  useEffect(() => {
    if (searchParams.get("added") !== "1") return;
    (document.getElementById("add-waitlist") as HTMLDialogElement | null)?.close();
    toast(
      waitlistEnabled
        ? "Added to the waitlist — we'll offer this time automatically if it frees up."
        : "Added to the waitlist."
    );
    navigate(`${base}/waitlist`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // The empty state used to always promise automatic offers, even on the
  // Legal, Automotive and Home Services presets, which ship with "Offer
  // freed slots to the waitlist" off by default — nothing on the page said
  // so, and the promise was simply false out of the box (Defect Dossier's
  // BQ-23 finding). Read the real setting instead, and show the same state
  // as a small banner once there are entries, not only in the empty state.
  const offerStatus = waitlistEnabled ? (
    <span>
      Automatic offers are on — a freed slot is offered to the next match within {offerWindowHours}h of a cancellation.
    </span>
  ) : (
    <span>
      Automatic offers are off — freed slots won't be offered to this list. You'll see cancellations in{" "}
      {v.bookingTitle || "Bookings"} and can call people yourself.{" "}
      <a href={`/dashboard/${params.connectionId}/settings?page=rules`} className="btn-link text-brand-600">
        Turn on automatic offers
      </a>
    </span>
  );

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        title="Waitlist"
        actions={
          <button
            type="button"
            className="btn-pri"
            onClick={() => (document.getElementById("add-waitlist") as HTMLDialogElement | null)?.showModal()}
          >
            + Add to waitlist
          </button>
        }
      />
      {entries.length > 0 && (
        <div className={waitlistEnabled ? "alert-success" : "alert-error"}>{offerStatus}</div>
      )}

      <DataTable
        cols="1.2fr 1fr 1fr 1.1fr .8fr .9fr .7fr"
        // Singular, not the plural nav labels — each column holds exactly
        // one value per row (Defect Dossier's BQ-16 finding).
        columns={[
          v.customerOne ? v.customerOne.charAt(0).toUpperCase() + v.customerOne.slice(1) : "Customer",
          v.serviceOne ? v.serviceOne.charAt(0).toUpperCase() + v.serviceOne.slice(1) : "Service",
          v.resourceOneTitle || "Resource",
          "Window",
          "Status",
          "Joined",
          "",
        ]}
        rows={entries}
        rowKey={(e) => String(e.id)}
        renderRow={(e) => [
          <span className="min-w-0 truncate">
            {e.customer.firstName} {e.customer.lastName}
          </span>,
          services.find((s) => s.id === e.serviceId)?.name ?? "—",
          e.resourceId ? resources.find((r) => r.id === e.resourceId)?.name ?? "—" : "Any",
          <span className="num">
            {formatWaitlistWindow(new Date(e.windowStartUtc), e.windowEndUtc ? new Date(e.windowEndUtc) : null, timezone)}
          </span>,
          <Badge status={e.status as "waiting" | "offered" | "claimed" | "expired" | "cancelled"} label={labels[e.status as keyof typeof labels]} />,
          <span className="num">{formatInZone(e.createdAt, timezone, "d LLL yyyy")}</span>,
          (e.status === "waiting" || e.status === "offered") && (
            <Form method="post">
              <input type="hidden" name="_action" value="leave" />
              <input type="hidden" name="id" value={e.id} />
              <button type="submit" className="btn-link text-danger">
                Remove
              </button>
            </Form>
          ),
        ]}
        // Same 7-column-grid overflow as Bookings/Customers below 640px (UX
        // audit's #2 finding) — Waitlist already used DataTable but never
        // passed this prop, so it got no stacked-card fallback either.
        mobileCard={(e) => (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate font-medium">
                {e.customer.firstName} {e.customer.lastName}
              </span>
              <Badge status={e.status as "waiting" | "offered" | "claimed" | "expired" | "cancelled"} label={labels[e.status as keyof typeof labels]} />
            </div>
            <span className="min-w-0 truncate text-muted">
              {services.find((s) => s.id === e.serviceId)?.name ?? "—"}
              {e.resourceId ? ` · ${resources.find((r) => r.id === e.resourceId)?.name ?? "—"}` : ""}
            </span>
            <span className="num text-muted">
              {formatWaitlistWindow(new Date(e.windowStartUtc), e.windowEndUtc ? new Date(e.windowEndUtc) : null, timezone)}
            </span>
            {(e.status === "waiting" || e.status === "offered") && (
              <Form method="post">
                <input type="hidden" name="_action" value="leave" />
                <input type="hidden" name="id" value={e.id} />
                <button type="submit" className="btn-link text-danger">
                  Remove
                </button>
              </Form>
            )}
          </>
        )}
        empty={
          <EmptyState
            icon={
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="9" cy="6" r="2.5" />
                <path d="M3.5 15c0-2.5 2.2-4 5.5-4s5.5 1.5 5.5 4" strokeLinecap="round" />
              </svg>
            }
            title="No one on the waitlist"
            body={
              waitlistEnabled ? (
                `Add someone here the same way you'd take a phone request, and we'll offer them a slot automatically if a matching ${v.bookingOne} is cancelled — within ${offerWindowHours}h.`
              ) : (
                <>Add someone here the same way you'd take a phone request. {offerStatus}</>
              )
            }
          />
        }
      />

      {/* Used to be an inline form permanently occupying the top of this
          page, pushing the actual list below the fold even with nothing to
          add (Defect Dossier's BQ-29 finding). Same native-<dialog> idiom
          as Add-consultation/Add-time-off. */}
      <dialog
        id="add-waitlist"
        className="m-auto w-full max-w-[560px] rounded-modal p-0 shadow-modal backdrop:bg-[rgba(19,17,24,0.42)]"
      >
        <div className="flex flex-col gap-4 p-[22px]">
          <h2 className="m-0 text-[16px] font-semibold">Add to waitlist</h2>
          <p className="m-0 text-body text-muted">Add a {v.customerOne || "customer"} here the same way you'd take a phone request.</p>
          {actionData?.error && <AlertError>{actionData.error}</AlertError>}
          <Form method="post" key={entries.length} className="flex flex-col gap-[14px]">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label={v.serviceOne ? v.serviceOne.charAt(0).toUpperCase() + v.serviceOne.slice(1) : "Service"}>
                <select name="service_id" defaultValue="" required className="input min-w-0">
                  <option value="" disabled>
                    Choose a {v.serviceOne || "service"}
                  </option>
                  {services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={v.resources || "Resource"} hint="Optional — leave blank for any">
                <select name="resource_id" defaultValue="0" className="input min-w-0">
                  <option value="0">Any available</option>
                  {resources.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Earliest date wanted">
                <Input type="date" name="window_start" required />
              </Field>
              <Field label="Latest date wanted" hint="Optional">
                <Input type="date" name="window_end" />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="First name">
                <Input name="first_name" required />
              </Field>
              <Field label="Last name" hint="Optional">
                <Input name="last_name" />
              </Field>
              <Field label="Email">
                <Input type="email" name="email" required />
              </Field>
              <Field label="Phone" hint={requirePhone ? undefined : "Optional"}>
                <Input name="phone" required={requirePhone} />
              </Field>
            </div>
            <Field label="Notes" hint="Optional">
              <Input name="notes" />
            </Field>
            <div className="mt-1 flex justify-end gap-2">
              <button
                type="button"
                className="btn-sec"
                onClick={(e) => (e.currentTarget.closest("dialog") as HTMLDialogElement | null)?.close()}
              >
                Cancel
              </button>
              <button type="submit" className="btn-pri">
                Add to waitlist
              </button>
            </div>
          </Form>
        </div>
      </dialog>
    </div>
  );
}
