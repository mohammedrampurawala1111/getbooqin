import { Form, Link, useSearchParams } from "react-router";
import type { Route } from "./+types/admin._index";
import { AdminAccounts, Checkout, Env, Jobs } from "getbooqin-core";
import { requirePlatformAdmin } from "~/admin.server";

/**
 * The accounts table. Also the closest thing to an analytics dashboard
 * the MVP has, which is why it carries the counts rather than making an
 * admin open each account to see them.
 */
export async function loader({ request }: Route.LoaderArgs) {
  await requirePlatformAdmin(request);
  const url = new URL(request.url);
  const filter = (url.searchParams.get("filter") ?? "all") as AdminAccounts.AccountFilter;
  const search = url.searchParams.get("q") ?? "";

  const [accounts, jobs] = await Promise.all([
    AdminAccounts.list({ filter, search }),
    // The reminder sweep's health, surfaced here as well as on
    // /healthz?strict=1 — Phase 0 made it observable, this is where
    // someone actually looks.
    Jobs.statuses(),
  ]);

  // Two things a running deployment knows about itself that nobody
  // finds out from a screen full of accounts: which price points can
  // actually be charged, and whether the credentials behind them are
  // the real ones. Both are read here rather than from a checklist,
  // because a checklist is a record of an intention and this is a
  // reading of the process that is serving customers right now.
  const coverage = Checkout.billingCoverage();
  const readiness = Env.productionWarnings();

  const counts = {
    total: accounts.length,
    trialing: accounts.filter((a) => a.status === "trialing").length,
    expiring: accounts.filter((a) => a.status === "trialing" && (a.trialDaysLeft ?? 99) <= 7).length,
    paying: accounts.filter((a) => a.status === "active" && a.billingProvider !== "manual").length,
    pastDue: accounts.filter((a) => a.status === "past_due").length,
  };

  return { accounts, jobs, counts, coverage, readiness, filter, search };
}

const FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All" },
  { value: "trialing", label: "Trialing" },
  { value: "expiring", label: "Expiring ≤7d" },
  { value: "paying", label: "Paying" },
  { value: "past_due", label: "Past due" },
  { value: "free", label: "Free" },
];

function date(value: string | Date | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}

