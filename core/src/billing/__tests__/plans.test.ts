/**
 * Pure table checks — no database. The plan table is the spine the whole
 * billing system reads, and a typo in it is a pricing bug, so these
 * assert the invariants the rest of the code assumes rather than
 * restating the numbers.
 */
import { describe, expect, it } from "vitest";
import {
  PLANS, PLAN_ORDER, PRICES, FEATURE_KEYS, LIMIT_KEYS,
  currencyForCountry, providerForCountry,
  providerForCurrency, priceFor, formatPrice, billingCurrencyFor,
  formatLimit, limitToString, limitFromString, planRank, visiblePlans,
  type Currency, type PlanId, type LimitKey,
} from "../plans.js";

const PAID: Exclude<PlanId, "free">[] = ["starter", "growth", "business"];
const CURRENCIES: Currency[] = ["INR", "USD", "EUR"];

describe("plan table", () => {
  it("PLAN_ORDER covers every plan exactly once", () => {
    expect([...PLAN_ORDER].sort()).toEqual(Object.keys(PLANS).sort());
  });

  it("limits never shrink as you go up the ladder", () => {
    for (const limit of LIMIT_KEYS) {
      for (let i = 1; i < PLAN_ORDER.length; i++) {
        const lower = PLANS[PLAN_ORDER[i - 1]].limits[limit];
        const higher = PLANS[PLAN_ORDER[i]].limits[limit];
        expect(higher, `${PLAN_ORDER[i]}.${limit} < ${PLAN_ORDER[i - 1]}.${limit}`).toBeGreaterThanOrEqual(lower);
      }
    }
  });

  it("features are only ever added going up the ladder, never taken away", () => {
    for (let i = 1; i < PLAN_ORDER.length; i++) {
      const lower = PLANS[PLAN_ORDER[i - 1]].features;
      const higher = PLANS[PLAN_ORDER[i]].features;
      for (const feature of lower) {
        expect(higher, `${PLAN_ORDER[i]} drops "${feature}"`).toContain(feature);
      }
    }
  });

  it("every declared feature is a known key", () => {
    for (const plan of Object.values(PLANS)) {
      for (const feature of plan.features) expect(FEATURE_KEYS).toContain(feature);
    }
  });

  it("free is genuinely usable — it caps, it doesn't switch the product off", () => {
    // A free tier where reminders are off feels broken and earns bad
    // reviews; one that's capped at one person feels like a real product.
    // Every limit must be a real positive number, not zero.
    for (const limit of LIMIT_KEYS) {
      expect(PLANS.free.limits[limit as LimitKey], `free.${limit}`).toBeGreaterThan(0);
    }
  });

  it("ships three visible tiers, with business defined but hidden", () => {
    expect(visiblePlans().map((p) => p.id)).toEqual(["free", "starter", "growth"]);
    expect(PLANS.business.visible).toBe(false);
  });
});

