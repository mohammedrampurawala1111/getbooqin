/**
 * The plan table. A plain data file, deliberately: changing a limit is a
 * one-line edit, and adding a tier needs no migration (which is why
 * `Subscription.plan` is a String, not an enum).
 *
 * Zero imports — this is safe to pull into a browser bundle, same as
 * settingsShared/bookingsShared/presets, so the pricing page and the
 * Billing screen render from exactly the table the server enforces.
 *
 * ## Three currencies, one provider
 *
 * A subscription bills in the currency of the account's country, all of
 * them through Razorpay:
 *
 * | Where           | Currency | Mandate rail                     |
 * |-----------------|----------|----------------------------------|
 * | India           | INR      | UPI AutoPay, card e-mandate, NACH|
 * | Eurozone        | EUR      | International card               |
 * | Everywhere else | USD      | International card               |
 *
 * The plan this was built from assumed PayPal for everything outside
 * India. That was wrong on the arithmetic: PayPal's **fixed** $0.49 per
 * charge is ~10 percentage points of a $5 subscription, where Razorpay's
 * international rate is a flat ~3% with no fixed component. One
 * integration is also one webhook scheme, one event vocabulary and one
 * set of failure modes instead of two.
 *
 * Non-INR needs **International Payments activated** on the Razorpay
 * account (a separate approval), and cross-border recurring is a
 * narrower capability than cross-border one-off charges — the domestic
 * rails above (UPI AutoPay, NACH) are India-only. `providerForCurrency`
 * still exists, and `BillingProvider` still has exactly one
 * implementation behind an interface, so PayPal can be added as a second
 * rail for USD/EUR without touching anything above this line.
 *
 * The INR prices are **not** a conversion of the USD ones. ₹399 is a
 * price; ₹415 is an exchange rate showing through, and it has to be
 * rewritten every time the rate moves. Round numbers in each currency,
 * set independently.
 *
 * ## Money is integer minor units
 *
 * Paise for INR, cents for USD and EUR. Never a float, and never a
 * decimal string — the booking tables' `Float` prices are a merchant's
 * own price list, where a rounding error is cosmetic. Here it is an
 * invoice.
 *
 * ## The ladder climbs on team and capacity, not on features
 *
 * That is how a booking business actually grows, and it is the only axis
 * a customer can self-assess against without reading a feature matrix.
 * Gate on limits, not on core features: a free tier where the booking
 * page, reminders, calendar and vocabulary all work — just capped — feels
 * like a real product and converts when the business grows. A free tier
 * with reminders switched off feels broken and earns bad reviews.
 */

export type PlanId = "free" | "starter" | "growth" | "business";
export type BillingCycle = "monthly" | "yearly";
export type Currency = "INR" | "USD" | "EUR";
export type ProviderId = "razorpay" | "paypal" | "manual";

/**
 * Feature keys. These are also valid `Entitlement.key` values, which is
 * what lets the admin console grant one to a single account without a
 * deploy — the mechanism that replaces Phase 1's deleted `ENABLE_*` env
 * booleans, and the same one that backs early access (§W8).
 */
/**
 * Every key here is **actually enforced somewhere**, with one documented
 * exception. A feature key that gates nothing is worse than no key: it
 * shows up in the admin console, writes an audit row when granted, and
 * changes nothing — so a plan appears to differ from another when it
 * does not.
 *
 * `embed` was removed for exactly that reason and **stays** removed,
 * though not for the original reason any more. The snippet exists now
 * (booking/embed.ts, on Settings -> Integrations) — it is simply not
 * sold, because embedding is free here by decision. The paid lever on
 * the booking page is `no_badge`: a merchant may frame the page
 * anywhere they like, and on Free our name rides along inside the
 * iframe exactly as it does outside it. Gating the snippet instead
 * would sell a restriction that a determined merchant routes around
 * with one line of their own HTML, while `no_badge` is enforced by the
 * page itself and cannot be.
 *
 * `early_access` is the exception, and deliberately so: it gates nothing
 * by design. It is a *marker* an admin sets on an account to say "this
 * one gets the next thing we ship dark", and the thing itself is granted
 * as its own key when it exists.
 */
