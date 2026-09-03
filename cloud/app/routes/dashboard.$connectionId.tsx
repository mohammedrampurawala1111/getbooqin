import { useEffect, useRef, useState, type ReactNode } from "react";
import { data, Outlet, NavLink, useLocation, useLoaderData, useParams, useRouteError, isRouteErrorResponse } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId";
import { Settings, Bookings, ensureSlug } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { tenantSelectHeaders, getClerkClient } from "~/session.server";
import { UserMenu } from "~/components/account";
import { ThemeToggle, ToastProvider } from "~/components/ui";
import { vocabFor } from "~/lib/presets";
import { getAppUrl } from "~/lib/env.server";

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

  // "0 channels connected" under the business name is a permanent nag for
  // the standalone-by-design setup, with no positive state it ever reaches
  // (Defect Dossier's BQ-13 finding). Once there's really nothing to count,
  // show the booking-link handle instead — same slug/fallback logic the
  // Overview page's own share-link card already uses.
  let bookingHandle: string | null = null;
  if (channelCount === 0) {
    const hasRealName = !!settings.business_name && !(platform === "manual" && settings.business_name === shop);
    const slug = hasRealName ? await ensureSlug(connection.id, settings.business_name) : connection.id;
    bookingHandle = `${getAppUrl().replace(/^https?:\/\//, "")}/book/${slug}`;
  }

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
  // Account → Job title (dashboard.$connectionId.account.tsx) saves here
  // but nothing ever read it back — the sidebar hardcoded "Owner"
  // regardless of what was actually set (UX audit's #13 finding).
  const role = (clerkUser.unsafeMetadata?.jobTitle as string | undefined)?.trim() || "Owner";
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
    { connection, channelCount, pendingCount, label, preset: settings.preset, bookingHandle, user: { name, email, initials, role } },
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
  waitlist: (
    <NavIcon path={<>
      <circle cx="5.5" cy="6" r="1.8" />
      <circle cx="10.5" cy="6" r="1.8" />
      <path d="M2 13c0-2 1.6-3.5 3.5-3.5S9 11 9 13M7 13c0-2 1.6-3.5 3.5-3.5S14 11 14 13" strokeLinecap="round" />
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
    { to: "/waitlist", label: "Waitlist", icon: NAV_ICONS.waitlist },
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

// Shared between the default export (wraps <Outlet/>) and ErrorBoundary
// below (wraps a "page not found" panel instead) — a bad nested URL used to
// bubble past this whole layout to root.tsx's bare boundary, ejecting a
// signed-in merchant from the sidebar and business context entirely
// (Defect Dossier's BQ-37 finding). Pulled out rather than duplicated: this
// is a stateful component (mobile nav open/closed, inert handling, a media
// query listener) with real bug-fix history attached to nearly every piece
// of it, and copy-pasting it would let the two copies drift.
function DashboardShell({
  loaderData, params, children,
}: { loaderData: Route.ComponentProps["loaderData"]; params: { connectionId: string }; children: ReactNode }) {
  const { channelCount, pendingCount, label, preset, bookingHandle, user } = loaderData;
  const v = vocabFor(preset);
  const NAV_ITEMS = navItems(preset, pendingCount);
  const base = `/dashboard/${params.connectionId}`;

  // Below md: <aside> is an off-canvas drawer toggled by the topbar button
  // below. That button used to be a <label htmlFor> wearing role="button"
  // so it could carry aria-expanded/aria-controls (a bare <label> can't) —
  // it wasn't itself focusable or keyboard-operable, so the accessible
  // toggle a screen-reader user could reach was a label announcing the
  // right state, sitting right next to a real, tabbable but unlabeled
  // checkbox with none of that state (UX audit's #13 finding, on top of
  // the earlier #M9 aria-expanded fix). A real <button> is both at once;
  // the dashboard already requires JS for everything else on the page, so
  // there's nothing left to preserve by keeping a JS-optional checkbox
  // here too.
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
    <ToastProvider>
    <div className="flex min-h-dvh">
      {navOpen && (
        <div
          aria-hidden="true"
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
        />
      )}
      <aside
        ref={asideRef}
        id="dashboard-nav"
        className={`side-dark fixed inset-y-0 left-0 z-40 flex w-[252px] shrink-0 flex-col overflow-y-auto border-r border-line px-[14px] py-[18px] transition-transform duration-200 md:sticky md:top-0 md:h-dvh md:translate-x-0 ${navOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="flex items-center justify-between gap-2">
          <span className="flex h-[30px] w-[30px] shrink-0 flex-col justify-center gap-[3px] rounded-[8px] bg-brand-950 p-[6px]">
            <span className="h-[6px] rounded-[2px] bg-brand-500" />
            <span className="h-[6px] rounded-[2px] border-[1.5px] border-brand-500" />
          </span>
          <ThemeToggle className="flex h-[30px] w-[30px] shrink-0 cursor-pointer items-center justify-center rounded-field text-[#a49caf] hover:bg-white/5 hover:text-[#ece9f0]" />
        </div>

        <div className="mt-3 flex flex-col gap-1">
          <span className="truncate text-[13.5px] font-semibold" title={label}>
            {label}
          </span>
          {channelCount > 0 ? (
            <a href={`${base}/settings?page=integrations`} className="flex items-center text-[12px] font-medium text-[#a49caf] no-underline max-md:min-h-[44px] hover:underline">
              {channelCount} channel{channelCount === 1 ? "" : "s"} connected
            </a>
          ) : (
            <a href={`${base}/settings?page=integrations`} className="truncate text-[12px] font-medium text-[#a49caf] no-underline max-md:min-h-[44px] hover:underline" title={bookingHandle ?? undefined}>
              {bookingHandle}
            </a>
          )}
        </div>

        <nav className="mt-5 flex flex-col gap-[2px]">
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.label} to={`${base}${item.to}`} end={item.end} className={navItemClass}>
              {item.icon}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.badge ? (
                <span className="num shrink-0 rounded-full bg-brand-fill px-[6px] py-[1px] text-[11px] font-semibold text-white">
                  {item.badge}
                </span>
              ) : null}
            </NavLink>
          ))}
          <NavLink to={`${base}/support`} className={navItemClass}>
            {NAV_ICONS.help}
            <span className="min-w-0 flex-1 truncate">Help &amp; support</span>
          </NavLink>
        </nav>

        <UserMenu
          name={user.name}
          email={user.email}
          role={user.role}
          initials={user.initials}
          dark
          base={base}
        />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-3 md:hidden">
          <button
            type="button"
            aria-label="Toggle navigation"
            aria-expanded={navOpen}
            aria-controls="dashboard-nav"
            onClick={() => setNavOpen((v) => !v)}
            className="btn-sec cursor-pointer px-[10px] py-[6px]"
          >
            <span className="sr-only">Toggle navigation</span>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 4h12M2 8h12M2 12h12" strokeLinecap="round" />
            </svg>
          </button>
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{label}</span>
          {/* The sidebar's own toggle only reaches whoever opens the
              off-canvas drawer first — below md that's every screen this
              app actually ships to, so anyone who hasn't already opened
              the nav has no visible way to find it (pass 7's E12 finding:
              tested at 496px, where the sidebar starts off-canvas). This
              topbar is the one thing that's always on screen there. */}
          <ThemeToggle className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-field text-muted hover:bg-canvas-alt" />
        </div>
        {/* Not <main> — root.tsx already provides the page's one <main>
            landmark; a second, nested one is itself an accessibility
            violation (only one <main> per document). */}
        <div className="min-w-0 flex-1">
          <div className="page">{children}</div>
        </div>
      </div>
    </div>
    </ToastProvider>
  );
}

export default function ConnectionDashboard({ loaderData, params }: Route.ComponentProps) {
  const v = vocabFor(loaderData.preset);
  return (
    <DashboardShell loaderData={loaderData} params={params}>
      <Outlet context={{ vocab: v }} />
    </DashboardShell>
  );
}

// A bad nested URL (mistyped, stale bookmark, a deleted record's old link)
// used to bubble all the way past this layout to root.tsx's bare boundary,
// ejecting a signed-in merchant from the whole dashboard shell — sidebar,
// business context, everything (Defect Dossier's BQ-37 finding). This
// route's own loader already succeeded whenever the error is in a child
// (it's what rendered the sidebar in the first place) — useLoaderData()
// here returns that same data, so DashboardShell renders exactly as it
// would have, with this panel standing in for <Outlet/>. Deliberately no
// <html>/<Scripts>, unlike root.tsx's boundary: this renders *inside* the
// already-mounted document. If this route's *own* loader is what actually
// failed, useLoaderData() has nothing to return and this component throws
// while rendering — that's expected: it re-bubbles to root.tsx's boundary,
// the same fallback every other route already gets today.
export function ErrorBoundary() {
  const error = useRouteError();
  const params = useParams<{ connectionId: string }>();
  const loaderData = useLoaderData<typeof loader>();
  const notFound = isRouteErrorResponse(error) && error.status === 404;

  if (import.meta.env.DEV && !notFound) {
    console.error(error);
  }

  return (
    <DashboardShell loaderData={loaderData} params={{ connectionId: params.connectionId! }}>
      <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
        <h1 className="page-title">{notFound ? "Page not found" : "Something went wrong"}</h1>
        <p className="m-0 max-w-[360px] text-body text-muted">
          {notFound
            ? "That page doesn't exist or may have moved."
            : "An unexpected error occurred. Try again, or head back to the overview."}
        </p>
        <a href={`/dashboard/${params.connectionId}`} className="btn-pri mt-2 no-underline hover:no-underline">
          Back to Overview
        </a>
      </div>
    </DashboardShell>
  );
}
