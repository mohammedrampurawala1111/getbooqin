import { Outlet, NavLink } from "react-router";
import type { Route } from "./+types/admin";
import { requirePlatformAdmin } from "~/admin.server";

/**
 * Platform admin console — *us*, above all accounts. Not a role inside a
 * business: nothing here is scoped to a connection the viewer belongs
 * to, and it deliberately shares no layout, no context and no middleware
 * with the tenant dashboard.
 */
export const meta: Route.MetaFunction = () => [{ title: "Admin · GetBooqin" }];

export async function loader({ request }: Route.LoaderArgs) {
  const admin = await requirePlatformAdmin(request);
  return { email: admin.email };
}

const TABS = [
  { to: "/admin", label: "Accounts", end: true },
  { to: "/admin/features", label: "Feature catalogue", end: false },
  { to: "/admin/audit", label: "Audit log", end: false },
];

export default function AdminLayout({ loaderData }: Route.ComponentProps) {
  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-[18px] px-5 py-6">
      <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line pb-3">
        <div className="flex flex-col gap-[2px]">
          <h1 className="m-0 text-[18px] font-semibold tracking-[-0.02em]">GetBooqin admin</h1>
          {/* Stated plainly so nobody mistakes this for a merchant-facing
              screen. It shows accounts, plans and counts — never customer
              names or booking details. */}
          <p className="m-0 text-meta text-muted">
            Platform-wide. Shows plans, counts and entitlements — never a merchant's customer or booking data.
          </p>
        </div>
        <span className="text-meta text-subtle">{loaderData.email}</span>
      </header>

      <nav className="flex gap-1">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              `rounded-[8px] px-[12px] py-[6px] text-body no-underline hover:no-underline ${isActive ? "bg-brand-50 font-medium text-brand-600" : "text-muted hover:bg-row"}`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <Outlet />
    </div>
  );
}