export type FeatureKey =
  | "no_badge"
  | "branding"
  | "whatsapp"
  | "waitlist"
  | "team_roles"
  | "email_templates"
  | "shopify"
  | "export"
  | "priority_support"
  | "early_access";

export const FEATURE_KEYS: readonly FeatureKey[] = [
  "no_badge", "branding", "whatsapp", "waitlist", "team_roles",
  "email_templates", "shopify", "export", "priority_support", "early_access",
];

/** Human copy for the feature catalogue in /admin, so the keys don't become magic strings. */
export const FEATURE_LABELS: Record<FeatureKey, string> = {
  no_badge: "Remove the “Powered by GetBooqin” badge",
  // Sold beside no_badge deliberately. "Pay us to remove our name" is a
  // grudging purchase; "pay us and the page becomes yours" is the same
  // money for something a merchant actually wants, and it is what makes
  // the cheapest paid tier feel like a purchase rather than a toll.
  branding: "Your logo and colour on the booking page",
  // The merchant connects their own WhatsApp Business Account and
  // attaches their own payment method, so Meta bills them for the
  // messages and we carry no per-message cost. That is the only reason
  // this can sit in a plan at all rather than being a metered add-on —
  // the MVP plan ruled WhatsApp out precisely because per-message cost
  // destroys the unit economics of a sub-$15 tier, and it does, when
  // the cost is ours.
  whatsapp: "Confirmations and reminders on WhatsApp",
  waitlist: "Waitlist with automatic offer cascade",
  team_roles: "Team roles (admin / write / read)",
  email_templates: "Editable email templates",
  // Deliberately granted by **no plan**. Shopify is shipped dark until
  // there is a decision to release it generally (the plan's gate G3 —
  // whether an App Store listing is in scope — is still open, and the
  // embedded admin is being collapsed to one screen in Phase 4). An
  // admin grants this per account from /admin to let someone in early;
  // that is the whole point of entitlements existing per-account rather
  // than per-deploy.
  shopify: "Connect a Shopify store",
  export: "CSV export",
  priority_support: "Priority support",
  early_access: "Early access to new features",
};

export type LimitKey = "resources" | "services" | "teamMembers" | "bookingsPerMonth" | "businesses";

export const LIMIT_KEYS: readonly LimitKey[] = [
  "resources", "services", "teamMembers", "bookingsPerMonth", "businesses",
];

export const LIMIT_LABELS: Record<LimitKey, string> = {
  resources: "Resources (staff / rooms)",
  services: "Services",
  teamMembers: "Team members",
  bookingsPerMonth: "Customer bookings per month",
  businesses: "Businesses / locations",
};

/** `Infinity` means unlimited. JSON-safe conversion is `limitToString` below. */
export type PlanLimits = Record<LimitKey, number>;

export interface Plan {
  id: PlanId;
  name: string;
  blurb: string;
  /**
   * Whether the pricing page and the in-app upgrade picker offer it.
   * `business` ships defined-but-hidden: at these price gaps a fourth
   * column costs more in comparison time than it earns, and the first
   * person who asks for unlimited or multi-location will tell you what
   * the tier should actually contain. Enable it for them from /admin —
   * no deploy.
   */
  visible: boolean;
  limits: PlanLimits;
  features: readonly FeatureKey[];
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    blurb: "A real booking page, capped at one person.",
    visible: true,
    limits: { resources: 1, services: 3, teamMembers: 1, bookingsPerMonth: 50, businesses: 1 },
    features: [],
  },
  starter: {
    id: "starter",
    name: "Starter",
    blurb: "Make the booking page yours, and add a waitlist.",
    visible: true,
    limits: { resources: 3, services: Infinity, teamMembers: 2, bookingsPerMonth: Infinity, businesses: 1 },
    features: ["no_badge", "branding", "waitlist"],
  },
  growth: {
    id: "growth",
    name: "Growth",
    blurb: "A team with roles, and your own email wording.",
    visible: true,
    limits: { resources: 10, services: Infinity, teamMembers: 6, bookingsPerMonth: Infinity, businesses: 1 },
    features: ["no_badge", "branding", "whatsapp", "waitlist", "team_roles", "email_templates", "export"],
  },
  business: {
    id: "business",
    name: "Business",
    blurb: "Unlimited, across up to five locations.",
    visible: false,
    limits: {
      resources: Infinity, services: Infinity, teamMembers: Infinity,
      bookingsPerMonth: Infinity, businesses: 5,
    },
    features: [
      "no_badge", "branding", "whatsapp", "waitlist", "team_roles", "email_templates",
      "export", "priority_support", "early_access",
    ],
  },
};

