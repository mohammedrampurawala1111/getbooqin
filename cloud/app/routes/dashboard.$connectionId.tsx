import { useEffect, useRef, useState, type ReactNode } from "react";
import { data, Outlet, NavLink, useLocation } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId";
import { Settings, Bookings } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { tenantSelectHeaders, getClerkClient } from "~/session.server";
import { UserMenu } from "~/components/account";
import { vocabFor } from "~/lib/presets";

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
  const pendingCount = await Bookings.count(shop, platform, { status: "pending" });

  const clerkUser = await getClerkClient().users.getUser(connection.userId);
  const email =
    clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId)?.emailAddress ??
    clerkUser.emailAddresses[0]?.emailAddress ??
    "";
  // Falling back to the full email here used to mean the account menu's
  // title line and its email line below rendered the exact same string
  // whenever no first/last name was set (UX audit's D4 finding) — the
  // local part alone still reads as a name-shaped label without repeating
  // the line underneath it verbatim.
  const name =
    [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") || email.split("@")[0] || "Account";
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
  // Shopify domain would read here. defaultSettings() seeds business_name
  // to that same opaque shop id (core/src/booking/settings.ts), so
  // `|| "Manual setup"` never actually fires — a connection that never
  // completed step 1 (every account from before onboarding's persistence
  // fix) shows its raw manual-<uuid> shop id verbatim instead (UX audit's
  // D2 finding). Comparing against `shop` catches that untouched default
  // without needing a data migration.
  const label =
    platform === "manual"
      ? settings.business_name && settings.business_name !== shop
        ? settings.business_name
        : "Manual setup"
      : connection.shop;

  return data(
    { connection, channelCount, pendingCount, label, preset: settings.preset, user: { name, email, initials } },
    { headers: tenantSelectHeaders(tenantSession) }
  );
}

// 16px inline SVG, stroke-width 1.5, currentColor — same icon convention as
// the rest of the design system (see components/ui.tsx's chevrons/toggles).
function NavIcon({ path }: { path: ReactNode }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0">
      {path}
    </svg>
  );
}

const NAV_ICONS = {
  overview: (
    <NavIcon path={<>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </>} />
  ),
  bookings: (
    <NavIcon path={<>
      <rect x="2" y="3" width="12" height="11" rx="1.5" />
      <path d="M2 6.5h12M5 2v3M11 2v3" strokeLinecap="round" />
    </>} />
  ),
  resources: (
    <NavIcon path={<>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 14c0-2.76 2.24-5 5-5s5 2.24 5 5" strokeLinecap="round" />
    </>} />
  ),
  timeoff: (
    <NavIcon path={<>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" strokeLinecap="round" strokeLinejoin="round" />
    </>} />
  ),
  services: <NavIcon path={<path d="M8 1.5 14.5 8 8 14.5 1.5 8Z" strokeLinejoin="round" />} />,
  customers: (
    <NavIcon path={<>
      <circle cx="6" cy="5.5" r="2.2" />
      <path d="M1.8 14c0-2.3 1.9-4.2 4.2-4.2s4.2 1.9 4.2 4.2" strokeLinecap="round" />
      <circle cx="11.5" cy="6" r="1.8" />
      <path d="M10.3 9.6c1.9.2 3.4 1.8 3.5 3.7" strokeLinecap="round" />
    </>} />
  ),
  settings: (
    <NavIcon path={<>
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="2.3" />
    </>} />
  ),
  help: (
    <NavIcon path={<>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M6.2 6.2a1.8 1.8 0 1 1 2.6 1.6c-.6.3-.8.6-.8 1.2v.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="8" cy="11.4" r=".15" fill="currentColor" stroke="none" />
    </>} />
  ),
} as const;

// The setup flow already says "Add your first stylist" and labels
// industries with "Chair time" and "Bay slots" — that warmth stopped at
// the dashboard door, where every account saw the same generic
// "Bookings" / "Staff / Resources" regardless of industry (UX audit's U4
// finding). vocabFor() already existed for exactly this; nothing here
// used it yet.
function navItems(preset: string | null, pendingCount: number) {
  const v = vocabFor(preset);
  return [
    { to: "", end: true, label: "Overview", icon: NAV_ICONS.overview },
    { to: "/bookings", label: v.bookingTitle, icon: NAV_ICONS.bookings, badge: pendingCount > 0 ? pendingCount : undefined },
    { to: "/resources", label: v.resources, icon: NAV_ICONS.resources },
    { to: "/timeoff", label: "Time off", icon: NAV_ICONS.timeoff },
    { to: "/services", label: v.services, icon: NAV_ICONS.services },
    { to: "/customers", label: v.customers, icon: NAV_ICONS.customers },
    { to: "/settings", label: "Settings", icon: NAV_ICONS.settings },
  ];
}

