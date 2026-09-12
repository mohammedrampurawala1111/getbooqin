/**
 * Subscription lifecycle — everything that isn't a provider call.
 *
 * The hard rule this module exists to hold: **`Subscription` is written
 * by exactly one code path in the payment flow, the webhook handler.** A
 * checkout return page never writes subscription state; it redirects and
 * lets the webhook be the truth. The functions here that do write are the
 * ones outside that flow — creating a trial at signup, and admin actions,
 * which move no money.
 */
import prisma from "../db.js";
import type { Prisma } from "@prisma/client";
import { GetBooqinError } from "../booking/errors.js";
import { TRIAL_DAYS, TRIAL_PLAN } from "./entitlements.js";
import {
  currencyForCountry,
  providerForCurrency,
  isPlanId,
  type BillingCycle,
  type Currency,
  type PlanId,
} from "./plans.js";

type Db = Prisma.TransactionClient;

/**
 * Every tenant-scoped call site in `core` is addressed by (shop,
 * platform) — that pair is a business's identity everywhere in the
 * booking engine. Billing is addressed by `connectionId`. This is the
 * one bridge, and it is why `Connection` carries `@@unique([platform,
 * shop])`.
 *
 * Returns null rather than throwing: a shop with no Connection row is a
 * real state during Shopify's install handshake, and an enforcement
 * check that can't find one should fall open, not 500.
 */
export async function connectionIdForShop(shop: string, platform: string, db: Db = prisma): Promise<string | null> {
  const row = await db.connection.findUnique({
    where: { platform_shop: { platform, shop } },
    select: { id: true },
  });
  return row?.id ?? null;
}

export function trialEndsAtFrom(start = new Date()): Date {
  return new Date(start.getTime() + TRIAL_DAYS * 86_400_000);
}

/**
 * Gives a connection its subscription row if it doesn't have one.
 * Idempotent by the unique index on `connectionId`, so it is safe to call
 * from connection creation, from a backfill, and from a lazy read path
 * without coordinating between them.
 *
 * A new account starts on a **trial of Growth**, not of the cheapest
 * tier: people downgrade to what they actually need, and rarely upgrade
 * into something they have never used. No card is required — a card wall
 * at signup is the single biggest drop-off point a self-serve funnel can
 * have, and at these prices a card-required signup typically converts
 * 5–10× worse than trial-first.
 */
export async function ensureSubscription(
  connectionId: string,
  opts: { country?: string | null; now?: Date } = {},
  db: Db = prisma
) {
  const existing = await db.subscription.findUnique({ where: { connectionId } });
  if (existing) return existing;

  const now = opts.now ?? new Date();
  const currency = currencyForCountry(opts.country);

  try {
    return await db.subscription.create({
      data: {
        connectionId,
        plan: TRIAL_PLAN,
        status: "trialing",
        trialEndsAt: trialEndsAtFrom(now),
        billingProvider: "manual",
        currency,
        billingCycle: "monthly",
      },
    });
  } catch (err) {
    // Lost a race with a concurrent caller — the unique index did its
    // job. Read back rather than surfacing a write conflict for
    // something that is now in exactly the state we wanted.
    const raced = await db.subscription.findUnique({ where: { connectionId } });
    if (raced) return raced;
    throw err;
  }
}

export function get(connectionId: string) {
  return prisma.subscription.findUnique({ where: { connectionId } });
}

/**
 * Admin plan override — "Growth, free, until 31 Dec". Never touches a
 * payment provider: this is how you comp a beta user, a design partner
 * or a friend, and it is the mechanism to reach for 95% of the time. A
 * real provider discount means real money moving on a real mandate, and
 * the two vendors disagree about how (Razorpay has native offers, PayPal
 * has no coupon concept at all), so prefer this.
 *
 * Caller is responsible for the audit-log row — see core/src/admin.
 */
export async function setPlanManually(
  connectionId: string,
  plan: PlanId,
  opts: { until?: Date | null; now?: Date } = {},
  db: Db = prisma
) {
  if (!isPlanId(plan)) {
    throw new GetBooqinError("getbooqin_invalid_plan", `Unknown plan "${plan}".`, 400);
  }
  await ensureSubscription(connectionId, {}, db);
  return db.subscription.update({
    where: { connectionId },
    data: {
      plan,
      status: plan === "free" ? "free" : "active",
      billingProvider: "manual",
      currentPeriodEnd: opts.until ?? null,
      cancelAtPeriodEnd: false,
      // A manual grant ends any trial — it supersedes it, and leaving
      // both live makes "why is this account on Growth?" ambiguous.
      trialEndsAt: null,
    },
  });
}

/** Admin "extend trial" — the single most-used support action in any early-stage SaaS. */
export async function extendTrial(connectionId: string, until: Date, db: Db = prisma) {
  await ensureSubscription(connectionId, {}, db);
  return db.subscription.update({
    where: { connectionId },
    data: { plan: TRIAL_PLAN, status: "trialing", trialEndsAt: until },
  });
}

export interface ProviderSubscriptionState {
  plan: PlanId;
  status: "active" | "past_due" | "canceled";
  provider: "razorpay" | "paypal";
  providerSubscriptionId: string;
  providerCustomerId?: string | null;
  currency: Currency;
  billingCycle: BillingCycle;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
}

/**
 * Applies a normalised provider event. **The only path that may set a
 * paid state**, and it is called from the webhook handler and nowhere
 * else.
 *
 * `billingProvider` is written on first upgrade and then pinned — a live
 * subscription never migrates rails, because that means
 * cancel-and-re-authorise and loses the customer. A later event
 * arriving from the *other* provider for the same connection is a bug
 * somewhere upstream, and is rejected loudly rather than silently
 * overwriting a live mandate.
 */
export async function applyProviderState(
  connectionId: string,
  state: ProviderSubscriptionState,
  db: Db = prisma
) {
  const existing = await ensureSubscription(connectionId, {}, db);

  if (
    existing.billingProvider !== "manual" &&
    existing.billingProvider !== state.provider &&
    existing.providerSubscriptionId &&
    existing.providerSubscriptionId !== state.providerSubscriptionId
  ) {
    throw new GetBooqinError(
      "getbooqin_provider_mismatch",
      `Connection ${connectionId} is billed through ${existing.billingProvider}; refusing to apply a ${state.provider} event.`,
      409
    );
  }

  return db.subscription.update({
    where: { connectionId },
    data: {
      plan: state.plan,
      status: state.status,
      billingProvider: state.provider,
      providerSubscriptionId: state.providerSubscriptionId,
      providerCustomerId: state.providerCustomerId ?? existing.providerCustomerId,
      currency: state.currency,
      billingCycle: state.billingCycle,
      currentPeriodEnd: state.currentPeriodEnd ?? existing.currentPeriodEnd,
      cancelAtPeriodEnd: state.cancelAtPeriodEnd ?? false,
      trialEndsAt: null,
    },
  });
}