/** Cheapest first — the order the pricing page and the upgrade picker render in. */
export const PLAN_ORDER: readonly PlanId[] = ["free", "starter", "growth", "business"];

/**
 * A new account's trial.
 *
 * Growth — the middle tier, not the cheapest. People downgrade to what
 * they turn out to need; they rarely upgrade into something they have
 * never used.
 *
 * Here rather than in entitlements.ts, which enforces them, because
 * this file is the one with no imports: the signup and onboarding
 * screens have to state the offer, and they run in the browser.
 */
export const TRIAL_DAYS = 30;
export const TRIAL_PLAN: PlanId = "growth";

export type PaidPlanId = Exclude<PlanId, "free">;

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && value in PLANS;
}

export function planOrDefault(value: unknown): Plan {
  return isPlanId(value) ? PLANS[value] : PLANS.free;
}

/** Cheapest-to-richest rank, for "is this an upgrade or a downgrade" questions. */
export function planRank(id: PlanId): number {
  return PLAN_ORDER.indexOf(id);
}

export function visiblePlans(): Plan[] {
  return PLAN_ORDER.map((id) => PLANS[id]).filter((p) => p.visible);
}

/* ------------------------------------------------------------------ */
/* Prices                                                              */
/* ------------------------------------------------------------------ */

/**
 * The provider's own handle for a price, per mode.
 *
 * Committed rather than held in env vars, which is what the plan this
 * was built from called for. A Razorpay plan id is not a credential —
 * it is an opaque reference, useless without the API key, the same class
 * of thing as a Stripe price id. Twelve env vars for non-secret data
 * that changes twice a year bought nothing except the ability to
 * half-configure a deploy, and split the price away from the id that
 * charges it so nothing could check the two agreed.
 *
 * Which half is used is derived from `RAZORPAY_KEY_ID`'s own prefix
 * (`rzp_test_` / `rzp_live_`) rather than a separate variable — see
 * providers/razorpay.ts. Mode cannot drift out of step with the keys,
 * because it *is* the keys.
 *
 * Empty string means "not created at Razorpay yet", which the checkout
 * refuses rather than guessing at.
 */
export interface ProviderPlanIds {
  test: string;
  live: string;
}

export interface Price {
  /** Integer minor units — paise for INR, cents for USD/EUR. */
  amount: number;
  /**
   * The vendor's own plan id, per rail and per mode.
   *
   * Both rails carry every currency in the table even though only one
   * is ever used for a given one — INR goes to Razorpay, USD and EUR to
   * PayPal (see providerForCurrency). The unused slots stay empty
   * rather than being deleted, because an account that started on the
   * other rail before the split still has to be reconciled and
   * cancelled there, and that needs its plan id to still resolve.
   */
  razorpay: ProviderPlanIds;
  paypal?: ProviderPlanIds;
}

/**
 * Yearly is ten months' money for twelve months' service — two months
 * free. Worth pushing as the default-selected option rather than hiding
 * it behind a toggle, though less violently than it would have been on
 * PayPal: Razorpay's fee is percentage-only, so annual saves on
 * transaction count and churn rather than on a fixed per-charge cost.
 */
