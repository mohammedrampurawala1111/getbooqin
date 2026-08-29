import { Form, data, redirect } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.bookings.$bookingId";
import { Bookings, Data, Settings } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { AlertError, Badge, Field, Input, ConfirmDialog } from "~/components/ui";

export const meta: Route.MetaFunction = () => [{ title: "Booking · GetBooqin" }];

export async function loader({ request, params }: Route.LoaderArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  const id = Number(params.bookingId);

  const booking = await Bookings.get(shop, id);
  if (!booking) throw data("Booking not found", { status: 404 });

  const [service, resource, customer, resourceOptions, settings] = await Promise.all([
    Data.catalogService(shop, booking.serviceId),
    Data.resource(shop, booking.resourceId),
    Data.customer(shop, booking.customerId),
    Data.resourcesForService(shop, platform, booking.serviceId),
    Settings.getSettings(shop, platform),
  ]);

  const allowedTransitions = Bookings.TRANSITIONS[booking.status as Bookings.BookingStatus] ?? [];

  return { booking, service, resource, customer, resourceOptions, settings, allowedTransitions, labels: Bookings.statusLabels() };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  const id = Number(params.bookingId);
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "");

  try {
    if (intent === "status") {
      await Bookings.setStatus(shop, id, String(form.get("status")));
    } else if (intent === "decline") {
      await Bookings.decline(shop, id, String(form.get("reason") ?? ""));
    } else if (intent === "cancel") {
      await Bookings.setStatus(shop, id, "cancelled", String(form.get("reason") ?? ""));
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
        Number(form.get("resource_id") ?? booking?.resourceId ?? 0)
      );
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Something went wrong." };
  }

  return redirect(`/dashboard/${params.connectionId}/bookings/${id}`);
}

export default function BookingDetail({ loaderData, actionData, params }: Route.ComponentProps) {
  const { booking, service, resource, customer, resourceOptions, allowedTransitions, labels } = loaderData;
  const base = `/dashboard/${params.connectionId}`;
  const canCancel = ["pending", "confirmed"].includes(booking.status);
  const transitionsExceptCancel = allowedTransitions.filter((s) => s !== "cancelled");

  return (
    <div className="flex flex-col gap-[18px]">
      <div>
        <a href={`${base}/bookings`} className="btn-link">
          &larr; All bookings
        </a>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="page-title">Booking #{booking.id}</h1>
          <Badge status={booking.status as any} label={labels[booking.status as keyof typeof labels]} />
        </div>

        {(transitionsExceptCancel.length > 0 || canCancel) && (
          <div className="flex flex-wrap gap-2">
            <Form method="post" className="flex flex-wrap gap-2">
              <input type="hidden" name="_action" value="status" />
              {transitionsExceptCancel.map((s, i) => (
                <button key={s} type="submit" name="status" value={s} className={i === 0 ? "btn-pri" : "btn-sec"}>
                  Mark {labels[s]}
                </button>
              ))}
            </Form>
            {canCancel && (
              <button
                type="button"
                className="btn-del"
                onClick={() =>
                  (document.getElementById("cancel-booking") as HTMLDialogElement | null)?.showModal()
                }
              >
                Cancel booking
              </button>
            )}
          </div>
        )}
      </div>

      {actionData?.error && <AlertError>{actionData.error}</AlertError>}

      <div className="grid grid-cols-[1.35fr_1fr] gap-[14px]">
        <div className="flex flex-col gap-[14px]">
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Details</h2>
            </div>
            <div className="card-body">
              <div className="kv">
                <span className="kv-key">When</span>
                <span className="kv-val num">{new Date(booking.startUtc).toLocaleString("en-US")}</span>
              </div>
              <div className="kv">
                <span className="kv-key">Service</span>
                <span className="kv-val">{service?.name ?? "—"}</span>
              </div>
              <div className="kv">
                <span className="kv-key">Resource</span>
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

          {canCancel && (
            <div className="card">
              <div className="card-header">
                <h2 className="card-title">Reschedule</h2>
              </div>
              <div className="card-body">
                <Form method="post" className="flex flex-col gap-[14px]">
                  <input type="hidden" name="_action" value="reschedule" />
                  <div className="grid grid-cols-3 gap-3">
                    <Field label="Date">
                      <Input type="date" name="date" required />
                    </Field>
                    <Field label="Time">
                      <Input type="time" name="time" required />
                    </Field>
                    <Field label="Resource">
                      <select name="resource_id" defaultValue={String(booking.resourceId)} className="input">
                        {resourceOptions.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <div>
                    <button type="submit" className="btn-sec">
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
              <h2 className="card-title">Customer</h2>
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
        title="Cancel this booking?"
        body="The customer will be notified. This can't be undone."
        confirmLabel="Cancel booking"
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
