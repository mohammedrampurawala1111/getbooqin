import { useState } from "react";
import type { Route } from "./+types/_index";
import { getUserSession } from "~/session.server";
import { LogoMark, PlanCard } from "~/components/onboarding";
import { PRESETS, INTEGRATIONS } from "~/lib/presets";
import { Badge, LegalFooter, LogoutButton } from "~/components/ui";

export const meta: Route.MetaFunction = () => [
  { title: "GetBooqin — Bookings, staff and payments for every store" },
  {
    name: "description",
    content:
      "GetBooqin turns your product catalogue into bookable appointments, jobs or reservations, with staff schedules, deposits and reminders — start free, with or without Shopify.",
  },
];

// Always renders the marketing page, logged in or not — a direct hit on
// "/" should never bounce a visitor into onboarding or the dashboard (that
// only happens from an explicit "Log in"/"Sign up" action, via /login and
// /dashboard's own redirect chain). Logged-in state only changes the nav's
// CTAs below, from Log in/Sign up to Dashboard/Log out.
export async function loader({ request }: Route.LoaderArgs) {
  const session = await getUserSession(request);
  return { loggedIn: !!session };
}

const PLANS = [
  {
    name: "Starter", price: "$0", per: "/mo", featured: false, cta: "Start free", href: "/signup",
    blurb: "For a single business finding its feet — with or without Shopify.",
    features: ["1 connected store or manual setup", "Unlimited bookings", "Email reminders", "Shopify product sync"],
  },
  {
    name: "Growth", price: "$29", per: "/mo", featured: true, cta: "Start free trial", href: "/signup",
    blurb: "For a business juggling staff, resources and payments.",
    features: ["Everything in Starter", "Unlimited staff & resources", "Deposits & payments", "WhatsApp reminders (soon)"],
  },
  {
    name: "Scale", price: "$79", per: "/mo", featured: false, cta: "Talk to us", href: "/support",
    blurb: "For multiple locations under one account.",
    features: ["Everything in Growth", "Unlimited connected stores", "Priority support", "Google Calendar sync (soon)"],
  },
];

