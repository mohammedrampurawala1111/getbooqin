import type { Route } from "./+types/admin.features";
import { Plans, prisma } from "getbooqin-core";
import { requirePlatformAdmin } from "~/admin.server";

/**
 * Every entitlement key, what it does, which plans grant it, and how
 * many accounts carry an override for it.
 *
 * Exists to stop the admin UI becoming a pile of magic strings nobody
 * remembers the meaning of — the failure mode of every hand-rolled
 * feature-flag console.
 */
export async function loader({ request }: Route.LoaderArgs) {
  await requirePlatformAdmin(request);

  const overrides = await prisma.entitlement.groupBy({ by: ["key", "value"], _count: { _all: true } });
  const byKey = new Map<string, { on: number; off: number; other: number }>();
  for (const row of overrides) {
    const entry = byKey.get(row.key) ?? { on: 0, off: 0, other: 0 };
    if (row.value === "on") entry.on += row._count._all;
    else if (row.value === "off") entry.off += row._count._all;
    else entry.other += row._count._all;
    byKey.set(row.key, entry);
  }

  return {
    features: Plans.FEATURE_KEYS.map((key) => ({
      key,
      label: Plans.FEATURE_LABELS[key],
      plans: Plans.PLAN_ORDER.filter((p) => Plans.PLANS[p].features.includes(key)),
      overrides: byKey.get(key) ?? { on: 0, off: 0, other: 0 },
    })),
    limits: Plans.LIMIT_KEYS.map((key) => ({
      key: `limit.${key}`,
      label: Plans.LIMIT_LABELS[key],
      byPlan: Plans.PLAN_ORDER.map((p) => ({ plan: p, value: Plans.formatLimit(Plans.PLANS[p].limits[key]) })),
      overrides: byKey.get(`limit.${key}`) ?? { on: 0, off: 0, other: 0 },
    })),
  };
}

export default function AdminFeatures({ loaderData }: Route.ComponentProps) {
  const { features, limits } = loaderData;
  return (
    <div className="flex flex-col gap-[14px]">
      <div className="card">
        <div className="card-header">
          <div className="flex flex-col gap-[3px]">
            <h2 className="card-title">Features</h2>
            <p className="m-0 text-meta text-muted">
              These keys replaced the old ENABLE_* env vars. Granting one from an account's page is how a feature
              ships dark to a handful of accounts without a deploy.
            </p>
          </div>
        </div>
        <div className="px-[18px] pt-1 pb-[14px]">
          {features.map((f) => (
            <div key={f.key} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-row py-[11px] text-[13px] last:border-b-0">
              <div className="flex min-w-0 flex-col">
                <span className="num font-medium">{f.key}</span>
                <span className="text-[11.5px] text-subtle">{f.label}</span>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-[11.5px] text-muted">
                <span>{f.plans.length ? f.plans.join(", ") : "no plan grants this"}</span>
                {f.overrides.on > 0 && <span className="badge bg-brand-50 text-brand-600">+{f.overrides.on} granted</span>}
                {f.overrides.off > 0 && <span className="badge-neutral">−{f.overrides.off} revoked</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-header"><h2 className="card-title">Limits</h2></div>
        <div className="overflow-x-auto px-[18px] pt-1 pb-[14px]">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[11.5px] text-muted">
                <th className="py-[9px] pr-3 font-medium">Key</th>
                {limits[0]?.byPlan.map((p) => (
                  <th key={p.plan} className="px-2 py-[9px] text-right font-medium">{p.plan}</th>
                ))}
                <th className="px-2 py-[9px] text-right font-medium">Overrides</th>
              </tr>
            </thead>
            <tbody>
              {limits.map((l) => (
                <tr key={l.key} className="border-b border-row last:border-b-0">
                  <td className="py-[9px] pr-3">
                    <span className="num block font-medium">{l.key}</span>
                    <span className="block text-[11.5px] text-subtle">{l.label}</span>
                  </td>
                  {l.byPlan.map((p) => (
                    <td key={p.plan} className="num px-2 py-[9px] text-right">{p.value}</td>
                  ))}
                  <td className="num px-2 py-[9px] text-right text-muted">{l.overrides.other + l.overrides.on || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
