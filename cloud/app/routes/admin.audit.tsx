import { Link } from "react-router";
import type { Route } from "./+types/admin.audit";
import { AdminAudit } from "getbooqin-core";
import { requirePlatformAdmin } from "~/admin.server";

/**
 * Every admin action, newest first. Filterable by actor and by account.
 *
 * The reason column is the point of the whole table — six months from
 * now, "why is this account free?" has an answer.
 */
export async function loader({ request }: Route.LoaderArgs) {
  await requirePlatformAdmin(request);
  const url = new URL(request.url);
  const entries = await AdminAudit.list({
    actorUserId: url.searchParams.get("actor") ?? undefined,
    targetId: url.searchParams.get("target") ?? undefined,
    limit: 100,
  });
  return { entries };
}

function stamp(value: string | Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

export default function AdminAuditLog({ loaderData }: Route.ComponentProps) {
  const { entries } = loaderData;
  return (
    <div className="card">
      <div className="card-header"><h2 className="card-title">Audit log</h2></div>
      <div className="px-[18px] pt-1 pb-[14px]">
        {entries.length === 0 ? (
          <p className="py-[11px] text-[13px] text-subtle">Nothing recorded yet.</p>
        ) : (
          entries.map((row) => (
            <div key={row.id} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-row py-[11px] text-[13px] last:border-b-0">
              <div className="flex min-w-0 flex-col">
                <span>
                  <span className="num font-medium">{row.action}</span>
                  {" — "}
                  {row.reason}
                </span>
                <span className="text-[11.5px] text-subtle">
                  {row.actorEmail}
                  {row.targetType === "connection" && (
                    <>
                      {" · "}
                      <Link to={`/admin/accounts/${row.targetId}`} className="btn-link">account</Link>
                    </>
                  )}
                  {row.before && row.after ? ` · ${row.before} → ${row.after}` : row.after ? ` · ${row.after}` : ""}
                </span>
              </div>
              <span className="num shrink-0 text-[11.5px] text-subtle">{stamp(row.createdAt)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