describe("prices", () => {
  it("every paid plan has a price in all three currencies and both cycles", () => {
    for (const plan of PAID) {
      for (const currency of CURRENCIES) {
        for (const cycle of ["monthly", "yearly"] as const) {
          const price = priceFor(plan, currency, cycle);
          expect(price, `${plan}/${currency}/${cycle}`).toBeTruthy();
          expect(Number.isInteger(price!.amount), `${plan}/${currency}/${cycle} is not integer minor units`).toBe(true);
          expect(price!.amount).toBeGreaterThan(0);
        }
      }
    }
  });

  it("free has no price", () => {
    expect(priceFor("free", "USD", "monthly")).toBeNull();
  });

  it("yearly is exactly ten months' money — two months free", () => {
    for (const plan of PAID) {
      for (const currency of CURRENCIES) {
        const monthly = PRICES[plan][currency].monthly.amount;
        const yearly = PRICES[plan][currency].yearly.amount;
        expect(yearly, `${plan}/${currency}`).toBe(monthly * 10);
      }
    }
  });

  it("prices climb with the ladder in every currency", () => {
    for (const currency of CURRENCIES) {
      for (let i = 1; i < PAID.length; i++) {
        expect(PRICES[PAID[i]][currency].monthly.amount)
          .toBeGreaterThan(PRICES[PAID[i - 1]][currency].monthly.amount);
      }
    }
  });

  it("every price carries a razorpay id slot for both modes", () => {
    for (const plan of PAID) {
      for (const currency of CURRENCIES) {
        for (const cycle of ["monthly", "yearly"] as const) {
          const ids = PRICES[plan][currency][cycle].razorpay;
          expect(typeof ids.test, `${plan}/${currency}/${cycle}.test`).toBe("string");
          expect(typeof ids.live, `${plan}/${currency}/${cycle}.live`).toBe("string");
        }
      }
    }
  });

  it("no plan id is ever reused across two prices", () => {
    // Two prices sharing an id means a webhook can't tell which was
    // charged, and a checkout can subscribe someone to the wrong amount.
    // Empty slots (not yet created at Razorpay) are skipped.
    for (const mode of ["test", "live"] as const) {
      const seen = new Map<string, string>();
      for (const plan of PAID) {
        for (const currency of CURRENCIES) {
          for (const cycle of ["monthly", "yearly"] as const) {
            const id = PRICES[plan][currency][cycle].razorpay[mode];
            if (!id) continue;
            const where = `${plan}/${currency}/${cycle}`;
            expect(seen.get(id), `${where} reuses the ${mode} id of ${seen.get(id)}`).toBeUndefined();
            seen.set(id, where);
          }
        }
      }
    }
  });

  it("a test-mode id is never also used as a live-mode id", () => {
    // The failure this catches is pasting a test id into the live
    // column, which charges nobody and looks like it worked.
    const testIds = new Set<string>();
    for (const plan of PAID) {
      for (const currency of CURRENCIES) {
        for (const cycle of ["monthly", "yearly"] as const) {
          const id = PRICES[plan][currency][cycle].razorpay.test;
          if (id) testIds.add(id);
        }
      }
    }
    for (const plan of PAID) {
      for (const currency of CURRENCIES) {
        for (const cycle of ["monthly", "yearly"] as const) {
          const live = PRICES[plan][currency][cycle].razorpay.live;
          if (live) expect(testIds.has(live), `${plan}/${currency}/${cycle} live id is a test id`).toBe(false);
        }
      }
    }
  });
});

describe("currency and provider routing", () => {
  it("India bills INR through Razorpay", () => {
    expect(currencyForCountry("IN")).toBe("INR");
    expect(providerForCountry("IN")).toBe("razorpay");
  });

  it("eurozone bills EUR", () => {
    for (const country of ["NL", "DE", "FR", "IE", "ES"]) {
      expect(currencyForCountry(country), country).toBe("EUR");
    }
  });

  it("an EU member outside the eurozone falls back to USD rather than inventing a price", () => {
    // We have no PLN/SEK/CZK price, and pretending otherwise would show
    // a number we can't actually charge.
    for (const country of ["PL", "SE", "CZ", "HU", "RO"]) {
      expect(currencyForCountry(country), country).toBe("USD");
    }
  });

  it("everywhere else, and anything unknown, bills USD", () => {
    for (const country of ["US", "GB", "AU", "BR", "", null, undefined, "zz"]) {
      expect(currencyForCountry(country as string), String(country)).toBe("USD");
    }
  });

  it("sends India to Razorpay and everywhere else to PayPal", () => {
    // Razorpay can charge a euro card, but it settles to an Indian
    // account and presents as an Indian merchant — worse checkout for a
    // customer who already has a PayPal wallet, and the kind of
    // friction that shows up as an abandoned upgrade rather than an
    // error.
    expect(providerForCountry("IN")).toBe("razorpay");

    for (const country of ["NL", "DE", "FR", "US", "AU", "GB", "", null, undefined]) {
      expect(providerForCountry(country as string), String(country)).toBe("paypal");
    }
  });

  it("routes on currency, which is what a mandate is actually denominated in", () => {
    expect(providerForCurrency("INR")).toBe("razorpay");
    expect(providerForCurrency("EUR")).toBe("paypal");
    expect(providerForCurrency("USD")).toBe("paypal");
  });

  it("is case- and whitespace-insensitive about country codes", () => {
    expect(currencyForCountry(" in ")).toBe("INR");
    expect(currencyForCountry("nl")).toBe("EUR");
  });
});

