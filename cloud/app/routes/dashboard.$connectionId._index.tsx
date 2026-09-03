import { useState } from "react";
import type { Route } from "./+types/dashboard.$connectionId._index";
import { Metrics, Bookings, Data, Settings, FeatureFlags, ensureSlug } from "getbooqin-core";
// Direct subpath import, not the root barrel — see bookingsShared.ts's
// header comment for why the barrel isn't safe to import from client code.
import { paymentStatusLabels } from "getbooqin-core/booking/bookingsShared";
import { requireTenant } from "~/tenant.server";
import { PageHeader, StatCard, BarChart, MeterRow, EmptyState } from "~/components/ui";
import { SetupChecklist, EmptyStat } from "~/components/onboarding";
import { setupSummary, useVocabulary } from "~/lib/presets";
import { getAppUrl } from "~/lib/env.server";

export const meta: Route.MetaFunction = () => [{ title: "Overview · GetBooqin" }];

const RANGE_DAYS_BACK = 30;
const RANGE_DAYS_FORWARD = 30;

export async function loader({ request, params }: Route.LoaderArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);

  const range = {
    from: new Date(Date.now() - RANGE_DAYS_BACK * 86_400_000),
    to: new Date(Date.now() + RANGE_DAYS_FORWARD * 86_400_000),
  };

  const [overview, pendingCount, allServices, allResources, allTimeBookingCount, settings, occupyingInRange] = await Promise.all([
    Metrics.overview(shop, platform, range),
    Bookings.count(shop, platform, { status: "pending" }),
    Data.catalogServices(shop, platform, false),
    Data.resources(shop, platform, false),
    Bookings.count(shop, platform, {}),
    Settings.getSettings(shop, platform),
    // "Needs attention" — a booking that violates its own business's rules
    // used to have no signal anywhere in the app (Defect Dossier's BQ-07
    // finding). Bounded to the same ±30-day window the rest of this page
    // already uses, and checked in parallel below, so this stays cheap
    // regardless of how many bookings the shop has overall.
    Bookings.query(shop, platform, { statusIn: ["pending", "confirmed"], from: range.from, to: range.to, limit: 500 }),
  ]);
  const bookableResourceCount = await Data.bookableResourceCount(shop, allResources.map((r) => r.id));
  const conflictCount = (await Promise.all(occupyingInRange.map((b) => Bookings.scheduleConflict(shop, b)))).filter((c) => !c.ok).length;
  const unbookableCount = (await Data.unbookableServiceIds(shop, platform)).size;

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
    bookableResourceCount,
    // A manual connection isn't itself a "channel" the way a real Shopify
    // or Stripe integration is — counting it here made the checklist mark
    // "Connect a channel" done for every manual account with nothing
    // actually connected.
    connectedChannels: (platform === "shopify" ? 1 : 0) + (settings.enabled_gateways.includes("stripe") ? 1 : 0),
    channelSetupSkipped: settings.channel_setup_skipped,
    remindersOn: settings.reminder_enabled,
    isManual: platform === "manual",
  };

  // A human-readable link reads better in a social bio than a raw cuid (UX
  // audit's #13 finding) — but only worth generating once there's a real
  // business name to slugify; a manual account that hasn't named itself
  // yet would otherwise get permanently stuck with a slug derived from its
  // opaque manual-<uuid> shop id (ensureSlug never regenerates once set).
  // The cuid link keeps working either way — getPublicConnection resolves
  // both.
  const hasRealName = !!settings.business_name && !(platform === "manual" && settings.business_name === shop);
  const bookingSlug = hasRealName ? await ensureSlug(params.connectionId!, settings.business_name) : params.connectionId;

  return {
    overview,
    pendingCount,
    activeServiceCount,
    range,
    timezone: settings.timezone,
    allTimeBookingCount,
    setupFacts,
    hiddenCards: settings.hidden_overview_cards,
    bookingUrl: `${getAppUrl()}/book/${bookingSlug}`,
    conflictCount,
    unbookableCount,
    // Checked at render time rather than only at the persisted-settings
    // level, since hidden_overview_cards' own default ("hide Revenue until
    // payments exist") only applies going forward — an existing shop whose
    // settings predate that default still had it visible with nothing to
    // show but "No settled payments in range" (Defect Dossier's R2-09
    // finding, second half).
    paymentsAvailable: FeatureFlags.PAYMENTS_ENABLED && settings.enabled_gateways.length > 0,
  };
}

