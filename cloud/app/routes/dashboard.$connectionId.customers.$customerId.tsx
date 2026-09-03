import { useEffect } from "react";
import { Form, data, redirect } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.customers.$customerId";
import { Bookings, Data, Settings } from "getbooqin-core";
import { formatInZone } from "getbooqin-core/booking/tz";
import { requireTenant } from "~/tenant.server";
import { Badge, ConfirmDialog, DataTable, EmptyState, useToast } from "~/components/ui";
import { useVocabulary } from "~/lib/presets";

export const meta: Route.MetaFunction = ({ data: loaderData }) => [
  { title: `${loaderData ? `${loaderData.customer.firstName} ${loaderData.customer.lastName}`.trim() : "Client"} · GetBooqin` },
];

// A client detail page reached by clicking a row on the Clients list, with
// contact details, full booking history and free-text staff notes — the
// list was previously three columns you could only look at (Defect
// Dossier's BQ-31 finding).
export async function loader({ request, params }: Route.LoaderArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  const id = Number(params.customerId);

  const customer = await Data.customer(shop, id);
  if (!customer) throw data("Client not found", { status: 404 });

  const [rows, settings] = await Promise.all([
    Bookings.query(shop, platform, { customer_id: id, limit: 200, order: "desc" }),
    Settings.getSettings(shop, platform),
  ]);
  const bookings = await Data.attachServiceNames(shop, rows);
  const noShowCount = rows.filter((b) => b.status === "no_show").length;

  return {
    customer,
    bookings,
    totalBookings: rows.length,
    noShowCount,
    labels: Bookings.statusLabels(),
    timezone: settings.timezone,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { shop } = await requireTenant(request, params.connectionId);
  const id = Number(params.customerId);
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "");

  if (intent === "notes") {
    await Data.updateCustomerNotes(shop, id, String(form.get("notes") ?? ""));
    return { saved: true };
  }
  if (intent === "erase") {
    await Data.eraseCustomerData(shop, id);
    return redirect(`/dashboard/${params.connectionId}/customers?erased=1`);
  }
  return { error: "Unknown request." };
}

export default function CustomerDetail({ loaderData, actionData, params }: Route.ComponentProps) {
  const { customer, bookings, totalBookings, noShowCount, labels, timezone } = loaderData;
  const base = `/dashboard/${params.connectionId}`;
  const v = useVocabulary();
  const toast = useToast();

  useEffect(() => {
    if (actionData && "saved" in actionData && actionData.saved) toast("Notes saved");
  }, [actionData]);

  return (
    <div className="flex flex-col gap-[18px]">
      <div>
        <a href={`${base}/customers`} className="btn-link">
          &larr; All {v.customers}
        </a>
      </div>

      <h1 className="page-title">{customer.firstName} {customer.lastName}</h1>

      <div className="grid grid-cols-[1.35fr_1fr] gap-[14px]">
        <div className="flex flex-col gap-[14px]">
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Booking history</h2>
            </div>
            <DataTable
              cols="1.1fr 1.2fr .8fr"
              columns={["When", v.serviceOne ? v.serviceOne.charAt(0).toUpperCase() + v.serviceOne.slice(1) : "Service", "Status"]}
              rows={bookings}
              rowKey={(b) => String(b.id)}
              href={(b) => `${base}/bookings/${b.id}`}
              renderRow={(b) => [
                <span className="num">{formatInZone(b.startUtc, timezone)}</span>,
                <span className="min-w-0 truncate">{b.serviceName}</span>,
                <Badge status={b.status as any} label={labels[b.status as keyof typeof labels]} />,
              ]}
              mobileCard={(b) => (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate font-medium">{b.serviceName}</span>
                    <Badge status={b.status as any} label={labels[b.status as keyof typeof labels]} />
                  </div>
                  <span className="num text-muted">{formatInZone(b.startUtc, timezone)}</span>
                </>
              )}
              empty={
                <EmptyState
                  title={`No ${v.bookingMany} yet`}
                  body={`Once ${customer.firstName || "this client"} books, it shows up here.`}
                />
              }
            />
          </div>
        </div>

        <div className="flex flex-col gap-[14px]">
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Contact</h2>
            </div>
            <div className="card-body flex flex-col gap-[10px] text-body">
              <div className="text-muted">{customer.email}</div>
              {customer.phone && <div className="text-muted">{customer.phone}</div>}
              <div className="mt-2 flex gap-4 text-meta text-muted">
                <span>{totalBookings} total {totalBookings === 1 ? v.bookingOne : v.bookingMany}</span>
                <span>{noShowCount} no-show{noShowCount === 1 ? "" : "s"}</span>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Notes</h2>
            </div>
            <Form method="post">
              <input type="hidden" name="_action" value="notes" />
              <div className="card-body">
                <textarea
                  name="notes"
                  defaultValue={customer.notes ?? ""}
                  placeholder="Private notes — never shown to the client."
                  className="input min-h-[120px]"
                />
              </div>
              <div className="card-footer">
                <button type="submit" className="btn-pri ml-auto">
                  Save notes
                </button>
              </div>
            </Form>
          </div>

          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Danger zone</h2>
            </div>
            <div className="card-body">
              <button
                type="button"
                className="btn-del"
                onClick={() => (document.getElementById("erase-customer") as HTMLDialogElement | null)?.showModal()}
              >
                Delete this client's data
              </button>
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        id="erase-customer"
        title="Delete this client's data?"
        body={`Name, email and phone will be permanently erased. ${totalBookings > 0 ? `${totalBookings} past ${totalBookings === 1 ? v.bookingOne : v.bookingMany} will keep their date and service, but the client name on them will show as "Deleted client". ` : ""}This can't be undone.`}
        confirmLabel="Delete data"
      >
        <Form method="post" id="erase-customer-form">
          <input type="hidden" name="_action" value="erase" />
        </Form>
      </ConfirmDialog>
    </div>
  );
}
