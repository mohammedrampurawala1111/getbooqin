import { DateTime } from "luxon";
import { Form, redirect } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.waitlist";
import { Waitlist, Data, Settings } from "getbooqin-core";
import { formatInZone } from "getbooqin-core/booking/tz";
import { waitlistStatusLabels } from "getbooqin-core/booking/waitlistShared";
import { requireTenant } from "~/tenant.server";
import { AlertError, PageHeader, Field, Input, DataTable, EmptyState, Badge } from "~/components/ui";
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
  return { entries, services, resources, timezone: settings.timezone };
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
  return redirect(`/dashboard/${params.connectionId}/waitlist`);
}

export default function WaitlistPage({ loaderData, actionData }: Route.ComponentProps) {
  const { entries, services, resources, timezone } = loaderData;
  const v = useVocabulary();
  const labels = waitlistStatusLabels();

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader title="Waitlist" subtitle={`Add a ${v.resourceOne || "customer"} here the same way you'd take a phone request.`} />
      {actionData?.error && <AlertError>{actionData.error}</AlertError>}

      <div className="card">
        <div className="card-body">
          <Form method="post" key={entries.length} className="flex flex-col gap-[14px]">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label={v.services || "Service"}>
                <select name="service_id" defaultValue="" required className="input min-w-0">
                  <option value="" disabled>
                    Choose a service
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
              <Field label="Phone" hint="Optional">
                <Input name="phone" />
              </Field>
            </div>
            <Field label="Notes" hint="Optional">
              <Input name="notes" />
            </Field>
            <div>
              <button type="submit" className="btn-pri">
                Add to waitlist
              </button>
            </div>
          </Form>
        </div>
      </div>

      <DataTable
        cols="1.2fr 1fr 1fr 1.1fr .8fr .9fr .7fr"
        columns={["Customer", v.services || "Service", v.resources || "Resource", "Window", "Status", "Joined", ""]}
        rows={entries}
        rowKey={(e) => String(e.id)}
        renderRow={(e) => [
          <span className="min-w-0 truncate">
            {e.customer.firstName} {e.customer.lastName}
          </span>,
          services.find((s) => s.id === e.serviceId)?.name ?? "—",
          e.resourceId ? resources.find((r) => r.id === e.resourceId)?.name ?? "—" : "Any",
          <span className="num">
            {DateTime.fromJSDate(new Date(e.windowStartUtc), { zone: "utc" }).setZone(timezone).toFormat("d LLL")}
            {e.windowEndUtc
              ? ` – ${DateTime.fromJSDate(new Date(e.windowEndUtc), { zone: "utc" }).setZone(timezone).toFormat("d LLL")}`
              : "+"}
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
        empty={
          <EmptyState
            icon={
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="9" cy="6" r="2.5" />
                <path d="M3.5 15c0-2.5 2.2-4 5.5-4s5.5 1.5 5.5 4" strokeLinecap="round" />
              </svg>
            }
            title="No one on the waitlist"
            body="Add someone above, and we'll offer them a slot automatically if a matching booking is cancelled."
          />
        }
      />
    </div>
  );
}
