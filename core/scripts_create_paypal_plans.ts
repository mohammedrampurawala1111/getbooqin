/**
 * Creates GetBooqin's plans at PayPal and prints the ids to paste into
 * plans.ts.
 *
 * PayPal, like Razorpay, needs a plan to exist on its side before
 * anything can be charged against it — and a plan is immutable once
 * created, so this is deliberately a one-off script whose output gets
 * committed rather than something the app does at runtime. A price that
 * can change without anyone noticing is how a customer ends up charged
 * an amount nobody agreed.
 *
 * Idempotent by name: a plan that already exists for the same
 * (plan, currency, cycle) is reported rather than duplicated.
 *
 * Usage — sandbox first, then live:
 *   PAYPAL_ENV=sandbox PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… \
 *     npx tsx core/scripts_create_paypal_plans.ts
 *
 * Then paste the printed ids into PRICES in core/src/billing/plans.ts
 * and verify them by reading them back (see --verify below) before
 * deploying. Razorpay taught us that lesson: a plan created with the
 * wrong period billed a yearly price monthly, and only reading it back
 * caught it.
 */
import { PLANS, PRICES, type BillingCycle, type Currency, type PaidPlanId } from "./src/billing/plans.js";

const ENV = process.env.PAYPAL_ENV === "live" ? "live" : "sandbox";
const BASE = ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
const VERIFY_ONLY = process.argv.includes("--verify");

/** PayPal bills these currencies for us; INR stays on Razorpay. */
const CURRENCIES: Currency[] = ["USD", "EUR"];

async function token(): Promise<string> {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.");

  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal refused the credentials (${res.status}).`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function api(path: string, init: RequestInit = {}, auth = ""): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

async function ensureProduct(auth: string): Promise<string> {
  const list = await api("/v1/catalogs/products?page_size=100", {}, auth);
  const body = (await list.json()) as { products?: { id: string; name: string }[] };
  const existing = body.products?.find((p) => p.name === "GetBooqin");
  if (existing) {
    console.log(`product: ${existing.id} (existing)`);
    return existing.id;
  }

  const res = await api(
    "/v1/catalogs/products",
    {
      method: "POST",
      body: JSON.stringify({
        name: "GetBooqin",
        description: "Online booking for appointment businesses",
        type: "SERVICE",
        category: "SOFTWARE",
      }),
    },
    auth
  );
  const created = (await res.json()) as { id?: string; message?: string };
  if (!res.ok || !created.id) throw new Error(`Could not create the product: ${created.message ?? res.status}`);
  console.log(`product: ${created.id} (created)`);
  return created.id;
}

function planName(plan: PaidPlanId, currency: Currency, cycle: BillingCycle): string {
  return `GetBooqin ${PLANS[plan].name} ${cycle === "monthly" ? "Monthly" : "Yearly"} ${currency}`;
}

async function existingPlans(auth: string, productId: string) {
  const res = await api(`/v1/billing/plans?product_id=${productId}&page_size=100`, {}, auth);
  const body = (await res.json()) as { plans?: { id: string; name: string; status: string }[] };
  return body.plans ?? [];
}

async function main() {
  const auth = await token();
  const productId = await ensureProduct(auth);
  const already = await existingPlans(auth, productId);

  const results: string[] = [];

  for (const plan of ["starter", "growth", "business"] as PaidPlanId[]) {
    for (const currency of CURRENCIES) {
      for (const cycle of ["monthly", "yearly"] as BillingCycle[]) {
        const price = PRICES[plan][currency][cycle];
        const name = planName(plan, currency, cycle);
        const found = already.find((p) => p.name === name);

        if (found) {
          results.push(`${plan}/${currency}/${cycle}: ${found.id}  (existing, ${found.status})`);
          continue;
        }
        if (VERIFY_ONLY) {
          results.push(`${plan}/${currency}/${cycle}: MISSING`);
          continue;
        }

        const res = await api(
          "/v1/billing/plans",
          {
            method: "POST",
            body: JSON.stringify({
              product_id: productId,
              name,
              status: "ACTIVE",
              billing_cycles: [
                {
                  frequency: {
                    // The field that has to be right. A yearly price on
                    // a MONTH interval bills twelve times what anyone
                    // agreed to — exactly the Razorpay mistake this
                    // script exists to avoid repeating.
                    interval_unit: cycle === "monthly" ? "MONTH" : "YEAR",
                    interval_count: 1,
                  },
                  tenure_type: "REGULAR",
                  sequence: 1,
                  // 0 = until cancelled. PayPal, unlike Razorpay, has a
                  // real "forever", so no ten-year fudge is needed.
                  total_cycles: 0,
                  pricing_scheme: {
                    fixed_price: { value: (price.amount / 100).toFixed(2), currency_code: currency },
                  },
                },
              ],
              payment_preferences: {
                auto_bill_outstanding: true,
                setup_fee_failure_action: "CONTINUE",
                payment_failure_threshold: 3,
              },
            }),
          },
          auth
        );

        const created = (await res.json()) as { id?: string; message?: string };
        if (!res.ok || !created.id) {
          results.push(`${plan}/${currency}/${cycle}: FAILED — ${created.message ?? res.status}`);
          continue;
        }
        results.push(`${plan}/${currency}/${cycle}: ${created.id}  (created)`);
      }
    }
  }

  console.log(`\n--- PayPal ${ENV} plans ---`);
  for (const line of results) console.log(line);
  console.log(
    `\nPaste these into PRICES in core/src/billing/plans.ts under paypal.${ENV === "live" ? "live" : "test"},\n` +
      `then re-run with --verify to read them back before deploying.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
