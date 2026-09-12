import { useEffect, useRef, useState, type ReactNode } from "react";
import { data, Outlet, NavLink, useLocation, useLoaderData, useParams, useRouteError, isRouteErrorResponse } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId";
import { Settings, Bookings, ensureSlug } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { tenantSelectHeaders, getClerkClient } from "~/session.server";
import { UserMenu } from "~/components/account";
import { ThemeToggle, ToastProvider } from "~/components/ui";
import { vocabFor, type Vocabulary } from "~/lib/presets";
import { getAppUrl } from "~/lib/env.server";

// Tenant-scoped dashboard layout. Mints the TenantSession cookie for this
// connection (same { shop, platform, userId, connectionId } shape the
// embedded Shopify admin's authenticate.admin() produces), then renders a
// nav + <Outlet/> for every booking-workflow screen nested under this route.
export async function loader({ request, params }: Route.LoaderArgs) {
  const { connection, shop, platform, role } = await requireTenant(request, params.connectionId);
  const settings = await Settings.getSettings(shop, platform);

  // A manual connection has no external channel behind it (see
  // core/src/connections.ts's createManualConnection) — Shopify is the
  // only integration with a real backend.
  const channelCount = platform === "shopify" ? 1 : 0;
  const pendingCount = await Bookings.count(shop, platform, { status: "pending" });

  // "0 channels connected" under the business name is a permanent nag for
  // the standalone-by-design setup, with no positive state it ever reaches
  // (Defect Dossier's BQ-13 finding). Once there's really nothing to count,
  // show the booking-link handle instead — same slug/fallback logic the
  // Overview page's own share-link card already uses.
  let bookingHandle: string | null = null;
  // The handle text ("getbooqin.fly.dev/book/idris-dental") looks like a
  // link to the booking page itself — clicking it instead opened Settings
  // → Integrations, the same destination as the "N channels connected"
  // variant above, which has its own real reason to point there (GetBooqin
  // clinic audit's CR-04 finding). Kept separate from the display handle
  // (which has its protocol stripped for a cleaner read) so the anchor
  // below can link to the real, working URL.
  let bookingUrl: string | null = null;
  if (channelCount === 0) {
    const hasRealName = !!settings.business_name && !(platform === "manual" && settings.business_name === shop);
    const slug = hasRealName ? await ensureSlug(connection.id, settings.business_name) : connection.id;
    bookingUrl = `${getAppUrl()}/book/${slug}`;
    bookingHandle = bookingUrl.replace(/^https?:\/\//, "");
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
  // regardless of what was actually set (UX audit's #13 finding). Named
  // `jobTitle` (not `role`) since this is a free-text cosmetic label, not
  // the team-membership role `requireTenant` returns above — the two used
  // to share the name `role` before Team management introduced the real one.
  const jobTitle = (clerkUser.unsafeMetadata?.jobTitle as string | undefined)?.trim() || "Owner";
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
    // canViewSettings mirrors dashboard.$connectionId.settings.tsx's own
    // "admin" minRole on its loader (a write/read viewer 404s there) — the
    // nav link is hidden for them here so it doesn't dead-end (orchestrator
    // decision on Settings access, §2). Named distinctly from `role` inside
    // `user` below, which is the unrelated Account-page "job title" label.
    { connection, channelCount, pendingCount, label, terms: settings.terms, bookingHandle, bookingUrl, canViewSettings: role === "owner" || role === "admin", user: { name, email, initials, role: jobTitle } },
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
// `canViewSettings` mirrors requireTenant's own "admin" minRole on the
// Settings loader — a write/read viewer's request there 404s regardless
// (that's the real boundary), but leaving the link in the nav for them
// would just be an always-broken link to click. Small, targeted hide,
// not a nav restructure: everything else here is unaffected, since only
// Settings gained the stricter loader-level gate.
function navItems(vocab: Vocabulary, pendingCount: number, canViewSettings: boolean) {
  const v = vocab;
  return [
    { to: "", end: true, label: "Overview", icon: NAV_ICONS.overview },
    { to: "/bookings", label: v.bookingTitle, icon: NAV_ICONS.bookings, badge: pendingCount > 0 ? pendingCount : undefined },
    { to: "/waitlist", label: "Waitlist", icon: NAV_ICONS.waitlist },
    { to: "/resources", label: v.resources, icon: NAV_ICONS.resources },
    { to: "/timeoff", label: "Time off", icon: NAV_ICONS.timeoff },
    { to: "/services", label: v.services, icon: NAV_ICONS.services },
    { to: "/customers", label: v.customers, icon: NAV_ICONS.customers },
    ...(canViewSettings ? [{ to: "/settings", label: "Settings", icon: NAV_ICONS.settings }] : []),
  ];
}

function navItemClass({ isActive }: { isActive: boolean }): string {
  return `nav-item ${isActive ? "nav-item-active" : ""}`;
}

/**
 * The booking-link handle in the sidebar — the one thing every account
 * without a connected Shopify/Stripe channel sees under its business name.
 * Previously the whole thing was an anchor pointing at Settings →
 * Integrations (the same destination as the "N channels connected"
 * variant, copy-pasted without noticing this text isn't that link) — the
 * one place a merchant could actually reach their own public booking page
 * from here was a working Copy button that lives on Overview instead
 * (GetBooqin clinic audit's CR-04 finding). Now opens the real page in a
 * new tab, with copy alongside it right where the link itself is.
 */
function BookingLinkRow({ bookingHandle, bookingUrl }: { bookingHandle: string | null; bookingUrl: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!bookingHandle || !bookingUrl) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(bookingUrl!);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission denied or unavailable — the link is still
      // reachable by opening it.
    }
  }

  return (
    <span className="flex min-w-0 items-center gap-[6px]">
      <a
        href={bookingUrl}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 truncate text-[12px] font-medium text-[#a49caf] no-underline max-md:min-h-[44px] hover:underline"
        title={bookingHandle}
      >
        {bookingHandle}
      </a>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 text-[11px] font-medium text-[#a49caf] hover:text-[#ece9f0] hover:underline"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
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
  const { channelCount, pendingCount, label, terms, bookingHandle, bookingUrl, canViewSettings, user } = loaderData;
  const v = vocabFor(terms);
  const NAV_ITEMS = navItems(v, pendingCount, canViewSettings);
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
            <BookingLinkRow bookingHandle={bookingHandle} bookingUrl={bookingUrl} />
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
  const v = vocabFor(loaderData.terms);
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
// already-mounted document.
export function ErrorBoundary() {
  const error = useRouteError();
  const params = useParams<{ connectionId: string }>();
  const loaderData = useLoaderData<typeof loader>();
  const notFound = isRouteErrorResponse(error) && error.status === 404;

  if (import.meta.env.DEV && !notFound) {
    console.error(error);
  }

  const body = (
    <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
      <h1 className="page-title">{notFound ? "Page not found" : "Something went wrong"}</h1>
      <p className="m-0 max-w-[360px] text-body text-muted">
        {notFound
          ? "That page doesn't exist or may have moved."
          : "An unexpected error occurred. Try again, or head back to the overview."}
      </p>
      {/* loaderData missing (checked below) means this route's own id was
          never a real connection to link back to — /dashboard is the one
          link that always resolves, to whatever active connection this
          account actually has. */}
      <a href={loaderData ? `/dashboard/${params.connectionId}` : "/dashboard"} className="btn-pri mt-2 no-underline hover:no-underline">
        Back to Overview
      </a>
    </div>
  );

  // Whether this layout's *own* loader succeeded decides which fallback
  // renders, not just cosmetics. When a *child* route's loader/action
  // failed instead, this route's own loader already ran fine — the same
  // call that produced the sidebar's data in the first place — so
  // useLoaderData() above has real data and DashboardShell renders exactly
  // as it would have. But when this route's *own* loader is what threw —
  // e.g. requireTenant 404ing a foreign or unknown connectionId —
  // useLoaderData() has nothing to return, and rendering DashboardShell
  // anyway used to destructure that `undefined` and throw a second,
  // unrelated error mid-render. React only lets an ErrorBoundary catch
  // errors from its *children*, not from its own render, so that second
  // throw skipped straight past this boundary to root.tsx's — which sees
  // a plain TypeError instead of the original 404 Response and serves 500
  // instead (QA report's BUG-2, reproduced via direct request replay
  // against a real foreign connection id).
  if (!loaderData) {
    return <div className="flex min-h-dvh flex-col items-center justify-center bg-canvas">{body}</div>;
  }

  return (
    <DashboardShell loaderData={loaderData} params={{ connectionId: params.connectionId! }}>
      {body}
    </DashboardShell>
  );
}
