import { useEffect } from "react";
import { Form, redirect, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.timeoff";
import { Data, Settings, Bookings } from "getbooqin-core";
// Subpath, not the root barrel — this module's formatInZone runs in the
// component render below, which executes client-side too; the root
// barrel pulls in Prisma-backed modules that have no business in a
// browser bundle (see bookingsShared.ts's header comment for the same
// reasoning applied there).
import { formatInZone, wallClockToUtc } from "getbooqin-core/booking/tz";
import { requireTenant } from "~/tenant.server";
import { AlertError, PageHeader, Field, Input, DataTable, EmptyState, ConfirmDialog, useToast } from "~/components/ui";
import { useVocabulary } from "~/lib/presets";

export const meta: Route.MetaFunction = () => [{ title: "Time off · GetBooqin" }];

export async function loader({ request, params }: Route.LoaderArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  const [blocks, resources, settings] = await Promise.all([
    Data.timeoff(shop),
    Data.resources(shop, platform, true),
    Settings.getSettings(shop, platform),
  ]);
  return { blocks, resources, timezone: settings.timezone };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  const form = await request.formData();

  if (form.get("_action") === "delete") {
    await Data.deleteTimeoff(shop, Number(form.get("id")));
    return redirect(`/dashboard/${params.connectionId}/timeoff`);
  }

  // The <input type="datetime-local"> value below has no offset in it
  // ("2026-09-10T09:00") — new Date() on that string is parsed in the
  // *server process's* zone (UTC on Fly.io), not the business's, which is
  // what put a 09:00 Amsterdam entry into the DB as 09:00 UTC (11:00
  // local, a 2h shift with real no-show consequences). wallClockToUtc
  // reads it as wall-clock time in settings.timezone instead.
  const { timezone } = await Settings.getSettings(shop, platform);
  let start: Date;
  let end: Date;
  try {
    start = wallClockToUtc(String(form.get("start")), timezone);
    end = wallClockToUtc(String(form.get("end")), timezone);
  } catch {
    return { error: "Enter a valid start and end date/time." };
  }
  if (!(end > start)) {
    return { error: "End must be after start." };
  }

  const resourceId = Number(form.get("resource_id") ?? 0);
  const reason = String(form.get("reason") ?? "");
  const proceed = String(form.get("proceed") ?? "");

  // Closing a window over existing bookings used to save silently, leaving
  // the affected bookings stranded inside a now-closed block with nothing
  // anywhere mentioning it (Defect Dossier's BQ-08 finding). Checked before
  // the first save attempt; "keep"/"cancel_and_notify" are the two ways a
  // merchant can proceed once shown what's affected.
  if (proceed !== "keep" && proceed !== "cancel_and_notify") {
    const overlapping = await Bookings.occupyingBetween(shop, platform, resourceId, start, end);
    if (overlapping.length > 0) {
      const withNames = await Data.attachServiceNames(shop, overlapping);
      return {
        overlapping: withNames.map((b) => ({
          id: b.id,
          serviceName: b.serviceName,
          customerName: `${b.customer?.firstName ?? ""} ${b.customer?.lastName ?? ""}`.trim(),
          startUtc: b.startUtc.toISOString(),
        })),
        pendingBlock: { resource_id: resourceId, start: String(form.get("start")), end: String(form.get("end")), reason },
      };
    }
  }

  if (proceed === "cancel_and_notify") {
    const overlapping = await Bookings.occupyingBetween(shop, platform, resourceId, start, end);
    for (const booking of overlapping) {
      await Bookings.setStatus(shop, booking.id, "cancelled", "time off block created");
    }
  }

  await Data.addTimeoff(shop, resourceId, start, end, reason);
  // Same "?added=1" convention as the Add-consultation dialog's own
  // success redirect (BQ-02) — a plain redirect to this same URL just
  // revalidates the already-mounted route, so nothing tells the dialog
  // (which now owns this form, see BQ-29) it should close.
  return redirect(`/dashboard/${params.connectionId}/timeoff?added=1`);
}

export default function TimeOff({ loaderData, actionData, params }: Route.ComponentProps) {
  const { blocks, resources, timezone } = loaderData;
  const base = `/dashboard/${params.connectionId}`;
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const v = useVocabulary();

  // Guards the case where the dialog's own submit failed validation (bad
  // dates, end before start) — the dialog usually just stays open (a native
  // <dialog>'s open state survives an in-place re-render), but this covers
  // the same-key edge case robustly rather than relying on that alone.
  useEffect(() => {
    if (actionData && "error" in actionData && actionData.error) {
      const dialog = document.getElementById("add-timeoff") as HTMLDialogElement | null;
      if (dialog && !dialog.open) dialog.showModal();
    }
  }, [actionData]);

  useEffect(() => {
    if (searchParams.get("added") !== "1") return;
    (document.getElementById("add-timeoff") as HTMLDialogElement | null)?.close();
    toast("Time off block added.");
    navigate(`${base}/timeoff`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  if (actionData && "overlapping" in actionData && actionData.overlapping) {
    const { overlapping, pendingBlock } = actionData;
    return (
      <div className="flex flex-col gap-[18px]">
        <PageHeader title="Time off" />
        <div className="card p-[18px]">
          <h2 className="card-title mb-2">
            {overlapping.length} {overlapping.length === 1 ? v.bookingOne : v.bookingMany} fall{overlapping.length === 1 ? "s" : ""} inside this block
          </h2>
          <ul className="m-0 mb-4 flex list-none flex-col gap-2 p-0">
            {overlapping.map((b) => (
              <li key={b.id} className="rounded-[8px] border border-line px-3 py-2 text-body">
                <span className="font-medium">{b.serviceName}</span> — {b.customerName} — {formatInZone(b.startUtc, timezone)}
              </li>
            ))}
          </ul>
          <Form method="post" className="flex flex-wrap gap-2">
            <input type="hidden" name="resource_id" value={pendingBlock.resource_id} />
            <input type="hidden" name="start" value={pendingBlock.start} />
            <input type="hidden" name="end" value={pendingBlock.end} />
            <input type="hidden" name="reason" value={pendingBlock.reason} />
            <a href="." className="btn-sec no-underline hover:no-underline">
              Go back
            </a>
            <button type="submit" name="proceed" value="keep" className="btn-sec">
              Keep the {v.bookingMany}
            </button>
            <button type="submit" name="proceed" value="cancel_and_notify" className="btn-del">
              Cancel and notify the {overlapping.length === 1 ? v.customerOne : v.customers.toLowerCase()}
            </button>
          </Form>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        title="Time off"
        actions={
          <button
            type="button"
            className="btn-pri"
            onClick={() => (document.getElementById("add-timeoff") as HTMLDialogElement | null)?.showModal()}
          >
            + Add time off
          </button>
        }
      />

      <DataTable
        cols="1.3fr 1.3fr 1.3fr 1fr .8fr"
        // Singular — each row holds one resource (or "Whole business"), not
        // several (Defect Dossier's BQ-16 finding).
        columns={[v.resourceOneTitle || "Resource", "Start", "End", "Reason", ""]}
        rows={blocks}
        rowKey={(b) => String(b.id)}
        renderRow={(b) => [
          b.resourceId === 0 ? "Whole business" : resources.find((r) => r.id === b.resourceId)?.name ?? `#${b.resourceId}`,
          <span className="num">{formatInZone(b.startUtc, timezone)}</span>,
          <span className="num">{formatInZone(b.endUtc, timezone)}</span>,
          b.reason || <span className="text-subtle">—</span>,
          <RemoveTimeoffButton id={b.id} />,
        ]}
        // Below 640px the five fixed columns broke to one word per line and
        // "Remove" rendered on top of the reason text instead of beside it
        // (UX audit's B5 finding — the same class of problem the resources
        // list already got the stacked-card treatment for, see that
        // route's own mobileCard for the pattern this mirrors).
        mobileCard={(b) => (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate font-medium">
                {b.resourceId === 0 ? "Whole business" : resources.find((r) => r.id === b.resourceId)?.name ?? `#${b.resourceId}`}
              </span>
              <RemoveTimeoffButton id={b.id} />
            </div>
            <span className="num text-muted">
              {formatInZone(b.startUtc, timezone)} – {formatInZone(b.endUtc, timezone)}
            </span>
            {b.reason && <span className="min-w-0 truncate text-muted">{b.reason}</span>}
          </>
        )}
        empty={
          <EmptyState
            icon={
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="2.5" y="3.5" width="13" height="12" rx="2" />
                <path d="M2.5 7h13M6 2v3M12 2v3M6.5 11h1.5M10 11h1.5" strokeLinecap="round" />
              </svg>
            }
            title="No time off scheduled"
            body="Add a block to close bookings for a date range."
          />
        }
      />

      {/* Add-time-off dialog — used to be an inline form permanently
          occupying the top of this page, pushing the actual block list
          below the fold even with nothing to add (Defect Dossier's BQ-29
          finding: three create flows, three different patterns). Same
          native-<dialog> idiom as the Add-consultation dialog. Keyed on the
          row count exactly as the old inline form was — a successful add
          redirects to this same URL, which revalidates the already-mounted
          route rather than navigating, so remounting on a new row landing
          is what both resets the form's stale values *and* closes the
          dialog (a fresh DOM node defaults to closed). */}
      <dialog
        id="add-timeoff"
        className="m-auto w-full max-w-[480px] rounded-modal p-0 shadow-modal backdrop:bg-[rgba(19,17,24,0.42)]"
      >
        <div className="flex flex-col gap-4 p-[22px]">
          <h2 className="m-0 text-[16px] font-semibold">Add time off</h2>
          {actionData?.error && <AlertError>{actionData.error}</AlertError>}
          <Form method="post" key={blocks.length} className="flex flex-col gap-[14px]">
            <div className="grid grid-cols-1 gap-3">
              <Field label="Applies to">
                <select name="resource_id" defaultValue="0" className="input min-w-0">
                  <option value="0">Whole business</option>
                  {resources.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Start">
                <Input type="datetime-local" name="start" required />
              </Field>
              <Field label="End">
                <Input type="datetime-local" name="end" required />
              </Field>
            </div>
            <Field label="Reason" hint="Optional">
              <Input name="reason" placeholder="Reason (optional)" />
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
                Add block
              </button>
            </div>
          </Form>
        </div>
      </dialog>

      {/* One dialog per block, rendered flat here rather than inside either
          of DataTable's two per-row renderings — both the desktop row and
          the mobile card are always present in the DOM with only one made
          visible via `display` at a given width (see DataTable's own
          comment), and a <dialog> nested inside a `display:none` ancestor
          won't actually show even after showModal(). Keeping exactly one
          copy per block, outside both hidden/visible toggles, means either
          button — desktop row or mobile card — opens the one real dialog
          for that block's id. */}
      {blocks.map((b) => (
        <ConfirmDialog
          key={b.id}
          id={`remove-timeoff-${b.id}`}
          title="Remove this time off block?"
          body="Bookings will be allowed again for this date range. This can't be undone."
          confirmLabel="Remove"
        >
          <Form method="post" id={`remove-timeoff-${b.id}-form`}>
            <input type="hidden" name="_action" value="delete" />
            <input type="hidden" name="id" value={b.id} />
          </Form>
        </ConfirmDialog>
      ))}
    </div>
  );
}

function RemoveTimeoffButton({ id }: { id: number }) {
  return (
    <button
      type="button"
      className="btn-link text-danger"
      onClick={() => (document.getElementById(`remove-timeoff-${id}`) as HTMLDialogElement | null)?.showModal()}
    >
      Remove
    </button>
  );
}
