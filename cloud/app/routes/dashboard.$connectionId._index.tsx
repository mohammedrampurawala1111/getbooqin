import type { Route } from "./+types/dashboard.$connectionId._index";
import { Metrics, Bookings, Data, Settings } from "getbooqin-core";
// Direct subpath import, not the root barrel — see bookingsShared.ts's
// header comment for why the barrel isn't safe to import from client code.
import { paymentStatusLabels } from "getbooqin-core/booking/bookingsShared";
import { requireTenant } from "~/tenant.server";
import { PageHeader, StatCard, BarChart, MeterRow, EmptyState } from "~/components/ui";
import { SetupChecklist, EmptyStat } from "~/components/onboarding";
import { setupSummary } from "~/lib/presets";

export const meta: Route.MetaFunction = () => [{ title: "Overview · GetBooqin" }];

const RANGE_DAYS_BACK = 30;
const RANGE_DAYS_FORWARD = 30;

export async function loader({ request, params }: Route.LoaderArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);

  const range = {
    from: new Date(Date.now() - RANGE_DAYS_BACK * 86_400_000),
    to: new Date(Date.now() + RANGE_DAYS_FORWARD * 86_400_000),
  };

  const [overview, pendingCount, allServices, allResources, allTimeBookingCount, settings] = await Promise.all([
    Metrics.overview(shop, platform, range),
    Bookings.count(shop, platform, { status: "pending" }),
    Data.catalogServices(shop, platform, false),
    Data.resources(shop, platform, false),
    Bookings.count(shop, platform, {}),
    Settings.getSettings(shop, platform),
  ]);

  const activeServiceCount = allServices.filter((s) => s.status).length;

  const setupFacts = {
    presetId: settings.preset,
    // Same "still carries its raw manual-<uuid> connection id" check as
    // the sidebar label and Settings' business-name field use — surfaced
    // here as an actual checklist item instead of a silent gap for
    // accounts that never got a real name at setup (UX audit's D2
    // finding).
    businessNamed: !(platform === "manual" && settings.business_name === shop),
    serviceCount: allServices.length,
    resourceCount: allResources.length,
    // A manual connection isn't itself a "channel" the way a real Shopify
    // or Stripe integration is — counting it here made the checklist mark
    // "Connect a channel" done for every manual account with nothing
    // actually connected.
    connectedChannels: (platform === "shopify" ? 1 : 0) + (settings.enabled_gateways.includes("stripe") ? 1 : 0),
    remindersOn: settings.reminder_enabled,
    isManual: platform === "manual",
  };

  return {
    overview,
    pendingCount,
    activeServiceCount,
    range,
    allTimeBookingCount,
    setupFacts,
    hiddenCards: settings.hidden_overview_cards,
  };
}

const PAYMENT_TINT: Record<string, string> = {
  paid: "bg-chart-ok",
  not_required: "bg-chart-off",
  unpaid: "bg-chart-warn",
  refunded: "bg-chart-off",
  failed: "bg-danger",
};

// Column count for the stats row — "stats" (bookings/pending/active
// services) and "noShow" are two separately toggleable Business template
// cards (see components/account.tsx's overviewCards) sharing one grid, so
// the count of literal grid-cols-N classes below has to cover every
// combination: 0 (skip the row), 3, or 4.
// grid-cols-4 with no breakpoint squeezed four tiles into ~72px each at a
// 389px viewport — barely 34px of usable content after padding, wrapping
// "No-show rate" onto three lines (UX audit's M5 finding).
const STAT_GRID: Record<number, string> = { 3: "grid-cols-2 md:grid-cols-3", 4: "grid-cols-2 md:grid-cols-4" };

