/**
 * One function decides what an account can do: `entitlementsFor()`.
 * Plan limits, trial state, admin grants and comped accounts all resolve
 * through it, and every gate in the product is a `can()` or
 * `withinLimit()` call against its result.
 *
 * ```
 * plan defaults  ∪  admin grants  −  admin revokes
 * ```
 *
 * **This is what replaces `featureFlags.ts`.** Phase 1 deleted those five
 * `ENABLE_*` env booleans; this is strictly better than they were —
 * per account instead of per deploy, changeable from the admin console
 * without a redeploy, and the same mechanism that backs early access
 * (§W8). Shipping a feature dark now means granting it to five accounts
 * and watching, not editing `fly.toml`.
 *
 * ## Trial expiry is lazy
 *
 * A trial that has run out resolves as Free the moment anyone asks,
 * without a nightly job having run. There is no scheduler to fail, and an
 * account nobody looks at does not need its row updated to be correct.
 * The row *is* updated opportunistically when we notice (see
 * `settleExpiredTrial`), but only as tidiness — never as the thing
 * correctness depends on.
 *
 * ## Downgrade is never destructive
 *
 * A Growth account with six resources that drops to Starter (cap 3)
 * keeps all six. They stay visible and their bookings keep working; what
 * is blocked is creating the seventh. Deleting a merchant's data because
 * their card expired is how you earn a chargeback and a public
 * complaint — `withinLimit()` reports `over: true` so the UI can show a
 * persistent banner instead.
 */
import prisma from "../db.js";
import {
  PLANS,
  planOrDefault,
  limitFromString,
  type FeatureKey,
  type LimitKey,
  type PlanId,
  type PlanLimits,
  type Currency,
  type BillingCycle,
  type ProviderId,
} from "./plans.js";

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled" | "free";

/**
 * How long a failed payment buys before entitlements actually drop.
 * Neither provider chases the customer the way Stripe does, so this
 * window is ours to honour: the banner and the dunning emails go out
 * during it, and `past_due` keeps full access until it expires.
 */
export const PAST_DUE_GRACE_DAYS = 7;

/** A new account's trial, in days. Growth (the middle tier), not the cheapest — people downgrade to what they need, they rarely upgrade into something they've never used. */
export const TRIAL_DAYS = 30;
export const TRIAL_PLAN: PlanId = "growth";

export interface Entitlements {
  connectionId: string;
  /** The plan actually in force right now — not necessarily the row's `plan` (an expired trial resolves to "free"). */
  plan: PlanId;
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  /** Whole days of access left, rounded up, never negative. See daysRemaining(). */
  trialDaysLeft: number | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  billingProvider: ProviderId;
  currency: Currency;
  billingCycle: BillingCycle;
  limits: PlanLimits;
  features: Set<FeatureKey>;
  /** True while a failed payment is inside its grace window — access is intact, but the UI should say so. */
  inGrace: boolean;
  /** Admin-granted keys in force, for the "why does this account have X?" question. */
  overrides: { key: string; value: string; reason: string; expiresAt: Date | null }[];
}

/**
 * Whole days a merchant still has access for. Rounds **up**, which is
 * the question being asked: a trial ending in "10 days minus the
 * millisecond it took to read the row" is 10 days of access, not 9, and
 * flooring it would also show "0 days left" on an account that still
 * works perfectly. The last partial day counts as a day, and the
 * countdown reaches 0 only once the trial has actually ended.
 */
function daysRemaining(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / 86_400_000);
}

/**
 * The plan a subscription row actually confers *right now*, before admin
 * overrides. This is where a lapsed trial becomes Free without anything
 * having written to the database.
 */
function effectivePlan(
  row: { plan: string; status: string; trialEndsAt: Date | null; currentPeriodEnd: Date | null },
  now: Date
): { plan: PlanId; status: SubscriptionStatus; inGrace: boolean } {
  const declared = planOrDefault(row.plan).id;

  if (row.status === "trialing") {
    if (row.trialEndsAt && row.trialEndsAt.getTime() <= now.getTime()) {
      return { plan: "free", status: "free", inGrace: false };
    }
    return { plan: declared, status: "trialing", inGrace: false };
  }

  if (row.status === "past_due") {
    // The grace window runs from the end of the period that wasn't paid
    // for. No period end recorded (shouldn't happen, but a provider can
    // deliver events out of order) means we give the benefit of the
    // doubt rather than cutting someone off on a missing field.
    const graceEnds = row.currentPeriodEnd
      ? new Date(row.currentPeriodEnd.getTime() + PAST_DUE_GRACE_DAYS * 86_400_000)
      : null;
    if (!graceEnds || graceEnds.getTime() > now.getTime()) {
      return { plan: declared, status: "past_due", inGrace: true };
    }
    return { plan: "free", status: "free", inGrace: false };
  }

  if (row.status === "canceled") {
    // Cancelling is "don't renew", not "cut me off now" — paid-for time
    // is paid for.
    if (row.currentPeriodEnd && row.currentPeriodEnd.getTime() > now.getTime()) {
      return { plan: declared, status: "canceled", inGrace: false };
    }
    return { plan: "free", status: "free", inGrace: false };
  }

  if (row.status === "active") return { plan: declared, status: "active", inGrace: false };

  return { plan: "free", status: "free", inGrace: false };
}