function dateRangeLabel(iso: string | Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: timezone }).format(new Date(iso));
}

// bookingsSeries buckets (metrics.ts's bookingsOverTime) are plain
// "yyyy-MM-dd" keys with no time-of-day meaning, not real instants —
// formatting one against the shop's real timezone (like dateRangeLabel
// above does for actual instants) could shift the displayed day by one.
// timeZone: "UTC" renders the Y-M-D digits as-is, the same trick the public
// booking page's SummaryBar used before it moved to formatInZone.
// Previously the chart just printed the raw key ("2026-09-02") as its
// x-axis labels (Defect Dossier's BQ-10 finding).
function chartDayLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
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
  const { overview, pendingCount, activeServiceCount, range, timezone, allTimeBookingCount, setupFacts, hiddenCards, bookingUrl, conflictCount, unbookableCount, paymentsAvailable } = loaderData;
  const totalBookings = overview.bookingsSeries.reduce((sum, d) => sum + d.count, 0);
  const paymentLabels = paymentStatusLabels();
  const paymentTotal = overview.paymentBreakdown.reduce((sum, p) => sum + p.count, 0);
  const v = useVocabulary();

  if (allTimeBookingCount === 0) {
    return <EmptyOverview connectionId={params.connectionId} setupFacts={setupFacts} bookingUrl={bookingUrl} />;
  }

  const hidden = new Set(hiddenCards);
  const showStats = !hidden.has("stats");
  const showNoShow = !hidden.has("noShow");
  const showChart = !hidden.has("chart");
  const showRevenue = !hidden.has("revenue") && paymentsAvailable;
  const showTopServices = !hidden.has("topServices");
  const showUtilisation = !hidden.has("utilisation");
  const statCount = (showStats ? 3 : 0) + (showNoShow ? 1 : 0);

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        title="Overview"
        // Pinned locale AND the business's own timezone, not the runtime's
        // default (which differs between the Node server and the browser,
        // and crashed hydration entirely when they disagreed) or "en-US"
        // regardless of where the business actually is (UX audit's #3
        // finding — same formatting sweep as bookings/bookings.$bookingId/
        // timeoff). A date range, not a specific instant, so no zone
        // abbreviation is appended the way formatInZone would.
        subtitle={`${dateRangeLabel(range.from, timezone)} – ${dateRangeLabel(range.to, timezone)}`}
      />

      <ShareLinkCard bookingUrl={bookingUrl} vocab={v} />

      {/* A booking that violates its own business's rules used to have no
          signal anywhere in the app (Defect Dossier's BQ-07 finding). The
          noun used to stay plural regardless of count ("1 consultations
          needs attention") even though the verb already agreed correctly —
          Defect Dossier's R2-05 finding. */}
      {conflictCount > 0 && (
        <a href={`/dashboard/${params.connectionId}/bookings`} className="card flex items-center justify-between gap-3 border-l-[3px] border-l-warn p-[14px] no-underline hover:no-underline">
          <span className="text-body font-medium text-ink">
            {conflictCount} {conflictCount === 1 ? v.bookingOne : v.bookingMany} need{conflictCount === 1 ? "s" : ""} attention — outside your own business hours, a time-off block, or overlapping another
          </span>
          <span className="text-faint">›</span>
        </a>
      )}

      {/* An active service with nobody assigned to deliver it used to look
          identical to a normal one everywhere in the dashboard (Defect
          Dossier's R2-04 finding). */}
      {unbookableCount > 0 && (
        <a href={`/dashboard/${params.connectionId}/services`} className="card flex items-center justify-between gap-3 border-l-[3px] border-l-warn p-[14px] no-underline hover:no-underline">
          <span className="text-body font-medium text-ink">
            {unbookableCount} {unbookableCount === 1 ? v.serviceOne : v.services.toLowerCase()} {unbookableCount === 1 ? "has" : "have"} no one assigned — not bookable online right now
          </span>
          <span className="text-faint">›</span>
        </a>
      )}

      {statCount > 0 && (
        <div className={`grid gap-[14px] ${STAT_GRID[statCount]}`}>
          {showStats && (
            <>
              <StatCard label={`${v.bookingTitle} in range`} value={String(totalBookings)} />
              <StatCard label="Pending approval" value={String(pendingCount)} tone={pendingCount > 0 ? "warn" : "muted"} />
              <StatCard label={`Active ${v.services.toLowerCase()}`} value={String(activeServiceCount)} />
            </>
          )}
          {/* A confident "0%" when nothing has actually been completed yet
              reads as "no-shows are fine here" rather than "no data yet" —
              the same zero-denominator problem as utilisation below
              (Defect Dossier's BQ-35 finding, item 2). */}
          {showNoShow && (
            <StatCard
              label="No-show rate"
              value={overview.noShow.total > 0 ? `${(overview.noShow.rate * 100).toFixed(1)}%` : "—"}
              note={overview.noShow.total > 0 ? undefined : `No completed ${v.bookingMany} in this range`}
              tone={overview.noShow.total > 0 && overview.noShow.rate > 0.1 ? "danger" : "muted"}
            />
          )}
        </div>
      )}

      {showChart && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">{v.bookingTitle}</h2>
          </div>
          <div className="card-body">
            <BarChart data={overview.bookingsSeries} formatLabel={chartDayLabel} />
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
                <h2 className="card-title">Top {v.services.toLowerCase()}</h2>
              </div>
              <div className="card-body">
                {overview.topServices.length === 0 ? (
                  <p className="m-0 text-body text-muted">No {v.bookingMany} in range yet.</p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {overview.topServices.map((s) => (
                      <div key={s.serviceId} className="flex items-center justify-between gap-3 text-[13px]">
                        <span className="min-w-0 truncate font-medium">{s.name || `Service #${s.serviceId}`}</span>
                        <span className="num shrink-0 text-subtle">
                          {s.bookings} {s.bookings === 1 ? v.bookingOne : v.bookingMany}
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
            {/* British spelling + real title case, matching account.tsx's
                Business-template preview and ui.tsx's MeterRow comment —
                this heading used to lowercase the whole (possibly
                multi-word) term first and re-capitalize only the first
                character, so automotive's "Service Bay" read as "Service
                bay utilization" here while Settings showed "Service Bay
                utilisation" for the same preset (UX audit's #12 finding). */}
            <h2 className="card-title">{v.resourceOneTitle} utilisation</h2>
          </div>
          <div className="card-body flex flex-col gap-4">
            {overview.resourceUtilization.length === 0 ? (
              <p className="m-0 text-body text-muted">No active {v.resources.toLowerCase()}.</p>
            ) : (
              overview.resourceUtilization.map((r) => {
                // One elapsed-only figure read as a permanent, confident
                // 0.0% for any range that hasn't started yet — no way to
                // tell "nothing happened so far" apart from "nothing was
                // ever booked" (Defect Dossier's R2-07 finding, the direct
                // follow-on from BQ-35's own hours/one-decimal fix). Now
                // two figures: "So far" (elapsed part of the range, hidden
                // entirely when nothing has elapsed yet) and "Booked
                // ahead" (the remaining, future part).
                return (
                  <div key={r.resourceId} className="flex flex-col gap-1.5">
                    <span className="truncate text-[13px] font-semibold text-ink">{r.resourceName}</span>
                    <div className="flex flex-col gap-1.5 pl-1">
                      {r.soFar && (
                        <MeterRow
                          name="So far"
                          meta={
                            r.soFar.availableMinutes === 0
                              ? "No scheduled hours so far in this range"
                              : `${(r.soFar.bookedMinutes / 60).toFixed(1)}h booked of ${(r.soFar.availableMinutes / 60).toFixed(1)}h available`
                          }
                          ratio={r.soFar.utilization}
                          right={r.soFar.availableMinutes === 0 ? "—" : `${(r.soFar.utilization * 100).toFixed(1)}%`}
                        />
                      )}
                      <MeterRow
                        name="Booked ahead"
                        meta={
                          r.bookedAhead.availableMinutes === 0
                            ? "No scheduled hours ahead in this range"
                            : `${(r.bookedAhead.bookedMinutes / 60).toFixed(1)}h booked of ${(r.bookedAhead.availableMinutes / 60).toFixed(1)}h available`
                        }
                        ratio={r.bookedAhead.utilization}
                        right={r.bookedAhead.availableMinutes === 0 ? "—" : `${(r.bookedAhead.utilization * 100).toFixed(1)}%`}
                      />
                    </div>
                  </div>
                );
              })
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
  bookingUrl,
}: {
  connectionId: string;
  setupFacts: Route.ComponentProps["loaderData"]["setupFacts"];
  bookingUrl: string;
}) {
  const base = `/dashboard/${connectionId}`;
  const summary = setupSummary(setupFacts);
  const v = useVocabulary();
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

      {/* "Waiting on setup" stayed on these two tiles even once setup was
          genuinely finished (6 of 6 done) and the merchant was just
          waiting on their first real booking — the same disagreement as
          the checklist card itself (UX audit's C3 finding). */}
      <div className="grid grid-cols-2 gap-[14px] md:grid-cols-4">
        <EmptyStat label={v.bookingTitle} value="0" note={summary.complete ? `No ${v.bookingMany} yet` : "Waiting on setup"} />
        <EmptyStat label="Pending approval" value="0" note={summary.complete ? "Nothing pending" : "Waiting on setup"} />
        <EmptyStat
          label={`Active ${v.services.toLowerCase()}`}
          value={String(setupFacts.serviceCount)}
          note={setupFacts.isManual ? `Added from ${v.services}` : "From your store catalogue"}
        />
        <EmptyStat label="No-show rate" value="—" note={`Needs ${v.bookingMany} first`} />
      </div>

      <SetupChecklist
        summary={summary}
        hrefs={hrefs}
        resumeHref={firstUnfinished ? hrefs[firstUnfinished.key] : hrefs.services}
      />

      <ShareLinkCard bookingUrl={bookingUrl} vocab={v} />

      <div className="card">
        <EmptyState
          icon={
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2.5" y="3.5" width="13" height="12" rx="2" />
              <path d="M2.5 7h13M6 2v3M12 2v3" strokeLinecap="round" />
            </svg>
          }
          title={`No ${v.bookingMany} yet`}
          body="Once your setup is finished and someone books, activity shows up here."
        />
      </div>
    </div>
  );
}

// The one link every merchant needs regardless of Shopify/WordPress/no
// platform at all — works from onboarding.tsx's very first "Go live without
// Shopify" moment onward, since booking_page_url is now pinned there. Shown
// on both the empty and populated Overview so it's never buried once
// there's real activity to scroll past.
function ShareLinkCard({ bookingUrl, vocab }: { bookingUrl: string; vocab: ReturnType<typeof useVocabulary> }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(bookingUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission denied or unavailable — the link is still
      // right there to select/copy by hand.
    }
  }

  return (
    <div className="card p-[18px]">
      <h2 className="card-title mb-1">Share your booking link</h2>
      <p className="m-0 mb-3 text-meta text-muted">
        Send this anywhere — texts, social bios, email — and customers can book {vocab.bookingMany} directly, no store or website required.
      </p>
      <div className="flex items-center gap-2">
        <input readOnly value={bookingUrl} onFocus={(e) => e.currentTarget.select()} className="input min-w-0 flex-1 truncate" />
        <button type="button" className="btn-sec shrink-0" onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
      </div>
    </div>
  );
}