export const PRICES: Record<PaidPlanId, Record<Currency, Record<BillingCycle, Price>>> = {
  starter: {
    INR: {
      monthly: { amount: 39_900, razorpay: { test: "plan_TbDcKTKQfPNJdh", live: "plan_TbDREf2wPpTCaT" } },
      yearly: { amount: 399_000, razorpay: { test: "plan_TbDcfyTcaaGoaG", live: "plan_TbDRyOPpAbW8PW" } },
    },
    USD: {
      monthly: { amount: 500, razorpay: { test: "plan_TbEJl53SjngQhB", live: "" }, paypal: { test: "", live: "" } },
      yearly: { amount: 5_000, razorpay: { test: "plan_TbEJlXlTVjNx2o", live: "" }, paypal: { test: "", live: "" } },
    },
    EUR: {
      monthly: { amount: 500, razorpay: { test: "plan_TbEJildXewGMHz", live: "" }, paypal: { test: "", live: "" } },
      yearly: { amount: 5_000, razorpay: { test: "plan_TbEJjamIDOP9q3", live: "" }, paypal: { test: "", live: "" } },
    },
  },
  growth: {
    INR: {
      monthly: { amount: 79_900, razorpay: { test: "plan_TbDcxhXUpvhTxO", live: "plan_TbDSJLkyiCyNC5" } },
      // live is deliberately empty. The first live "GetBooqin Growth
      // Yearly" (plan_TbDSgwJW8j7O0t) was created at Razorpay with
      // period=monthly — it would have billed ₹7,990 every month instead
      // of every year, a 12x overcharge. Razorpay plans are immutable, so
      // it needs replacing with a real period=yearly plan before this can
      // go live. An empty slot makes providerPlanId() return null and the
      // checkout refuse, which is the right outcome for a price that
      // would charge wrongly.
      yearly: { amount: 799_000, razorpay: { test: "plan_TbDdFi79xihffD", live: "" } },
    },
    USD: {
      monthly: { amount: 1_000, razorpay: { test: "plan_TbEJm05s3QoX7Z", live: "" }, paypal: { test: "", live: "" } },
      yearly: { amount: 10_000, razorpay: { test: "plan_TbEJmSjhRMH2yJ", live: "" }, paypal: { test: "", live: "" } },
    },
    EUR: {
      monthly: { amount: 1_000, razorpay: { test: "plan_TbEJk5hXqnTEYh", live: "" }, paypal: { test: "", live: "" } },
      yearly: { amount: 10_000, razorpay: { test: "plan_TbEJkbTWSa1VNN", live: "" }, paypal: { test: "", live: "" } },
    },
  },
  business: {
    INR: {
      monthly: { amount: 119_900, razorpay: { test: "", live: "" } },
      yearly: { amount: 1_199_000, razorpay: { test: "", live: "" } },
    },
    USD: {
      monthly: { amount: 1_500, razorpay: { test: "", live: "" }, paypal: { test: "", live: "" } },
      yearly: { amount: 15_000, razorpay: { test: "", live: "" }, paypal: { test: "", live: "" } },
    },
    EUR: {
      monthly: { amount: 1_500, razorpay: { test: "", live: "" }, paypal: { test: "", live: "" } },
      yearly: { amount: 15_000, razorpay: { test: "", live: "" }, paypal: { test: "", live: "" } },
    },
  },
};

export function priceFor(plan: PlanId, currency: Currency, cycle: BillingCycle): Price | null {
  if (plan === "free") return null;
  return PRICES[plan][currency][cycle];
}

/* ------------------------------------------------------------------ */
/* Currency + provider routing                                         */
/* ------------------------------------------------------------------ */

export const CURRENCY_SYMBOL: Record<Currency, string> = { INR: "₹", USD: "$", EUR: "€" };

/** Minor units per major unit. All three are 100; named so the maths below reads. */
export const MINOR_UNITS: Record<Currency, number> = { INR: 100, USD: 100, EUR: 100 };

/**
 * ISO-3166 alpha-2 codes billing in EUR. Only countries that actually use
 * the euro — an EU member outside the eurozone (Poland, Sweden, Czechia…)
 * falls through to USD, which is honest: we have no PLN/SEK/CZK price.
 */
export const EUROZONE: readonly string[] = [
  "AT", "BE", "HR", "CY", "EE", "FI", "FR", "DE", "GR", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PT", "SK", "SI", "ES",
  // Non-EU euro users, for completeness.
  "AD", "MC", "SM", "VA", "ME", "XK",
];

export function currencyForCountry(country: string | null | undefined): Currency {
  const code = (country ?? "").trim().toUpperCase();
  if (code === "IN") return "INR";
  if (EUROZONE.includes(code)) return "EUR";
  return "USD";
}

/**
 * The account's country decides the rail, and `Subscription.currency`
 * freezes that decision at first upgrade. A live subscription is never
 * migrated between providers — that means cancel-and-re-authorise, which
 * loses people.
 */
