import { Form } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.bookings";
import { Bookings, Data } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { PageHeader, Badge, EmptyState } from "~/components/ui";

export async function loader({ request, params }: Route.LoaderArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "";
  const search = url.searchParams.get("q") || "";

  const rows = await Bookings.query(shop, platform, {
    ...(status ? { status } : {}),
    ...(search ? { search } : {}),
    limit: 100,
  });
  const withNames = await Data.attachServiceNames(shop, rows);

  return { bookings: withNames, status, search, statuses: Bookings.STATUSES, labels: Bookings.statusLabels() };
}

export default function BookingsList({ loaderData, params }: Route.ComponentProps) {
  const { bookings, status, search, statuses, labels } = loaderData;
  const base = `/dashboard/${params.connectionId}`;

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader title="Bookings" />

      <div className="card">
        <div className="card-header">
          <Form method="get" className="flex w-full flex-wrap items-center gap-2">
            <select name="status" defaultValue={status} className="input w-auto">
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

        {bookings.length === 0 ? (
          <EmptyState
            title="No bookings match this filter"
            body="Try a different status or search term."
            action={
              <a href={`${base}/bookings`} className="btn-sec">
                Clear filters
              </a>
            }
          />
        ) : (
          <>
            <div className="thead" style={{ gridTemplateColumns: "1.05fr 1.25fr .95fr 1.15fr .8fr .8fr 24px" }}>
              <div className="th">When</div>
              <div className="th">Service</div>
              <div className="th">Resource</div>
              <div className="th">Customer</div>
              <div className="th">Status</div>
              <div className="th">Payment</div>
              <div />
            </div>
            {bookings.map((b) => (
              <a
                key={b.id}
                href={`${base}/bookings/${b.id}`}
                className="trow no-underline text-ink hover:no-underline cursor-pointer"
                style={{ gridTemplateColumns: "1.05fr 1.25fr .95fr 1.15fr .8fr .8fr 24px" }}
              >
                <span className="num min-w-0">{new Date(b.startUtc).toLocaleString("en-US")}</span>
                <span className="min-w-0 truncate">{b.serviceName}</span>
                <span className="min-w-0 truncate">{b.resource.name}</span>
                <span className="min-w-0 truncate">
                  {b.customer.firstName} {b.customer.lastName}
                </span>
                <span className="min-w-0">
                  <Badge status={b.status as any} label={labels[b.status as keyof typeof labels]} />
                </span>
                <span className="min-w-0">
                  <Badge status={b.paymentStatus as any} />
                </span>
                <span className="text-faint">›</span>
              </a>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
