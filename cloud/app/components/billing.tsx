/**
 * Settings → Billing.
 *
 * Neither Razorpay nor PayPal offers a hosted customer portal the way
 * Stripe does, so plan comparison, upgrade, cancel and (later) payment
 * history are all real UI here rather than a link out.
 *
 * **`sellable` is not the same question as "does this price exist".**
 * plans.ts carries a price for every tier in all three currencies, but a
 * price can only be charged if a matching plan exists at the provider
 * for the current mode. The server answers that (Checkout.sellablePrices)
 * and this renders from the answer. Conflating the two shipped an
 * Upgrade button whose only possible outcome was "We couldn't start that
 * subscription" — the refusal server-side was right; offering the button
 * was the bug.
 */
import { useState } from "react";
import { Form, useNavigation } from "react-router";
import {
  PLANS, PLAN_ORDER, LIMIT_KEYS, LIMIT_LABELS, FEATURE_LABELS,
  priceFor, formatPrice, formatLimit, monthlyEquivalent, planRank,
  type Currency, type BillingCycle, type FeatureKey, type LimitKey, type PlanId,
} from "getbooqin-core/billing/plans";

export interface BillingView {
  plan: PlanId;
  status: string;
  trialEndsAt: string | null;
  trialDaysLeft: number | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** How the subscription is paid, cached from the provider. Blank before the first charge. */
  paymentMethod: { kind: string; label: string } | null;
  currency: Currency;
  billingCycle: BillingCycle;
  inGrace: boolean;
  features: string[];
  /** null means unlimited — Infinity doesn't survive JSON. */
  limits: Record<string, number | null>;
  usage: Record<string, number>;
  /** "{plan}:{cycle}" -> can it actually be charged in this currency right now. */
  sellable: Record<string, boolean>;
  tax: { country: string; taxId: string; note: string; billingName: string; billingAddress: string };
  /** A mandate exists at the provider but nothing is being paid on it yet. */
  awaitingActivation: boolean;
  overrides: { key: string; value: string; reason: string; expiresAt: string | null }[];
  /**
   * Who takes the payment — "Razorpay" in India, "PayPal" everywhere
   * else. Named on screen because being sent to a vendor you weren't
   * expecting is the moment people abandon a checkout.
   */
  providerName: string;
  /** The merchant has just been returned here by the provider. */
  returnedFromCheckout: boolean;
  /** Issued invoices, newest first. Empty until the first payment clears. */
  invoices: { id: string; number: string; issuedAt: string; amount: string; planName: string }[];
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
}

/**
 * What is actually paying for this.
 *
 * Worth its own card because "which card is this coming off?" is a
 * question a merchant asks with their finance hat on, and until now the
 * only answer was to go and log in at the provider.
 *
 * ## It is read-only, and that is not laziness
 *
 * Under RBI tokenisation rules the instrument lives with Razorpay and
 * the card network, never on our servers, and swapping it on a live
 * mandate means cancelling and re-authorising — which is precisely the
 * step that loses people. So the action here is "set up a new payment
 * method", stated as what it is, rather than an inline card form that
 * would have to lie about what pressing it does.
 *
 * ## Blank is a real state
 *
 * A mandate can be authorised and not yet charged, and the provider
 * reports the method that *paid* — so there is genuinely nothing to
 * show until the first charge clears. Saying so beats an empty row.
 */
function PaymentMethodCard({ billing }: { billing: BillingView }) {
  // Nothing to pay with, and nothing to say. A Free account has no
  // mandate and no card here at all.
  if (billing.status === "free" || billing.status === "trialing") return null;

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">Payment method</h2>
      </div>
      <div className="card-body flex items-center justify-between gap-3">
        {billing.paymentMethod ? (
          <div className="flex flex-col gap-[3px]">
            <span className="text-body font-medium">{billing.paymentMethod.label}</span>
            <span className="text-meta text-muted">
              Billed by {billing.providerName}
              {billing.currentPeriodEnd ? `, next on ${billing.currentPeriodEnd}` : ""}.
            </span>
          </div>
        ) : (
          <span className="text-body text-muted">
            We'll show this once your first payment clears — {billing.providerName} tells us which method paid,
            not which one is on file.
          </span>
        )}
      </div>
      <div className="card-footer">
        <span className="text-meta text-muted">
          To change it, start a new plan — {billing.providerName} has to authorise a new mandate, and your card
          details never reach us.
        </span>
      </div>
    </div>
  );
}