export function providerForCurrency(currency: Currency): Exclude<ProviderId, "manual"> {
  // India on Razorpay, everywhere else on PayPal.
  //
  // Razorpay can technically charge a euro or dollar card, but it
  // settles to an Indian account and presents as an Indian merchant —
  // for a European or American customer that is a worse checkout than
  // the wallet they already have, and it is the kind of friction that
  // shows up as an abandoned upgrade rather than as an error.
  //
  // This answers the question only for a **new** subscription. Which
  // vendor holds an existing mandate is read from
  // `Subscription.billingProvider`, because a live subscription is
  // never migrated: that means cancel-and-re-authorise, which loses the
  // customer. An account that started on Razorpay in EUR before this
  // split stays on Razorpay for the rest of its life.
  return currency === "INR" ? "razorpay" : "paypal";
}

export function providerForCountry(country: string | null | undefined): Exclude<ProviderId, "manual"> {
  return providerForCurrency(currencyForCountry(country));
}

/**
 * The currency an account should be billed in, worked out from what the
 * shop already tells us about itself.
 *
 * There is no country field anywhere in the product — asking for one at
 * signup to serve a billing screen nobody has reached yet would be the
 * wrong trade. These two signals are already collected on Settings →
 * General for real reasons, and between them they're right far more
 * often than a default is:
 *
 * 1. **The business's own currency.** A merchant pricing their services
 *    in ₹ is in India. This is the strongest signal we have, and it is
 *    wrong only for the rare business that prices in a currency it
 *    doesn't live in.
 * 2. **Timezone**, when the currency isn't one we can bill in — a UK
 *    salon prices in GBP, which is not a billing currency here, but
 *    Europe/London is still enough to know EUR beats USD.
 *
 * USD is the last resort, not the default: it is what "we genuinely
 * can't tell" looks like.
 *
 * Only ever consulted before the first mandate exists. Once a
 * subscription is live its currency is frozen on the row, because
 * re-deriving it would silently re-price an existing mandate.
 */
export function billingCurrencyFor(shop: { currency?: string | null; timezone?: string | null }): Currency {
  const declared = (shop.currency ?? "").trim().toUpperCase();
  if (isCurrency(declared)) return declared;

  const zone = (shop.timezone ?? "").trim();
  if (zone === "Asia/Kolkata" || zone === "Asia/Calcutta") return "INR";
  if (zone.startsWith("Europe/")) return "EUR";

  return "USD";
}

export function isCurrency(value: unknown): value is Currency {
  return value === "INR" || value === "USD" || value === "EUR";
}

export function isBillingCycle(value: unknown): value is BillingCycle {
  return value === "monthly" || value === "yearly";
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/**
 * Renders integer minor units as a price string. `Intl.NumberFormat` does
 * the grouping, which matters for INR specifically — ₹1,19,900 uses the
 * Indian lakh grouping, not ₹119,900, and getting that wrong is an
 * immediate "these people don't sell here" signal.
 *
 * A whole-number amount prints without decimals (₹399, not ₹399.00) —
 * every price in the table above is whole, and trailing zeros on a
 * pricing page read as precision nobody asked for.
 */
export function formatPrice(amount: number, currency: Currency): string {
  const major = amount / MINOR_UNITS[currency];
  const fractionDigits = Number.isInteger(major) ? 0 : 2;
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(major);
}

/** "₹799/mo" / "$100/yr" — the short form used in tables and strips. */
export function formatPriceWithCycle(amount: number, currency: Currency, cycle: BillingCycle): string {
  return `${formatPrice(amount, currency)}/${cycle === "monthly" ? "mo" : "yr"}`;
}

/** What a yearly plan costs per month, for the "works out at …" line. */
export function monthlyEquivalent(yearlyAmount: number): number {
  return Math.round(yearlyAmount / 12);
}

export function limitToString(value: number): string {
  return Number.isFinite(value) ? String(value) : "unlimited";
}

export function limitFromString(value: string): number {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "unlimited" || trimmed === "infinity") return Infinity;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** "Unlimited" / "10" / "1" — for a plan comparison cell. */
export function formatLimit(value: number): string {
  return Number.isFinite(value) ? String(value) : "Unlimited";
}
