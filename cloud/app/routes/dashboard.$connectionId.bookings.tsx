import { Form } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.bookings";
import { Bookings, Data } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { PageHeader, Badge, EmptyState } from "~/components/ui";

export const meta: Route.MetaFunction = () => [{ title: "Bookings · GetBooqin" }];

export async function loader({ request, params }: Route.LoaderArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "";
  const search = url.searchParams.get("q") || "";
  const filtered = !!(status || search);

  const [rows, totalCount] = await Promise.all([
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
  ]);
  const withNames = await Data.attachServiceNames(shop, rows);

  return { bookings: withNames, status, search, filtered, totalCount, statuses: Bookings.STATUSES, labels: Bookings.statusLabels() };
}

export default function BookingsList({ loaderData, params }: Route.ComponentProps) {
  const { bookings, status, search, filtered, totalCount, statuses, labels } = loaderData;
  const base = `/dashboard/${params.connectionId}`;
  const noBookingsAtAll = !filtered && totalCount === 0;

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
            icon={
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="2.5" y="3.5" width="13" height="12" rx="2" />
                <path d="M2.5 7h13M6 2v3M12 2v3" strokeLinecap="round" />
              </svg>
            }
            title={noBookingsAtAll ? "No bookings yet" : "No bookings match this filter"}
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
