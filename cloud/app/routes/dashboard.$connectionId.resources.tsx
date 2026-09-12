import type { Route } from "./+types/dashboard.$connectionId.resources";
import { Data } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { PageHeader, DataTable, EmptyState, Badge } from "~/components/ui";
import { useVocabulary, vocabFor } from "~/lib/presets";
import { dashboardTerms } from "~/lib/dashboardMeta";

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: `${vocabFor(dashboardTerms(matches)).resources} · GetBooqin` },
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

// Practitioner/Room — the audit's own literal finding was that this
// section's nav label ("Practitioners & rooms") promised a resource type
// the product never actually had (GetBooqin clinic audit's RS-01 finding).
// Reuses Badge's neutral/ok status coloring rather than adding a new one —
// this is a category, not a state.
function KindBadge({ kind }: { kind: string }) {
  return kind === "room" ? <Badge status="confirmed" label="Room" /> : <Badge status="not_required" label="Practitioner" />;
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
          <>
            <a href={`${base}/resources/new`} className="btn-sec no-underline hover:no-underline">
              + Add {v.resourceOne}
            </a>
            <a href={`${base}/resources/new?kind=room`} className="btn-pri no-underline hover:no-underline">
              + Add room
            </a>
          </>
        }
      />

      <DataTable
        cols="1.1fr .85fr 1.05fr 1.1fr .7fr 28px"
        columns={["Name", "Type", "Title", "Email", "Status", ""]}
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
          <KindBadge kind={r.kind} />,
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
              <div className="flex shrink-0 items-center gap-2">
                <KindBadge kind={r.kind} />
                <Badge status={r.status ? "confirmed" : "cancelled"} label={r.status ? "Active" : "Inactive"} />
              </div>
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
                + Add {v.resourceOne}
              </a>
            }
          />
        }
      />
    </div>
  );
}