/** Free, with no row — a connection created before billing existed, or one whose backfill hasn't run. */
function freeEntitlements(connectionId: string): Entitlements {
  return {
    connectionId,
    plan: "free",
    status: "free",
    trialEndsAt: null,
    trialDaysLeft: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    billingProvider: "manual",
    currency: "USD",
    billingCycle: "monthly",
    limits: { ...PLANS.free.limits },
    features: new Set<FeatureKey>(),
    inGrace: false,
    overrides: [],
  };
}

export async function entitlementsFor(connectionId: string, now = new Date()): Promise<Entitlements> {
  const [row, overrideRows] = await Promise.all([
    prisma.subscription.findUnique({ where: { connectionId } }),
    prisma.entitlement.findMany({ where: { connectionId } }),
  ]);

  const base = row ? effectivePlan(row, now) : { plan: "free" as PlanId, status: "free" as SubscriptionStatus, inGrace: false };
  const plan = PLANS[base.plan];

  const limits: PlanLimits = { ...plan.limits };
  const features = new Set<FeatureKey>(plan.features);
  const applied: Entitlements["overrides"] = [];

  for (const override of overrideRows) {
    // An expired grant is simply not in force. Left in the table rather
    // than deleted so the audit trail survives — /admin shows it as
    // lapsed.
    if (override.expiresAt && override.expiresAt.getTime() <= now.getTime()) continue;

    applied.push({
      key: override.key,
      value: override.value,
      reason: override.reason,
      expiresAt: override.expiresAt,
    });

    if (override.key.startsWith("limit.")) {
      const limitKey = override.key.slice("limit.".length) as LimitKey;
      if (limitKey in limits) limits[limitKey] = limitFromString(override.value);
      continue;
    }

    const featureKey = override.key as FeatureKey;
    if (override.value === "off") features.delete(featureKey);
    else features.add(featureKey);
  }

  const trialEndsAt = base.status === "trialing" ? (row?.trialEndsAt ?? null) : null;

  return {
    connectionId,
    plan: base.plan,
    status: base.status,
    trialEndsAt,
    trialDaysLeft: trialEndsAt ? Math.max(0, daysRemaining(now, trialEndsAt)) : null,
    currentPeriodEnd: row?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false,
    billingProvider: (row?.billingProvider as ProviderId) ?? "manual",
    currency: (row?.currency as Currency) ?? "USD",
    billingCycle: (row?.billingCycle as BillingCycle) ?? "monthly",
    limits,
    features,
    inGrace: base.inGrace,
  overrides: applied,
  };
}

/** Feature check. `can(id, "waitlist")` */
export async function can(connectionId: string, feature: FeatureKey): Promise<boolean> {
  const ent = await entitlementsFor(connectionId);
  return ent.features.has(feature);
}

export interface LimitCheck {
  allowed: boolean;
  used: number;
  cap: number;
  /** Already past the cap — a downgrade, not an attempted create. Drives the "over your plan limit" banner. */
  over: boolean;
  limit: LimitKey;
  plan: PlanId;
}

/**
 * `used` is counted by the caller (it is a different query per limit) and
 * passed in, so this stays a pure comparison and the same helper serves
 * both "can I create one more?" and "is this account currently over?".
 */
export function checkLimit(ent: Entitlements, limit: LimitKey, used: number): LimitCheck {
  const cap = ent.limits[limit];
  return {
    allowed: used < cap,
    used,
    cap,
    over: used > cap,
    limit,
    plan: ent.plan,
  };
}

export async function withinLimit(connectionId: string, limit: LimitKey, used: number): Promise<LimitCheck> {
  return checkLimit(await entitlementsFor(connectionId), limit, used);
}

/**
 * Tidies a trial that has already lapsed in fact. Correctness never
 * depends on this having run — `entitlementsFor()` resolves an expired
 * trial as Free whether or not the row says so — but leaving the row
 * saying "trialing" forever makes the admin console's trialing filter
 * useless and the lifecycle emails impossible to target.
 *
 * Conditional on the row still reading `trialing` with a past end date,
 * so two callers racing can't fight over it.
 */
export async function settleExpiredTrial(connectionId: string, now = new Date()): Promise<boolean> {
  const { count } = await prisma.subscription.updateMany({
    where: { connectionId, status: "trialing", trialEndsAt: { lte: now } },
    data: { status: "free", plan: "free" },
  });
  return count > 0;
}
