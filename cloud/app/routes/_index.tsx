import { useState } from "react";
import type { Route } from "./+types/_index";
import { getUserSession } from "~/session.server";
import { LogoMark, PlanCard } from "~/components/onboarding";
import { TEMPLATE_CARDS, INTEGRATIONS } from "~/lib/presets";
import {
  visiblePlans, priceFor, formatPrice, formatLimit, CURRENCY_SYMBOL, type Currency,
} from "getbooqin-core/billing/plans";
import { Badge, LegalFooter, LogoutButton, ThemeToggle } from "~/components/ui";

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

/**
 * The pricing section renders from `plans.ts` — the same table the
 * server enforces and the checkout charges — rather than from a copy of
 * the numbers kept here.
 *
 * It used to be a hand-written array quoting $0/$29/$79 against a
 * product that charges ₹399/₹799, and it advertised "Deposits &
 * payments" for a feature that no longer exists. A visitor seeing one
 * price and being charged another is not a copy problem, and the only
 * version of a fix that survives is one that cannot drift: a browser
 * test now asserts this page's numbers against plans.ts.
 */
const MARKETING_COPY: Record<string, { blurb: string; extra: string[]; cta: string; href: string }> = {
  free: {
    blurb: "A real booking page for one person, free forever.",
    extra: ["Public booking page", "Email confirmations & reminders", "Calendar and customer records"],
    cta: "Start free",
    href: "/signup",
  },
  starter: {
    blurb: "Take the badge off and put it on your own website.",
    extra: ["Everything in Free", "Embed on your own site", "Waitlist with automatic offers"],
    cta: "Start free trial",
    href: "/signup",
  },
  growth: {
    blurb: "A team with roles, and your own email wording.",
    extra: ["Everything in Starter", "Rooms as bookable resources", "Group & class bookings", "Shopify product sync"],
    cta: "Start free trial",
    href: "/signup",
  },
};

/** Currencies a visitor can be quoted, matching what checkout can charge. */
const MARKETING_CURRENCIES = ["INR", "USD", "EUR"] as const;

export default function Home({ loaderData }: Route.ComponentProps) {
  // INR first: GetBooqin is sold from India, and it is the currency with
  // the best unit economics behind it (UPI AutoPay).
  const [currency, setCurrency] = useState<Currency>("INR");
  const { loggedIn } = loaderData;
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className="mkt-shell">
      {/* navOpen drives the collapsed menu directly. Below md, Product/
          Integrations/Industries/Pricing used to just disappear with
          nothing replacing them (UX audit's M4 finding) — a visitor on a
          phone couldn't reach pricing except by scrolling the whole page. */}
      <div className="mkt-bar">
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
          {/* Lives here, not the .ml-auto action group on the right — that
              row is already at its 341px overflow limit below (K3 above).
              Desktop has room in the anchor nav; mobile gets its own copy
              in the collapsed panel below instead of a second squeeze
              point. */}
          <ThemeToggle className="btn-sec hidden px-[9px] py-[7px] md:inline-flex" />
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
            {/* Was a <label role="button"> for a hidden checkbox — role=
                "button" let it carry aria-expanded/aria-controls (a bare
                <label> can't), but the label itself was never focusable or
                keyboard-operable, so a keyboard/screen-reader user could
                only tab onto the plain, unlabeled checkbox next to it —
                the element actually describing "menu, collapsed" was
                unreachable (UX audit's #13 finding; same fix applied to
                the dashboard sidebar's identical toggle). A real <button>
                is both focusable and the thing announcing its own state.
                This page hydrates like the rest of the app, so nothing
                that worked pre-JS via the label→checkbox click delegation
                is lost in practice. */}
            <button
              type="button"
              aria-label="Toggle menu"
              aria-expanded={navOpen}
              aria-controls="mkt-mobile-nav"
              onClick={() => setNavOpen((v) => !v)}
              className="btn-sec cursor-pointer px-[10px] py-[6px] md:hidden"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M2 4h12M2 8h12M2 12h12" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
        <nav id="mkt-mobile-nav" className={`${navOpen ? "flex" : "hidden"} flex-col gap-1 border-t border-line px-7 py-3 md:hidden`}>
          <a href="#product" className="mkt-link py-[9px]">Product</a>
          <a href="#integrations" className="mkt-link py-[9px]">Integrations</a>
          <a href="#industries" className="mkt-link py-[9px]">Industries</a>
          <a href="#pricing" className="mkt-link py-[9px]">Pricing</a>
          <ThemeToggle className="mkt-link flex items-center gap-2 py-[9px] text-left" showLabel />
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
            {TEMPLATE_CARDS.map((p) => (
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
            <p className="m-0 text-body text-ink-3">
              Start free. Upgrade when you need more staff. Every plan includes the booking page, reminders and
              your own vocabulary — the limits are what change.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {MARKETING_CURRENCIES.map((code) => (
              <button
                key={code}
                type="button"
                onClick={() => setCurrency(code)}
                className={`rounded-full border px-[12px] py-[4px] text-meta ${currency === code ? "border-brand-500 bg-brand-50 text-brand-600" : "border-line text-ink-3"}`}
              >
                {CURRENCY_SYMBOL[code]} {code}
              </button>
            ))}
            <span className="text-meta text-ink-3">· yearly is 2 months free</span>
          </div>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
            {visiblePlans().map((plan) => {
              const copy = MARKETING_COPY[plan.id];
              const monthly = priceFor(plan.id, currency, "monthly");
              return (
                <PlanCard
                  key={plan.id}
                  name={plan.name}
                  price={formatPrice(monthly?.amount ?? 0, currency)}
                  per="/mo"
                  featured={plan.id === "growth"}
                  cta={copy?.cta ?? "Start free trial"}
                  href={copy?.href ?? "/signup"}
                  blurb={copy?.blurb ?? plan.blurb}
                  features={[
                    `${formatLimit(plan.limits.resources)} staff or rooms`,
                    `${formatLimit(plan.limits.teamMembers)} team ${plan.limits.teamMembers === 1 ? "member" : "members"}`,
                    `${formatLimit(plan.limits.bookingsPerMonth)} bookings a month`,
                    ...(copy?.extra ?? []),
                  ]}
                />
              );
            })}
          </div>
          <p className="m-0 max-w-[560px] text-meta text-ink-3">
            Sold from India. Prices include tax. Outside India we sell to registered businesses only — see our{" "}
            <a href="/legal/terms" className="mkt-link">terms</a>.
          </p>
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