export default function AdminAccountsList({ loaderData }: Route.ComponentProps) {
  const { accounts, jobs, counts, coverage, readiness } = loaderData;
  const [params] = useSearchParams();
  const active = params.get("filter") ?? "all";

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="grid grid-cols-2 gap-[10px] md:grid-cols-5">
        {[
          ["Accounts", counts.total, ""],
          ["Trialing", counts.trialing, ""],
          ["Expiring ≤7d", counts.expiring, counts.expiring > 0 ? "text-warn" : ""],
          ["Paying", counts.paying, ""],
          ["Past due", counts.pastDue, counts.pastDue > 0 ? "text-danger" : ""],
        ].map(([label, value, tone]) => (
          <div key={String(label)} className="card px-[14px] py-[11px]">
            <span className="block text-[11.5px] text-muted">{label}</span>
            <span className={`num text-[20px] font-medium tracking-[-0.03em] ${tone}`}>{value}</span>
          </div>
        ))}
      </div>

      {/* Not decoration. Every item here is a state in which the app
          serves perfectly and takes no money, or sends a customer a
          link on a domain that isn't ours — failures whose defining
          property is that nothing else reports them. */}
      {readiness.length > 0 && (
        <div className="card border-danger">
          <div className="card-header">
            <h2 className="card-title text-danger">Not production-ready</h2>
          </div>
          <ul className="m-0 flex list-none flex-col gap-[10px] p-[14px]">
            {readiness.map((w) => (
              <li key={w.problem} className="text-[12.5px]">
                <span className="block font-medium text-danger">{w.problem}</span>
                <span className="block text-muted">{w.fix}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {coverage.sellableCount < coverage.totalCount && (
        <div className="card">
          <div className="card-header flex-wrap gap-2">
            <h2 className="card-title">
              Billing coverage — {coverage.sellableCount} of {coverage.totalCount} price points can be charged
            </h2>
          </div>
          <div className="p-[14px] text-[12.5px]">
            {coverage.deadCurrencies.length > 0 && (
              <p className="m-0 mb-[10px] rounded-[8px] bg-danger-bg px-3 py-2 font-medium text-danger">
                Nothing can be bought in {coverage.deadCurrencies.join(", ")}. A merchant billed in{" "}
                {coverage.deadCurrencies.length === 1 ? "that currency" : "those currencies"} reaches a Billing
                screen with no plan on it.
              </p>
            )}
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="text-[11.5px] text-muted">
                    <th className="py-1 pr-3 font-normal">Price</th>
                    <th className="py-1 pr-3 font-normal">Rail</th>
                    <th className="py-1 pr-3 font-normal">Mode</th>
                    <th className="py-1 font-normal">Chargeable</th>
                  </tr>
                </thead>
                <tbody>
                  {coverage.prices.filter((p) => !p.sellable).map((p) => (
                    <tr key={`${p.plan}:${p.currency}:${p.cycle}`} className="border-t border-line">
                      <td className="py-[5px] pr-3 capitalize">{p.plan} · {p.currency} · {p.cycle}</td>
                      <td className="py-[5px] pr-3 capitalize">{p.provider}</td>
                      <td className="py-[5px] pr-3">{p.mode}</td>
                      <td className="py-[5px] text-danger">No plan id</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="m-0 mt-[10px] text-muted">
              A plan is created at the provider by hand and its id pasted into <code>core/src/billing/plans.ts</code>.
              See docs/launch-runbook.md.
            </p>
          </div>
        </div>
      )}

      {/* Silent job failure is the thing Phase 0 set out to make visible;
          this is where a human sees it without curling a health check. */}
      {jobs.map((job) =>
        job.stale ? (
          <p key={job.name} className="m-0 rounded-[8px] bg-danger-bg px-3 py-2 text-[12.5px] font-medium text-danger">
            Job “{job.name}” hasn't succeeded in {job.minutesSinceSuccess ?? "—"} minutes
            {job.lastError ? ` — last error: ${job.lastError}` : ""}.
          </p>
        ) : null
      )}

      <div className="card">
        <div className="card-header flex-wrap gap-2">
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((f) => (
              <Link
                key={f.value}
                to={f.value === "all" ? "/admin" : `/admin?filter=${f.value}`}
                className={`rounded-full border px-[10px] py-[3px] text-meta no-underline hover:no-underline ${active === f.value ? "border-brand-500 bg-brand-50 text-brand-600" : "border-line text-muted"}`}
              >
                {f.label}
              </Link>
            ))}
          </div>
          <Form method="get" className="flex gap-2">
            {active !== "all" && <input type="hidden" name="filter" value={active} />}
            <input name="q" defaultValue={loaderData.search} placeholder="Business, email or shop" className="input w-[220px]" />
            <button type="submit" className="btn-sec">Search</button>
          </Form>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[11.5px] text-muted">
                <th className="px-[18px] py-[9px] font-medium">Business</th>
                <th className="px-2 py-[9px] font-medium">Owner</th>
                <th className="px-2 py-[9px] font-medium">Plan</th>
                <th className="px-2 py-[9px] font-medium">Status</th>
                <th className="px-2 py-[9px] font-medium">Trial ends</th>
                <th className="num px-2 py-[9px] text-right font-medium">Bookings</th>
                <th className="num px-2 py-[9px] text-right font-medium">Staff</th>
                <th className="px-2 py-[9px]" />
              </tr>
            </thead>
            <tbody>
              {accounts.length === 0 && (
                <tr><td colSpan={8} className="px-[18px] py-4 text-muted">No accounts match.</td></tr>
              )}
              {accounts.map((a) => (
                <tr key={a.connectionId} className="border-b border-row last:border-b-0">
                  <td className="px-[18px] py-[9px]">
                    <span className="block max-w-[240px] truncate font-medium">{a.businessName}</span>
                    <span className="block max-w-[240px] truncate text-[11.5px] text-subtle">{a.platform}</span>
                  </td>
                  <td className="max-w-[200px] truncate px-2 py-[9px] text-muted">{a.ownerEmail}</td>
                  <td className="px-2 py-[9px]">
                    {a.planName}
                    {a.billingProvider === "manual" && a.status === "active" && (
                      <span className="ml-1 badge-neutral">comped</span>
                    )}
                  </td>
                  <td className="px-2 py-[9px]">
                    <span className={a.status === "past_due" ? "text-danger" : a.status === "trialing" ? "text-brand-600" : ""}>
                      {a.status}
                    </span>
                  </td>
                  <td className={`px-2 py-[9px] ${(a.trialDaysLeft ?? 99) <= 7 ? "text-warn" : "text-muted"}`}>
                    {a.trialEndsAt ? `${date(a.trialEndsAt)} (${a.trialDaysLeft}d)` : "—"}
                  </td>
                  <td className="num px-2 py-[9px] text-right">{a.bookingsThisMonth}</td>
                  <td className="num px-2 py-[9px] text-right">{a.resourceCount}</td>
                  <td className="px-2 py-[9px] text-right">
                    <Link to={`/admin/accounts/${a.connectionId}`} className="btn-link">Open</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