export default function Overview({ loaderData, params }: Route.ComponentProps) {
  const { overview, pendingCount, activeServiceCount, range, allTimeBookingCount, setupFacts, hiddenCards } = loaderData;
  const totalBookings = overview.bookingsSeries.reduce((sum, d) => sum + d.count, 0);
  const paymentLabels = paymentStatusLabels();
  const paymentTotal = overview.paymentBreakdown.reduce((sum, p) => sum + p.count, 0);

  if (allTimeBookingCount === 0) {
    return <EmptyOverview connectionId={params.connectionId} setupFacts={setupFacts} />;
  }

  const hidden = new Set(hiddenCards);
  const showStats = !hidden.has("stats");
  const showNoShow = !hidden.has("noShow");
  const showChart = !hidden.has("chart");
  const showRevenue = !hidden.has("revenue");
  const showTopServices = !hidden.has("topServices");
  const showUtilisation = !hidden.has("utilisation");
  const statCount = (showStats ? 3 : 0) + (showNoShow ? 1 : 0);

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        title="Overview"
        // Pinned locale: toLocaleDateString() with no argument uses the
        // runtime's default locale, which differs between the Node server
        // and the browser — that mismatch made SSR and hydration render
        // different text ("7/28/2026" vs "28/07/2026") and crashed
        // hydration entirely, falling back to an unstyled client-only
        // render. Same fix applied to every other toLocaleString() call in
        // this app (bookings, bookings.$bookingId, timeoff).
        subtitle={`${new Date(range.from).toLocaleDateString("en-US")} – ${new Date(range.to).toLocaleDateString("en-US")}`}
      />

      {statCount > 0 && (
        <div className={`grid gap-[14px] ${STAT_GRID[statCount]}`}>
          {showStats && (
            <>
              <StatCard label="Bookings in range" value={String(totalBookings)} />
              <StatCard label="Pending approval" value={String(pendingCount)} tone={pendingCount > 0 ? "warn" : "muted"} />
              <StatCard label="Active services" value={String(activeServiceCount)} />
            </>
          )}
          {showNoShow && (
            <StatCard
              label="No-show rate"
              value={`${Math.round(overview.noShow.rate * 100)}%`}
              tone={overview.noShow.rate > 0.1 ? "danger" : "muted"}
            />
          )}
        </div>
      )}

      {showChart && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Bookings</h2>
          </div>
          <div className="card-body">
            <BarChart data={overview.bookingsSeries} />
          </div>
        </div>
      )}

      {(showRevenue || showTopServices) && (
        <div className={`grid gap-[14px] ${showRevenue && showTopServices ? "grid-cols-[1.15fr_1fr]" : "grid-cols-1"}`}>
          {showRevenue && (
            <div className="card">
              <div className="card-header">
                <h2 className="card-title">Revenue</h2>
              </div>
              <div className="card-body flex flex-col gap-4">
                {overview.revenueByCurrency.length === 0 ? (
                  <p className="m-0 text-body text-muted">No settled payments in range.</p>
                ) : (
                  <div className="flex flex-wrap gap-5">
                    {overview.revenueByCurrency.map((r) => (
                      <div key={r.currency} className="flex flex-col gap-[2px]">
                        <span className="text-[12px] font-medium text-muted">{r.currency}</span>
                        <span className="num text-stat font-medium tracking-[-0.03em]">{r.amount.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                )}

                {overview.paymentBreakdown.length > 0 && paymentTotal > 0 && (
                  <div className="flex flex-col gap-[7px]">
                    <div className="flex h-2 overflow-hidden rounded-[5px] bg-row">
                      {overview.paymentBreakdown.map((p) => (
                        <div
                          key={p.status}
                          className={PAYMENT_TINT[p.status] ?? "bg-chart-off"}
                          style={{ width: `${(p.count / paymentTotal) * 100}%` }}
                        />
                      ))}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-muted">
                      {overview.paymentBreakdown.map((p) => (
                        <span key={p.status} className="num">
                          {paymentLabels[p.status] ?? p.status}: {p.count}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {showTopServices && (
            <div className="card">
              <div className="card-header">
                <h2 className="card-title">Top services</h2>
              </div>
              <div className="card-body">
                {overview.topServices.length === 0 ? (
                  <p className="m-0 text-body text-muted">No bookings in range yet.</p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {overview.topServices.map((s) => (
                      <div key={s.serviceId} className="flex items-center justify-between gap-3 text-[13px]">
                        <span className="min-w-0 truncate font-medium">{s.name || `Service #${s.serviceId}`}</span>
                        <span className="num shrink-0 text-subtle">
                          {s.bookings} booking{s.bookings === 1 ? "" : "s"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {showUtilisation && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Resource utilization</h2>
          </div>
          <div className="card-body flex flex-col gap-4">
            {overview.resourceUtilization.length === 0 ? (
              <p className="m-0 text-body text-muted">No active resources.</p>
            ) : (
              overview.resourceUtilization.map((r) => (
                <MeterRow
                  key={r.resourceId}
                  name={r.resourceName}
                  meta={`${Math.round(r.bookedMinutes)} of ${Math.round(r.availableMinutes)} min`}
                  ratio={r.utilization}
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Every checklist task has a real page that edits that fact for real —
// deep-link straight there instead of routing back through the
// pre-connection-only onboarding wizard (routes/onboarding.tsx).
function EmptyOverview({
  connectionId,
  setupFacts,
}: {
  connectionId: string;
  setupFacts: Route.ComponentProps["loaderData"]["setupFacts"];
}) {
  const base = `/dashboard/${connectionId}`;
  const summary = setupSummary(setupFacts);
  const hrefs: Record<string, string> = {
    // Was ?tab=… — stale since Settings moved off tabs onto the rail
    // (?page=…); every one of these silently landed on General instead of
    // the section it claimed to deep-link to.
    name: `${base}/settings?page=general`,
    preset: `${base}/settings?page=template`,
    services: `${base}/services`,
    resources: `${base}/resources/new`,
    channel: `${base}/settings?page=integrations`,
    reminders: `${base}/settings?page=notifications`,
  };
  const firstUnfinished = summary.tasks.find((t) => !t.done);

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader title="Overview" subtitle={summary.headline} />

      <div className="grid grid-cols-2 gap-[14px] md:grid-cols-4">
        <EmptyStat label="Bookings" value="0" note="Waiting on setup" />
        <EmptyStat label="Pending approval" value="0" note="Waiting on setup" />
        <EmptyStat
          label="Active services"
          value={String(setupFacts.serviceCount)}
          note={setupFacts.isManual ? "Added from Services" : "From your store catalogue"}
        />
        <EmptyStat label="No-show rate" value="—" note="Needs bookings first" />
      </div>

      <SetupChecklist
        summary={summary}
        hrefs={hrefs}
        resumeHref={firstUnfinished ? hrefs[firstUnfinished.key] : hrefs.services}
      />

      <div className="card">
        <EmptyState
          icon={
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2.5" y="3.5" width="13" height="12" rx="2" />
              <path d="M2.5 7h13M6 2v3M12 2v3" strokeLinecap="round" />
            </svg>
          }
          title="No bookings yet"
          body="Once your setup is finished and someone books, activity shows up here."
        />
      </div>
    </div>
  );
}