export default function Home({ loaderData }: Route.ComponentProps) {
  const { loggedIn } = loaderData;
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className="mkt-shell">
      {/* group + group-has-checked (not peer-checked — see ui.tsx's Toggle
          for why: the mobile panel below isn't a direct sibling of the
          checkbox) drives the collapsed menu. Below md, Product/
          Integrations/Industries/Pricing used to just disappear with
          nothing replacing them (UX audit's M4 finding) — a visitor on a
          phone couldn't reach pricing except by scrolling the whole page. */}
      <div className="mkt-bar group">
        <div className="mkt-wrap flex h-[60px] items-center gap-7">
          <a href="/" className="flex items-center gap-[9px] no-underline hover:no-underline">
            <LogoMark size={26} />
            <span className="text-[14px] font-semibold text-ink">GetBooqin</span>
          </a>
          <nav className="ml-3 hidden items-center gap-6 md:flex">
            <a href="#product" className="mkt-link">Product</a>
            <a href="#integrations" className="mkt-link">Integrations</a>
            <a href="#industries" className="mkt-link">Industries</a>
            <a href="#pricing" className="mkt-link">Pricing</a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {loggedIn ? (
              <>
                <a href="/dashboard" className="mkt-cta text-[13px] no-underline hover:no-underline">Go to dashboard</a>
                {/* "Go to dashboard" + "Log out" + the hamburger need 341px
                    together — below that the header gained a horizontal
                    scroll and clipped Log out outright (UX audit's K3
                    finding). Below 400px it moves into the mobile nav panel
                    instead of just disappearing. */}
                <LogoutButton className="mkt-link hidden min-[400px]:inline-flex" />
              </>
            ) : (
              <>
                <a href="/login" className="mkt-link">Log in</a>
                <a href="/signup" className="mkt-cta text-[13px] no-underline hover:no-underline">Sign up free</a>
              </>
            )}
            <input
              type="checkbox"
              id="mkt-nav-toggle"
              className="peer sr-only md:hidden"
              checked={navOpen}
              onChange={(e) => setNavOpen(e.currentTarget.checked)}
            />
            {/* role="button" because aria-expanded/aria-controls aren't
                allowed on a bare <label> — browsers silently drop them, so
                a screen-reader user has no way to tell the menu's open
                state (same fix as the dashboard sidebar's toggle, UX
                audit's K2 finding). Still a real <label htmlFor>, so this
                keeps working with JS disabled — navOpen is a client-side
                enhancement layered on top, not a requirement. */}
            <label
              htmlFor="mkt-nav-toggle"
              role="button"
              aria-label="Toggle menu"
              aria-expanded={navOpen}
              aria-controls="mkt-mobile-nav"
              className="btn-sec cursor-pointer px-[10px] py-[6px] md:hidden"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M2 4h12M2 8h12M2 12h12" strokeLinecap="round" />
              </svg>
            </label>
          </div>
        </div>
        <nav id="mkt-mobile-nav" className="hidden flex-col gap-1 border-t border-line px-7 py-3 group-has-checked:flex md:hidden">
          <a href="#product" className="mkt-link py-[9px]">Product</a>
          <a href="#integrations" className="mkt-link py-[9px]">Integrations</a>
          <a href="#industries" className="mkt-link py-[9px]">Industries</a>
          <a href="#pricing" className="mkt-link py-[9px]">Pricing</a>
          {loggedIn ? (
            <LogoutButton className="mkt-link py-[9px] text-left min-[400px]:hidden" />
          ) : null}
        </nav>
      </div>

      {/* ---------------------------------------------------------------- Hero */}
      <section id="product" className="mkt-section">
        <div className="mkt-wrap grid grid-cols-1 items-center gap-8 py-14 md:grid-cols-[1.05fr_.95fr] md:gap-12 md:py-20">
          <div className="flex flex-col gap-5">
            <span className="mkt-eyebrow">Booking software for any industry</span>
            {/* Fixed 50px set across ten lines at 389px, making the hero
                905px tall on a 628px screen (UX audit's M3 finding). */}
            <h1 className="mkt-h1 text-[32px] leading-[1.12] md:text-[50px] md:leading-[1.06]">Bookings, staff and payments — one dashboard, every store.</h1>
            <p className="mkt-lede">
              GetBooqin turns your product catalogue into bookable appointments, jobs or reservations —
              with staff schedules, deposits, and reminders that cut no-shows. Start with Shopify, or go
              live without it and connect a store later.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <a href="/signup" className="mkt-cta no-underline hover:no-underline">Start free</a>
              <a href="#pricing" className="mkt-cta-alt no-underline hover:no-underline">See pricing</a>
            </div>
          </div>

          <div className="card overflow-hidden shadow-pop">
            <div className="card-header">
              <h2 className="card-title">Overview</h2>
              <span className="text-meta text-subtle">This week</span>
            </div>
            <div className="card-body grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-[6px] rounded-card border border-line px-4 py-3">
                <span className="text-[11px] font-medium text-muted">Bookings</span>
                <span className="num text-[20px] font-medium tracking-[-0.02em]">128</span>
              </div>
              <div className="flex flex-col gap-[6px] rounded-card border border-line px-4 py-3">
                <span className="text-[11px] font-medium text-muted">No-show rate</span>
                <span className="num text-[20px] font-medium tracking-[-0.02em] text-ok">3%</span>
              </div>
            </div>
            <div className="thead" style={{ gridTemplateColumns: "1.1fr 1fr .8fr" }}>
              <div className="th">Customer</div>
              <div className="th">Service</div>
              <div className="th">Status</div>
            </div>
            {[
              { name: "Amelia Ross", service: "Cut & finish", status: "confirmed" as const },
              { name: "Priya Nair", service: "Balayage & toner", status: "pending" as const },
              { name: "Jonas Weber", service: "Beard trim", status: "confirmed" as const },
            ].map((row) => (
              <div key={row.name} className="trow" style={{ gridTemplateColumns: "1.1fr 1fr .8fr" }}>
                <span className="min-w-0 truncate font-medium">{row.name}</span>
                <span className="min-w-0 truncate text-muted">{row.service}</span>
                <Badge status={row.status} />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------- Integrations */}
      <section id="integrations" className="mkt-section mkt-alt">
        <div className="mkt-wrap flex flex-col gap-8 py-16">
          <div className="flex max-w-[560px] flex-col gap-2">
            <h2 className="mkt-h2">Connects to what you already use</h2>
            <p className="m-0 text-body text-ink-3">
              Start with Shopify, add channels as you grow.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
            {INTEGRATIONS.map((integ) => (
              <div key={integ.id} className="tile cursor-default">
                <span
                  className="integ-logo h-8 w-8 text-[13px]"
                  style={{ background: integ.tint }}
                >
                  {integ.initial}
                </span>
                <span className="text-[13px] font-medium">{integ.name}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ Industries */}
      <section id="industries" className="mkt-section">
        <div className="mkt-wrap flex flex-col gap-8 py-20">
          <div className="flex max-w-[560px] flex-col gap-2">
            <h2 className="mkt-h2">Built for how your industry books</h2>
            <p className="m-0 text-body text-ink-3">
              Pick your industry at signup and GetBooqin scaffolds the right vocabulary, services and hours —
              editable any time.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5">
            {PRESETS.map((p) => (
              <a
                key={p.id}
                href={`/signup?preset=${p.id}`}
                title={p.label}
                className="tile no-underline hover:no-underline hover:border-brand-500"
              >
                <span className="h-5 w-5 shrink-0 rounded-[6px]" style={{ background: p.tint }} />
                <span className="min-w-0 truncate text-body font-medium text-ink">{p.label.split(" / ")[0]}</span>
              </a>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- Pricing */}
      <section id="pricing" className="mkt-section mkt-alt">
        <div className="mkt-wrap flex flex-col gap-8 py-20">
          <div className="flex max-w-[560px] flex-col gap-2">
            <h2 className="mkt-h2">Simple pricing</h2>
            <p className="m-0 text-body text-ink-3">Start free. Upgrade when you need more staff or more stores.</p>
          </div>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
            {PLANS.map((plan) => (
              <PlanCard key={plan.name} {...plan} />
            ))}
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------------------- CTA */}
      <div className="mkt-wrap py-20">
        <div className="mkt-band">
          <div className="flex flex-col gap-2">
            <h2 className="m-0 text-[24px] font-semibold tracking-[-0.02em]">Ready to take your first booking?</h2>
            <p className="m-0 max-w-[420px] text-[14px] text-[#c9c2d4]">
              Be live in minutes — with your Shopify store, or without one.
            </p>
          </div>
          <a href="/signup" className="mkt-cta no-underline hover:no-underline">Start free</a>
        </div>
      </div>

      <LegalFooter />
    </div>
  );
}