/**
 * Every invoice ever issued on this account.
 *
 * Neither provider gives customers a portal, so this is the only place
 * a merchant can get last March's invoice back — and "can you re-send
 * my invoice" is a support email nobody should have to write. Rendered
 * on demand from the stored row, so the document is identical every
 * time it is fetched.
 */
function InvoiceHistory({ connectionId, invoices }: { connectionId: string; invoices: BillingView["invoices"] }) {
  return (
    <div className="card">
      <div className="card-header">
        <div className="flex flex-col gap-[3px]">
          <h2 className="card-title">Invoices</h2>
          <p className="m-0 text-meta text-muted">
            Emailed as a PDF when each payment clears, and kept here for whenever you need one again.
          </p>
        </div>
      </div>
      <div className="card-body">
        {invoices.length === 0 ? (
          <p className="m-0 text-body text-muted">
            No invoices yet — the first one is issued when your first payment clears.
          </p>
        ) : (
          <div className="flex flex-col">
            {invoices.map((inv) => (
              <div
                key={inv.id}
                className="flex items-center justify-between gap-3 border-b border-row py-[9px] text-[13px] last:border-0"
              >
                <span className="num shrink-0 text-subtle">{inv.issuedAt}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{inv.number}</span>
                <span className="hidden shrink-0 text-muted sm:inline">{inv.planName}</span>
                <span className="num shrink-0">{inv.amount}</span>
                <a
                  href={`/dashboard/${connectionId}/invoices/${inv.id}.pdf`}
                  className="btn-link shrink-0 text-brand-600"
                >
                  PDF
                </a>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * What just happened, for a merchant returning from the provider.
 *
 * PayPal sends them back here; Razorpay has no per-request return URL
 * and cannot, so this only ever renders for the PayPal rail. The loader
 * has already asked the provider for the real state before this
 * renders, so by now the plan either flipped or genuinely has not been
 * paid for — and both need saying. A page identical to the one they
 * left is how a successful payment reads as a failed one, and how
 * somebody ends up starting a second subscription.
 */
function CheckoutReturnBanner({ billing }: { billing: BillingView }) {
  if (!billing.returnedFromCheckout) return null;

  if (billing.status === "active") {
    return (
      <div className="rounded-[8px] bg-ok-bg px-3 py-2 text-[12.5px] font-medium text-ok">
        Payment received — you're on <strong>{PLANS[billing.plan].name}</strong>. Your invoice is on its way by email.
      </div>
    );
  }

  return (
    <div className="rounded-[8px] bg-warn-bg px-3 py-2 text-[12.5px] text-warn">
      <strong>We're still waiting on your payment to clear.</strong> Approving and the first charge settling are two
      separate steps, and the second can take a few minutes. Reload in a moment — your plan changes by itself the
      instant it lands. Don't start another subscription.
    </div>
  );
}

/** The one line at the top that answers "what am I on, and until when?" */
function StatusBanner({ billing }: { billing: BillingView }) {
  const plan = PLANS[billing.plan];

  if (billing.awaitingActivation) {
    // A mandate was started and never completed — abandoned on the
    // hosted page, or authorised and not yet charged. Said plainly,
    // because the plan cards below still offer an upgrade and the
    // merchant should know one is already half-done.
    return (
      <div className="rounded-[8px] bg-warn-bg px-3 py-2 text-[12.5px] text-warn">
        You started a subscription that hasn't been paid for yet. Nothing has been charged, and your current plan
        is unaffected — picking a plan below starts again and closes the unfinished one first.
      </div>
    );
  }

  if (billing.status === "trialing") {
    const days = billing.trialDaysLeft ?? 0;
    // Under a week is the point at which this stops being information
    // and starts being something to act on.
    const urgent = days <= 7;
    return (
      <div className={`rounded-[8px] px-3 py-2 text-[12.5px] ${urgent ? "bg-warn-bg text-warn" : "bg-brand-50 text-brand-600"}`}>
        You're on a free trial of <strong>{plan.name}</strong> —{" "}
        {days === 0 ? "it ends today" : `${days} day${days === 1 ? "" : "s"} left`}, until {formatDate(billing.trialEndsAt)}.
        {" "}Nothing is deleted when it ends; the account drops to Free and stays read-only above the Free limits.
      </div>
    );
  }

  if (billing.inGrace) {
    return (
      <div className="rounded-[8px] bg-danger-bg px-3 py-2 text-[12.5px] font-medium text-danger">
        A payment didn't go through. Your {plan.name} plan is still fully active while we retry — update your
        payment method to avoid interruption.
      </div>
    );
  }

  if (billing.status === "canceled") {
    return (
      <div className="rounded-[8px] bg-warn-bg px-3 py-2 text-[12.5px] text-warn">
        Your {plan.name} plan is cancelled and won't renew. You keep it until {formatDate(billing.currentPeriodEnd)}.
      </div>
    );
  }

  if (billing.plan === "free") {
    return (
      <div className="rounded-[8px] bg-row px-3 py-2 text-[12.5px] text-muted">
        You're on the <strong>Free</strong> plan. The booking page, reminders, calendar and your own vocabulary all
        work — it's capped, not cut down.
      </div>
    );
  }

  return (
    <div className="rounded-[8px] bg-ok-bg px-3 py-2 text-[12.5px] text-ok">
      <strong>{plan.name}</strong>, billed {billing.billingCycle}
      {billing.currentPeriodEnd ? `, renews ${formatDate(billing.currentPeriodEnd)}` : ""}.
    </div>
  );
}

/** Usage against cap, per limit. This is the part a merchant actually checks. */
function UsageMeters({ billing }: { billing: BillingView }) {
  return (
    <div className="flex flex-col">
      {LIMIT_KEYS.map((key) => {
        const cap = billing.limits[key];
        const used = billing.usage[key] ?? 0;
        const unlimited = cap === null;
        const over = !unlimited && used > cap;
        const pct = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(1, cap)) * 100));
        return (
          <div key={key} className="flex flex-col gap-[6px] border-b border-row py-[11px] last:border-b-0">
            <div className="flex items-baseline justify-between gap-3 text-[13px]">
              <span className={over ? "font-medium text-danger" : ""}>{LIMIT_LABELS[key as LimitKey]}</span>
              <span className="num shrink-0 text-[12px] text-muted">
                {used} / {unlimited ? "Unlimited" : cap}
              </span>
            </div>
            {!unlimited && (
              <div className="h-[5px] overflow-hidden rounded-[3px] bg-row">
                <div
                  className={`h-full rounded-[3px] ${over ? "bg-danger" : pct >= 80 ? "bg-chart-warn" : "bg-brand-500"}`}
                  style={{ width: `${Math.max(2, pct)}%` }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function BillingPage({
  billing, connectionId, error, saved,
}: {
  billing: BillingView;
  connectionId: string;
  error?: string;
  /** True right after a successful save on this page. */
  saved?: boolean;
}) {
  const current = PLANS[billing.plan];
  // Yearly first, deliberately. It is two months free and it is the
  // option a merchant is least likely to go looking for.
  const [cycle, setCycle] = useState<BillingCycle>(billing.billingCycle === "monthly" ? "monthly" : "yearly");
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  // The plan handoff leaves the SPA entirely (a native POST -> 303 ->
  // the provider), so useNavigation never sees it. Tracked here instead, so
  // the button that was pressed says "Starting…" and every other one
  // locks — a merchant who thinks nothing happened and presses a second
  // card is how two mandates get authorised.
  const [starting, setStarting] = useState<string | null>(null);
  const [billingName, setBillingName] = useState(billing.tax.billingName);
  const [billingAddress, setBillingAddress] = useState(billing.tax.billingAddress);
  const [country, setCountry] = useState(billing.tax.country);
  const [taxId, setTaxId] = useState(billing.tax.taxId);
  // GetBooqin sells from an Indian entity: India is a domestic GST
  // supply, everywhere else is a zero-rated B2B export — and the tax
  // number is what evidences the "B2B" half.
  const isExport = country.trim().toUpperCase() !== "IN";
  const features = new Set(billing.features as FeatureKey[]);
  const overCaps = LIMIT_KEYS.filter((key) => {
    const cap = billing.limits[key];
    return cap !== null && (billing.usage[key] ?? 0) > cap;
  });

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Your plan</h2>
        </div>
        <div className="card-body flex flex-col gap-3">
          {error && <p className="m-0 rounded-[8px] bg-danger-bg px-3 py-2 text-[12.5px] font-medium text-danger">{error}</p>}
          <CheckoutReturnBanner billing={billing} />
          <StatusBanner billing={billing} />

          {/* A downgrade is never destructive — nothing is deleted, and
              what already exists keeps working. The honest thing is to
              say which caps are exceeded rather than quietly blocking
              the next create with no explanation. */}
          {overCaps.length > 0 && (
            <div className="rounded-[8px] bg-warn-bg px-3 py-2 text-[12.5px] text-warn">
              You're over your plan on {overCaps.map((k) => LIMIT_LABELS[k as LimitKey].toLowerCase()).join(", ")}.
              Nothing has been removed and everything you have keeps working — you just can't add more until you
              upgrade.
            </div>
          )}

          <p className="m-0 text-meta text-muted">{current.blurb}</p>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <div className="flex flex-col gap-[3px]">
            <h2 className="card-title">What you're using</h2>
            <p className="m-0 text-meta text-muted">
              Bookings count customer-made ones only — anything you or your team enter by hand is never metered.
            </p>
          </div>
        </div>
        <div className="px-[18px] py-[4px]">
          <UsageMeters billing={billing} />
        </div>
      </div>

      {billing.overrides.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Applied to your account</h2>
          </div>
          <div className="px-[18px] py-[4px]">
            {billing.overrides.map((o) => (
              <div key={o.key} className="flex items-baseline justify-between gap-3 border-b border-row py-[11px] text-[13px] last:border-b-0">
                <span>{FEATURE_LABELS[o.key as FeatureKey] ?? o.key}</span>
                <span className="shrink-0 text-[12px] text-muted">
                  {o.value === "off" ? "Removed" : o.value === "on" ? "Added" : o.value}
                  {o.expiresAt ? ` · until ${formatDate(o.expiresAt)}` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <div className="flex flex-col gap-[3px]">
            <h2 className="card-title">Plans</h2>
            <p className="m-0 text-meta text-muted">
              Prices in {billing.currency}. Yearly is ten months' money for twelve months' service.
            </p>
          </div>
        </div>
        {!PLAN_ORDER.some((id) => billing.sellable[`${id}:${cycle}`]) && (
          <p className="m-0 mx-[18px] mt-[14px] rounded-[8px] bg-warn-bg px-3 py-2 text-[12.5px] text-warn">
            We can't take payment in {billing.currency} yet, so there's nothing to upgrade to from here. Your plan
            and limits below are still live. Get in touch and we'll sort it out directly.
          </p>
        )}
        <div className="flex items-center gap-2 px-[18px] pt-[14px]">
          {(["monthly", "yearly"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setCycle(option)}
              className={`rounded-full border px-[12px] py-[4px] text-meta ${cycle === option ? "border-brand-500 bg-brand-50 text-brand-600" : "border-line bg-surface text-muted"}`}
            >
              {option === "monthly" ? "Monthly" : "Yearly — 2 months free"}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-[10px] px-[18px] py-[14px] md:grid-cols-3">
          {PLAN_ORDER.filter((id) => PLANS[id].visible || id === billing.plan).map((id) => {
            const plan = PLANS[id];
            const chosen = priceFor(id, billing.currency, cycle);
            const yearly = priceFor(id, billing.currency, "yearly");
            const isCurrent = id === billing.plan && billing.billingCycle === cycle;
            // A plan with no id at the provider for this mode can't be
            // sold — providerPlanId() would refuse, so don't offer it.
            // Not "does a price exist" — does a plan exist at the
            // provider that can actually charge it. Those are different
            // questions and conflating them is what produced an Upgrade
            // button whose only possible outcome was an error.
            const purchasable = !!billing.sellable[`${id}:${cycle}`] && !isCurrent && id !== "free";
            const isUpgrade = planRank(id) > planRank(billing.plan);
            return (
              <div
                key={id}
                className={`flex flex-col gap-2 rounded-[9px] border px-[13px] py-[12px] ${isCurrent ? "border-brand-500 bg-surface" : "border-line bg-canvas-alt"}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-body font-semibold">{plan.name}</span>
                  {isCurrent && <span className="badge bg-brand-50 text-brand-600">Current</span>}
                </div>
                <div className="flex flex-col gap-px">
                  <span className="num text-[18px] font-medium tracking-[-0.02em]">
                    {chosen ? formatPrice(chosen.amount, billing.currency) : formatPrice(0, billing.currency)}
                    <span className="text-[12px] font-normal text-muted">/{cycle === "monthly" ? "mo" : "yr"}</span>
                  </span>
                  {cycle === "yearly" && yearly && (
                    <span className="text-[11.5px] text-subtle">
                      works out at {formatPrice(monthlyEquivalent(yearly.amount), billing.currency)}/mo
                    </span>
                  )}
                  {cycle === "monthly" && yearly && (
                    <span className="text-[11.5px] text-subtle">
                      or {formatPrice(yearly.amount, billing.currency)}/yr — 2 months free
                    </span>
                  )}
                </div>
                <p className="m-0 text-[12px] text-muted">{plan.blurb}</p>
                <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12px]">
                  {LIMIT_KEYS.map((key) => (
                    <li key={key} className="flex items-baseline justify-between gap-2">
                      <span className="text-subtle">{LIMIT_LABELS[key as LimitKey]}</span>
                      <span className="num shrink-0">{formatLimit(plan.limits[key as LimitKey])}</span>
                    </li>
                  ))}
                </ul>
                {plan.features.length > 0 && (
                  <ul className="m-0 flex list-none flex-col gap-1 border-t border-row p-0 pt-2 text-[12px] text-muted">
                    {plan.features.map((f) => (
                      <li key={f} className={features.has(f) ? "text-ink-2" : ""}>
                        {FEATURE_LABELS[f]}
                      </li>
                    ))}
                  </ul>
                )}
                {purchasable && (
                  // A plain <form>, not React Router's <Form>. This
                  // action answers with a 303 to the provider's hosted page
                  // — a cross-origin redirect, which the router has to
                  // recognise and turn into a document navigation
                  // itself. A native POST has the browser follow the
                  // redirect the way redirects are meant to work, with
                  // nothing in between, which is what a handoff to
                  // somebody else's payment page should be. It also
                  // gives back-navigation the right behaviour for free.
                  <form method="post" className="mt-auto pt-2" onSubmit={() => setStarting(id)}>
                    <input type="hidden" name="_section" value="billing_upgrade" />
                    <input type="hidden" name="plan" value={id} />
                    <input type="hidden" name="cycle" value={cycle} />
                    {/* Carried from the shared fields below, so the
                        merchant fills them in once rather than per card. */}
                    <input type="hidden" name="country" value={country} />
                    <input type="hidden" name="tax_id" value={taxId} />
                    <input type="hidden" name="billing_name" value={billingName} />
                    <input type="hidden" name="billing_address" value={billingAddress} />
                    <button
                      type="submit"
                      disabled={!!starting}
                      className={`w-full ${isUpgrade ? "btn-pri" : "btn-sec"}`}
                    >
                      {starting === id ? "Starting…" : isUpgrade ? `Upgrade to ${plan.name}` : `Switch to ${plan.name}`}
                    </button>
                  </form>
                )}
              </div>
            );
          })}
        </div>
        {/* Asked once, above the plan cards, rather than per card. */}
        <div className="flex flex-col gap-2 border-t border-row px-[18px] py-[14px]">
          <span className="text-body font-medium">Billing details</span>
          {/* Name and address are here because they go on the invoice,
              not because anyone enjoys typing them. A tax invoice has
              to name the entity being billed and carry its address, and
              the shop's trading name is not that — so these are asked
              once, and nothing is issued until they exist. */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-[12px] text-muted sm:col-span-2">
              Registered business name
              <input
                className="input w-full min-w-0"
                name="billing_name"
                value={billingName}
                onChange={(e) => setBillingName(e.target.value)}
                placeholder="Acme Dental Ltd"
                aria-label="Registered business name"
                maxLength={120}
              />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-muted sm:col-span-2">
              Billing address
              <textarea
                className="input w-full min-w-0"
                name="billing_address"
                value={billingAddress}
                onChange={(e) => setBillingAddress(e.target.value)}
                placeholder={"12 High Street\nBristol BS1 4ST"}
                aria-label="Billing address"
                rows={3}
                maxLength={400}
              />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-muted">
              Country your business is registered in
              <input
                className="input w-full min-w-0"
                value={country}
                onChange={(e) => setCountry(e.target.value.toUpperCase().slice(0, 2))}
                placeholder="IN"
                maxLength={2}
                aria-label="Country code"
              />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-muted">
              {isExport ? "VAT / business tax number" : "GSTIN (optional)"}
              <input
                className="input w-full min-w-0"
                value={taxId}
                onChange={(e) => setTaxId(e.target.value.toUpperCase())}
                placeholder={isExport ? "NL123456789B01" : "27AAPFU0939F1ZV"}
                aria-label="Tax number"
              />
            </label>
          </div>
          <p className="m-0 text-[11.5px] text-subtle">
            {isExport
              ? "We sell to registered businesses outside India. Your tax number makes this a zero-rated export — if you're in the EU, VAT is accounted for by you under the reverse charge."
              : "Indian GST applies. A GSTIN is optional and only needed if you want to claim input credit."}
          </p>

          {/* A Save of their own.
              These four fields previously existed only as hidden inputs
              on each plan card, so the copy above ("asked once, and
              nothing is issued until they exist") was true of a form
              that could not be submitted: a merchant who filled them in
              and navigated away lost all of it, and cancelling carried
              none of them either. */}
          <Form method="post" className="flex items-center gap-3">
            <input type="hidden" name="_section" value="billing_details" />
            <input type="hidden" name="country" value={country} />
            <input type="hidden" name="tax_id" value={taxId} />
            <input type="hidden" name="billing_name" value={billingName} />
            <input type="hidden" name="billing_address" value={billingAddress} />
            <button type="submit" disabled={busy} className="btn-sec">
              {busy ? "Saving…" : "Save billing details"}
            </button>
            {saved && <span className="alert-success">Saved.</span>}
          </Form>
        </div>

        <div className="card-footer flex-col items-start gap-2">
          <span className="text-meta text-muted">
            You'll be taken to {billing.providerName} to authorise the payment. Your plan changes once the first payment clears,
            not before.
          </span>
          {/* Cancelling is "don't renew", never "cut me off now" — the
              paid-for period is honoured either way. */}
          {(billing.status === "active" || billing.status === "past_due") && !billing.cancelAtPeriodEnd && (
            <Form method="post">
              <input type="hidden" name="_section" value="billing_cancel" />
              <button type="submit" disabled={busy} className="btn-link text-danger">
                Cancel subscription
              </button>
            </Form>
          )}
        </div>
      </div>

      <PaymentMethodCard billing={billing} />
      <InvoiceHistory connectionId={connectionId} invoices={billing.invoices} />
    </div>
  );
}
