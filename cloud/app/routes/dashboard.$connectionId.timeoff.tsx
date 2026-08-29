import { Form, redirect } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.timeoff";
import { Data } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { AlertError, PageHeader, Field, Input, DataTable, EmptyState } from "~/components/ui";

export const meta: Route.MetaFunction = () => [{ title: "Time off · GetBooqin" }];

export async function loader({ request, params }: Route.LoaderArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  const [blocks, resources] = await Promise.all([Data.timeoff(shop), Data.resources(shop, platform, true)]);
  return { blocks, resources };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { shop } = await requireTenant(request, params.connectionId);
  const form = await request.formData();

  if (form.get("_action") === "delete") {
    await Data.deleteTimeoff(shop, Number(form.get("id")));
    return redirect(`/dashboard/${params.connectionId}/timeoff`);
  }

  const start = new Date(String(form.get("start")));
  const end = new Date(String(form.get("end")));
  if (!(end > start)) {
    return { error: "End must be after start." };
  }

  await Data.addTimeoff(shop, Number(form.get("resource_id") ?? 0), start, end, String(form.get("reason") ?? ""));
  return redirect(`/dashboard/${params.connectionId}/timeoff`);
}

export default function TimeOff({ loaderData, actionData }: Route.ComponentProps) {
  const { blocks, resources } = loaderData;

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader title="Time off" />
      {actionData?.error && <AlertError>{actionData.error}</AlertError>}

      <div className="card">
        <div className="card-body">
          <Form method="post" className="flex flex-col gap-[14px]">
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
          <span className="num">{new Date(b.startUtc).toLocaleString("en-US")}</span>,
          <span className="num">{new Date(b.endUtc).toLocaleString("en-US")}</span>,
          b.reason || <span className="text-subtle">—</span>,
          <Form method="post">
            <input type="hidden" name="_action" value="delete" />
            <input type="hidden" name="id" value={b.id} />
            <button type="submit" className="btn-link text-danger">
              Remove
            </button>
          </Form>,
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
