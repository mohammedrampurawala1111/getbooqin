import { Form, redirect } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.timeoff";
import { Data, Settings } from "getbooqin-core";
// Subpath, not the root barrel — this module's formatInZone runs in the
// component render below, which executes client-side too; the root
// barrel pulls in Prisma-backed modules that have no business in a
// browser bundle (see bookingsShared.ts's header comment for the same
// reasoning applied there).
import { formatInZone, wallClockToUtc } from "getbooqin-core/booking/tz";
import { requireTenant } from "~/tenant.server";
import { AlertError, PageHeader, Field, Input, DataTable, EmptyState, ConfirmDialog } from "~/components/ui";

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

  await Data.addTimeoff(shop, Number(form.get("resource_id") ?? 0), start, end, String(form.get("reason") ?? ""));
  return redirect(`/dashboard/${params.connectionId}/timeoff`);
}

export default function TimeOff({ loaderData, actionData }: Route.ComponentProps) {
  const { blocks, resources, timezone } = loaderData;

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader title="Time off" />
      {actionData?.error && <AlertError>{actionData.error}</AlertError>}

      <div className="card">
        <div className="card-body">
          {/* Keyed on the row count: a successful add redirects to this
              same URL, which React Router treats as a revalidation of the
              route already mounted here rather than a fresh navigation —
              the <Form>'s uncontrolled inputs kept their typed values
              across a "successful" submit with nothing telling the
              merchant it had gone through except a new row appearing below
              (UX audit's #14 finding). blocks.length changes the instant
              that new row lands, which remounts the form fresh. */}
          <Form method="post" key={blocks.length} className="flex flex-col gap-[14px]">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(180px,1.1fr)_1fr_1fr]">
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
            <div>
              <button type="submit" className="btn-pri">
                Add block
              </button>
            </div>
          </Form>
        </div>
      </div>

      <DataTable
        cols="1.3fr 1.3fr 1.3fr 1fr .8fr"
        columns={["Resource", "Start", "End", "Reason", ""]}
        rows={blocks}
        rowKey={(b) => String(b.id)}
        renderRow={(b) => [
          b.resourceId === 0 ? "Whole business" : resources.find((r) => r.id === b.resourceId)?.name ?? `#${b.resourceId}`,
          <span className="num">{formatInZone(b.startUtc, timezone)}</span>,
          <span className="num">{formatInZone(b.endUtc, timezone)}</span>,
          b.reason || <span className="text-subtle">—</span>,
          <>
            <button
              type="button"
              className="btn-link text-danger"
              onClick={() => (document.getElementById(`remove-timeoff-${b.id}`) as HTMLDialogElement | null)?.showModal()}
            >
              Remove
            </button>
            <ConfirmDialog
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
          </>,
        ]}
        empty={
          <EmptyState
            icon={
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="2.5" y="3.5" width="13" height="12" rx="2" />
                <path d="M2.5 7h13M6 2v3M12 2v3M6.5 11h1.5M10 11h1.5" strokeLinecap="round" />
              </svg>
            }
            title="No time off scheduled"
            body="Add a block above to close bookings for a date range."
          />
        }
      />
    </div>
  );
}