describe("formatting", () => {
  it("uses Indian lakh grouping for INR", () => {
    // ₹1,00,000 not ₹100,000 — getting this wrong is an immediate
    // "these people don't sell here" signal. Today's table tops out at
    // ₹11,990 (Business, yearly), below where grouping diverges, so this
    // asserts the behaviour rather than a current price: the day a
    // multi-location or agency tier crosses a lakh, it has to read right.
    expect(formatPrice(100_000_00, "INR")).toBe("₹1,00,000");
    expect(formatPrice(1_199_000, "INR")).toBe("₹11,990");
  });

  it("renders whole amounts without trailing zeros", () => {
    expect(formatPrice(39_900, "INR")).toBe("₹399");
    expect(formatPrice(500, "USD")).toBe("$5");
    expect(formatPrice(1_000, "EUR")).toBe("€10");
  });

  it("shows decimals only when the amount actually has them", () => {
    expect(formatPrice(550, "USD")).toBe("$5.50");
  });

  it("round-trips limits through their string form", () => {
    expect(limitFromString(limitToString(10))).toBe(10);
    expect(limitFromString(limitToString(Infinity))).toBe(Infinity);
    expect(formatLimit(Infinity)).toBe("Unlimited");
    expect(formatLimit(3)).toBe("3");
  });

  it("treats garbage in a limit override as zero rather than NaN", () => {
    // An admin typing nonsense into the cap field must not produce a
    // limit that compares false against every number.
    expect(limitFromString("banana")).toBe(0);
    expect(limitFromString("-5")).toBe(0);
  });

  it("ranks plans cheapest to richest", () => {
    expect(planRank("free")).toBeLessThan(planRank("starter"));
    expect(planRank("starter")).toBeLessThan(planRank("growth"));
    expect(planRank("growth")).toBeLessThan(planRank("business"));
  });
});

describe("billingCurrencyFor()", () => {
  it("trusts the business's own currency when we can bill in it", () => {
    // A merchant pricing their services in ₹ is in India. This is the
    // strongest signal available and beats every fallback.
    expect(billingCurrencyFor({ currency: "INR", timezone: "America/New_York" })).toBe("INR");
    expect(billingCurrencyFor({ currency: "EUR", timezone: "Asia/Kolkata" })).toBe("EUR");
    expect(billingCurrencyFor({ currency: "USD", timezone: "Europe/Paris" })).toBe("USD");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(billingCurrencyFor({ currency: " inr " })).toBe("INR");
  });

  it("falls back to timezone for a currency we can't bill in", () => {
    // A UK salon prices in GBP, which isn't a billing currency here —
    // but Europe/London still says EUR beats USD.
    expect(billingCurrencyFor({ currency: "GBP", timezone: "Europe/London" })).toBe("EUR");
    expect(billingCurrencyFor({ currency: "AUD", timezone: "Asia/Kolkata" })).toBe("INR");
    expect(billingCurrencyFor({ currency: "GBP", timezone: "Asia/Calcutta" })).toBe("INR");
  });

  it("falls back to USD only when nothing tells us otherwise", () => {
    // USD is what "we genuinely can't tell" looks like — not a default
    // anyone was assigned. Assigning it at signup is what broke the
    // first real checkout.
    expect(billingCurrencyFor({})).toBe("USD");
    expect(billingCurrencyFor({ currency: "", timezone: "" })).toBe("USD");
    expect(billingCurrencyFor({ currency: "AUD", timezone: "Australia/Sydney" })).toBe("USD");
  });

  it("resolves an INR shop to a currency that actually has plans", () => {
    // The regression this file exists for: starter/USD/monthly had no
    // Razorpay plan, so checkout refused for every account.
    const currency = billingCurrencyFor({ currency: "INR", timezone: "Asia/Kolkata" });
    expect(PRICES.starter[currency].monthly.razorpay.test).toMatch(/^plan_/);
    expect(PRICES.growth[currency].yearly.razorpay.test).toMatch(/^plan_/);
  });
});
