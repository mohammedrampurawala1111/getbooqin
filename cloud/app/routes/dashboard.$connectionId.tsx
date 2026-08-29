import { useEffect, useRef } from "react";
import { data, Outlet, NavLink, useLocation } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId";
import { Settings } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { tenantSelectHeaders, getClerkClient } from "~/session.server";
import { UserMenu } from "~/components/account";

// Tenant-scoped dashboard layout. Mints the TenantSession cookie for this
// connection (same { shop, platform, userId, connectionId } shape the
// embedded Shopify admin's authenticate.admin() produces), then renders a
// nav + <Outlet/> for every booking-workflow screen nested under this route.
export async function loader({ request, params }: Route.LoaderArgs) {
  const { connection, shop, platform } = await requireTenant(request, params.connectionId);
  const settings = await Settings.getSettings(shop, platform);

  // A manual connection has no external channel behind it (see
  // core/src/connections.ts's createManualConnection) — only count Shopify
  // and Stripe, the two integrations with a real backend.
  const channelCount = (platform === "shopify" ? 1 : 0) + (settings.enabled_gateways.includes("stripe") ? 1 : 0);

  const clerkUser = await getClerkClient().users.getUser(connection.userId);
  const email =
    clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId)?.emailAddress ??
    clerkUser.emailAddresses[0]?.emailAddress ??
    "";
  const name = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") || email || "Account";
  const initials = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("") || "U";

  const tenantSession = {
    shop: connection.shop,
    platform: connection.platform,
    userId: connection.userId,
    connectionId: connection.id,
  };

  // A manual connection's "shop" is an opaque generated id (core/src/
  // connections.ts's createManualConnection), not something to show a
  // merchant — lead with their business name instead, same as a real
  // Shopify domain would read here.
  const label = platform === "manual" ? settings.business_name || "Manual setup" : connection.shop;

  return data(
    { connection, channelCount, label, user: { name, email, initials } },
    { headers: tenantSelectHeaders(tenantSession) }
  );
}

const NAV_ITEMS = [
  { to: "", end: true, label: "Overview" },
  { to: "/bookings", label: "Bookings" },
  { to: "/resources", label: "Staff / Resources" },
  { to: "/timeoff", label: "Time off" },
  { to: "/services", label: "Services" },
  { to: "/customers", label: "Customers" },
  { to: "/settings", label: "Settings" },
];

function navItemClass({ isActive }: { isActive: boolean }): string {
  return `nav-item ${isActive ? "nav-item-active" : ""}`;
}

export default function ConnectionDashboard({ loaderData, params }: Route.ComponentProps) {
  const { channelCount, label, user } = loaderData;
  const base = `/dashboard/${params.connectionId}`;

  // Below md: <aside> is an off-canvas drawer toggled by this checkbox (no
  // JS needed for the toggle itself — a topbar <label htmlFor> flips it).
  // This effect just closes the drawer after a navigation so it doesn't
  // stay open over the new page; the drawer still works with JS disabled.
  const navToggleRef = useRef<HTMLInputElement>(null);
  const location = useLocation();
  useEffect(() => {
    if (navToggleRef.current) navToggleRef.current.checked = false;
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen">
      <input ref={navToggleRef} type="checkbox" id="nav-toggle" className="peer sr-only" />
      <label
        htmlFor="nav-toggle"
        aria-hidden="true"
        className="fixed inset-0 z-30 hidden bg-black/40 peer-checked:block md:!hidden"
      />
      <aside className="side-dark fixed inset-y-0 left-0 z-40 flex w-[252px] shrink-0 -translate-x-full flex-col overflow-y-auto border-r border-line px-[14px] py-[18px] transition-transform duration-200 peer-checked:translate-x-0 md:sticky md:top-0 md:h-screen md:translate-x-0">
        <span className="flex h-[30px] w-[30px] shrink-0 flex-col justify-center gap-[3px] rounded-[8px] bg-brand-950 p-[6px]">
          <span className="h-[6px] rounded-[2px] bg-brand-500" />
          <span className="h-[6px] rounded-[2px] border-[1.5px] border-brand-500" />
        </span>

        <div className="mt-3 flex flex-col gap-1">
          <span className="truncate text-[13.5px] font-semibold" title={label}>
            {label}
          </span>
          <a href={`${base}/settings?tab=integrations`} className="text-[12px] font-medium text-[#a49caf] no-underline hover:underline">
            {channelCount} channel{channelCount === 1 ? "" : "s"} connected
          </a>
        </div>

        <nav className="mt-5 flex flex-col gap-[2px]">
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.label} to={`${base}${item.to}`} end={item.end} className={navItemClass}>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <UserMenu
          name={user.name}
          email={user.email}
          role="Owner"
          initials={user.initials}
          dark
          settingsHref={`${base}/settings`}
        />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-3 md:hidden">
          <label
            htmlFor="nav-toggle"
            aria-label="Toggle navigation"
            className="btn-sec cursor-pointer px-[10px] py-[6px]"
          >
            <span className="sr-only">Toggle navigation</span>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 4h12M2 8h12M2 12h12" strokeLinecap="round" />
            </svg>
          </label>
          <span className="truncate text-[13.5px] font-semibold">{label}</span>
        </div>
        {/* Not <main> — root.tsx already provides the page's one <main>
            landmark; a second, nested one is itself an accessibility
            violation (only one <main> per document). */}
        <div className="min-w-0 flex-1">
          <div className="page">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}
