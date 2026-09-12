import { Form, Link, useSearchParams } from "react-router";
import type { Route } from "./+types/admin._index";
import { AdminAccounts, Jobs } from "getbooqin-core";
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

  const counts = {
    total: accounts.length,
    trialing: accounts.filter((a) => a.status === "trialing").length,
    expiring: accounts.filter((a) => a.status === "trialing" && (a.trialDaysLeft ?? 99) <= 7).length,
    paying: accounts.filter((a) => a.status === "active" && a.billingProvider !== "manual").length,
    pastDue: accounts.filter((a) => a.status === "past_due").length,
  };

  return { accounts, jobs, counts, filter, search };
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
  const { accounts, jobs, counts } = loaderData;
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
