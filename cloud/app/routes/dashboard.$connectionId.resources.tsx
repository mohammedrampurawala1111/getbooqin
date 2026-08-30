import type { Route } from "./+types/dashboard.$connectionId.resources";
import { Data } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { PageHeader, DataTable, EmptyState, Badge } from "~/components/ui";
import { useVocabulary, vocabFor } from "~/lib/presets";
import { dashboardPreset } from "~/lib/dashboardMeta";

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: `${vocabFor(dashboardPreset(matches)).resources} · GetBooqin` },
];

export async function loader({ request, params }: Route.LoaderArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  const resources = await Data.resources(shop, platform, false);
  return { resources };
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

export default function ResourcesList({ loaderData, params }: Route.ComponentProps) {
  const { resources } = loaderData;
  const base = `/dashboard/${params.connectionId}`;
  const v = useVocabulary();

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        title={v.resources}
        actions={
          <a href={`${base}/resources/new`} className="btn-pri">
            Add
          </a>
        }
      />

      <DataTable
        cols="1.3fr 1.4fr .9fr .7fr 28px"
        columns={["Name", "Title", "Email", "Status", ""]}
        rows={resources}
        rowKey={(r) => String(r.id)}
        href={(r) => `${base}/resources/${r.id}`}
        renderRow={(r) => [
          <span className="flex min-w-0 items-center gap-[10px]">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[11px] font-semibold text-brand-600">
              {initials(r.name)}
            </span>
            <span className="min-w-0 truncate font-medium">{r.name}</span>
          </span>,
          r.title,
          r.email,
          <Badge status={r.status ? "confirmed" : "cancelled"} label={r.status ? "Active" : "Inactive"} />,
          <span className="text-faint">›</span>,
        ]}
        // Below 640px the desktop grid squeezed Name down to almost nothing
        // to leave room for Title/Email/Status, so the one column that
        // actually identifies the row was the one that got clipped hardest
        // (UX audit's #6 finding — the same class of problem already fixed
        // for Services via this same stacked-card prop; this list had never
        // been given one).
        mobileCard={(r) => (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-[10px]">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[11px] font-semibold text-brand-600">
                  {initials(r.name)}
                </span>
                <span className="min-w-0 truncate font-medium">{r.name}</span>
              </span>
              <Badge status={r.status ? "confirmed" : "cancelled"} label={r.status ? "Active" : "Inactive"} />
            </div>
            {(r.title || r.email) && (
              <div className="flex min-w-0 items-center justify-between gap-3 text-muted">
                <span className="min-w-0 truncate">{r.title}</span>
                <span className="min-w-0 truncate">{r.email}</span>
              </div>
            )}
          </>
        )}
        empty={
          <EmptyState
            icon={
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="9" cy="6.5" r="3" />
                <path d="M3.5 15c.6-3 2.8-5 5.5-5s4.9 2 5.5 5" strokeLinecap="round" />
              </svg>
            }
            title={`No ${v.resources.toLowerCase()} yet`}
            body={`Add ${v.resources.toLowerCase()} to start scheduling ${v.bookingMany}.`}
            action={
              <a href={`${base}/resources/new`} className="btn-pri no-underline hover:no-underline">
                + Add
              </a>
            }
          />
        }
      />
    </div>
  );
}