function navItemClass({ isActive }: { isActive: boolean }): string {
  return `nav-item ${isActive ? "nav-item-active" : ""}`;
}

export default function ConnectionDashboard({ loaderData, params }: Route.ComponentProps) {
  const { channelCount, pendingCount, label, preset, user } = loaderData;
  const NAV_ITEMS = navItems(preset, pendingCount);
  const base = `/dashboard/${params.connectionId}`;

  // Below md: <aside> is an off-canvas drawer toggled by this checkbox (no
  // JS needed for the toggle itself — a topbar <label htmlFor> flips it —
  // so it still works with JS disabled). The state below is a JS-only
  // enhancement layered on top: closed, off-canvas but not `inert`, the
  // drawer's 12 nav links stayed in the tab order ahead of the page, and
  // the toggle button had no `aria-expanded` for a screen-reader user to
  // tell it was closed at all (UX audit's M9 finding).
  const navToggleRef = useRef<HTMLInputElement>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const location = useLocation();

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    setIsMobile(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (navToggleRef.current) navToggleRef.current.checked = false;
    setNavOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!isMobile) return;
    document.body.style.overflow = navOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [navOpen, isMobile]);

  // Only inert while actually off-canvas (closed AND below md) — at md+ the
  // drawer is always visible and interactive regardless of this checkbox,
  // so making it inert there would break the always-shown desktop sidebar.
  // Set imperatively via a ref: this @types/react version doesn't yet
  // recognize `inert` as a JSX attribute, but the DOM property itself has
  // been standard since Chrome 102 / Safari 15.5 / Firefox 112, all below
  // this app's existing Tailwind-v4-driven browser floor.
  const asideRef = useRef<HTMLElement>(null);
  const asideInert = isMobile && !navOpen;
  useEffect(() => {
    if (asideRef.current) asideRef.current.inert = asideInert;
  }, [asideInert]);

  return (
    <div className="flex min-h-dvh">
      <input
        ref={navToggleRef}
        type="checkbox"
        id="nav-toggle"
        className="peer sr-only"
        checked={navOpen}
        onChange={(e) => setNavOpen(e.currentTarget.checked)}
      />
      <label
        htmlFor="nav-toggle"
        aria-hidden="true"
        className="fixed inset-0 z-30 hidden bg-black/40 peer-checked:block md:!hidden"
      />
      <aside
        ref={asideRef}
        id="dashboard-nav"
        className="side-dark fixed inset-y-0 left-0 z-40 flex w-[252px] shrink-0 -translate-x-full flex-col overflow-y-auto border-r border-line px-[14px] py-[18px] transition-transform duration-200 peer-checked:translate-x-0 md:sticky md:top-0 md:h-dvh md:translate-x-0">
        <span className="flex h-[30px] w-[30px] shrink-0 flex-col justify-center gap-[3px] rounded-[8px] bg-brand-950 p-[6px]">
          <span className="h-[6px] rounded-[2px] bg-brand-500" />
          <span className="h-[6px] rounded-[2px] border-[1.5px] border-brand-500" />
        </span>

        <div className="mt-3 flex flex-col gap-1">
          <span className="truncate text-[13.5px] font-semibold" title={label}>
            {label}
          </span>
          <a href={`${base}/settings?tab=integrations`} className="flex items-center text-[12px] font-medium text-[#a49caf] no-underline max-md:min-h-[44px] hover:underline">
            {channelCount} channel{channelCount === 1 ? "" : "s"} connected
          </a>
        </div>

        <nav className="mt-5 flex flex-col gap-[2px]">
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.label} to={`${base}${item.to}`} end={item.end} className={navItemClass}>
              {item.icon}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.badge ? (
                <span className="num shrink-0 rounded-full bg-brand-500 px-[6px] py-[1px] text-[11px] font-semibold text-white">
                  {item.badge}
                </span>
              ) : null}
            </NavLink>
          ))}
          <a href="/support" className="nav-item">
            {NAV_ICONS.help}
            <span className="min-w-0 flex-1 truncate">Help &amp; support</span>
          </a>
        </nav>

        <UserMenu
          name={user.name}
          email={user.email}
          role="Owner"
          initials={user.initials}
          dark
          base={base}
        />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-3 md:hidden">
          <label
            htmlFor="nav-toggle"
            aria-label="Toggle navigation"
            aria-expanded={navOpen}
            aria-controls="dashboard-nav"
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
