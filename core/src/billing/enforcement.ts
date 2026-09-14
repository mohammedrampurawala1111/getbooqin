/**
 * Where plan limits actually bite. **Server-side, in core, never in the
 * UI** — a limit enforced only by a hidden button is not enforced, and
 * the storefront proxy and the Shopify admin reach the same functions
 * the cloud dashboard does.
 *
 * Every check is addressed by (shop, platform) because that is how every
 * tenant-scoped function in the booking engine is addressed; the bridge
 * to `connectionId` is `subscriptions.connectionIdForShop()`.
 *
 * ## Falls open, not closed
 *
 * A shop with no Connection row (Shopify's install handshake, a fixture
 * in a test) is not billable yet and is left alone. A limit check is a
 * commercial rule, not a security boundary — failing it shut would break
 * booking for reasons that have nothing to do with the merchant.
 */
import prisma from "../db.js";
import { GetBooqinError } from "../booking/errors.js";
import { entitlementsFor, checkLimit, type Entitlements, type LimitCheck } from "./entitlements.js";
import { connectionIdForShop } from "./subscriptions.js";
import { PLANS, PLAN_ORDER, planRank, FEATURE_LABELS, LIMIT_LABELS, type FeatureKey, type LimitKey } from "./plans.js";

/** 402 Payment Required — the whole point is that paying fixes it. */
const LIMIT_STATUS = 402;

function upgradeHint(limit: LimitKey, cap: number, current: string): string {
  // Name the cheapest plan that would actually clear this limit, rather
  // than "upgrade" in the abstract — a merchant shouldn't have to read a
  // comparison table to find out which button to press.
  const next = PLAN_ORDER.find(
    (id) => planRank(id) > planRank(current as never) && PLANS[id].limits[limit] > cap
  );
  return next ? ` ${PLANS[next].name} allows more.` : "";
}

export function limitError(check: LimitCheck): GetBooqinError {
  const label = LIMIT_LABELS[check.limit].toLowerCase();
  return new GetBooqinError(
    "getbooqin_plan_limit",
    `Your ${PLANS[check.plan].name} plan includes ${check.cap} ${label}.${upgradeHint(check.limit, check.cap, check.plan)}`,
    LIMIT_STATUS
  );
}

export function featureError(feature: FeatureKey, plan: string): GetBooqinError {
  const next = PLAN_ORDER.find(
    (id) => planRank(id) > planRank(plan as never) && PLANS[id].features.includes(feature)
  );
  return new GetBooqinError(
    "getbooqin_plan_feature",
    `${FEATURE_LABELS[feature]} isn't included in your plan.${next ? ` ${PLANS[next].name} includes it.` : ""}`,
    LIMIT_STATUS
  );
}

/**
 * Resolves entitlements for a shop, or null when the shop has no billable
 * connection yet. Every function below short-circuits on null.
 */
export async function entitlementsForShop(shop: string, platform: string): Promise<Entitlements | null> {
  const connectionId = await connectionIdForShop(shop, platform);
  return connectionId ? entitlementsFor(connectionId) : null;
}

export async function assertFeature(shop: string, platform: string, feature: FeatureKey): Promise<void> {
  const ent = await entitlementsForShop(shop, platform);
  if (!ent) return;
  if (!ent.features.has(feature)) throw featureError(feature, ent.plan);
}

/* ------------------------------------------------------------------ */
/* The counters — one per limit, each the cheapest query that answers   */
/* "how many does this account have right now?"                         */
/* ------------------------------------------------------------------ */

export function countResources(shop: string, platform: string): Promise<number> {
  // Active only. A deactivated practitioner isn't occupying a seat, and
  // counting one would make "deactivate then add a replacement"
  // impossible on a plan you're already at the edge of.
  return prisma.resource.count({ where: { shop, platform, status: true } });
}

export function countServices(shop: string, platform: string): Promise<number> {
  return prisma.serviceConfig.count({ where: { shop, platform, status: true } });
}

export function countTeamMembers(connectionId: string): Promise<number> {
  // Members plus outstanding invites — an invite is a seat that has been
  // spent. Otherwise a 2-seat account can invite ten people and only
  // discover the cap as each one accepts, which is a worse experience
  // for everybody including the people who get turned away.
  return Promise.all([
    prisma.connectionMember.count({ where: { connectionId } }),
    prisma.connectionInvite.count({ where: { connectionId, status: "pending" } }),
  ]).then(([members, invites]) => members + invites);
}

export function countBusinesses(userId: string): Promise<number> {
  return prisma.connection.count({ where: { userId, status: "active" } });
}

/**
 * Customer-made bookings in the calling month, in UTC.
 *
 * **Staff-entered bookings are never counted.** A merchant typing in a
 * walk-in is doing admin, not consuming a quota, and metering it would
 * push them back to paper for exactly the bookings the product is
 * supposed to absorb. `source` is "form" for the public page and the
 * storefront widget; anything a staff member creates carries its own
 * source.
 */
export function countBookingsThisMonth(shop: string, platform: string, now = new Date()): Promise<number> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return prisma.booking.count({
    where: {
      shop,
      platform,
      source: "form",
      createdAt: { gte: start, lt: end },
      // A cancelled or declined booking is not a booking the merchant
      // got the value of, and counting them made the quota a weapon: an
      // attacker could book a Free shop's fifty slots with throwaway
      // details, cancel every one, and every genuine customer for the
      // rest of the month is refused with a 402 — while the merchant's
      // calendar sits visibly empty and nothing explains why.
      status: { notIn: ["cancelled", "declined"] },
    },
  });
}

/* ------------------------------------------------------------------ */
/* The assertions call sites use                                        */
/* ------------------------------------------------------------------ */

async function assertLimit(
  shop: string,
  platform: string,
  limit: LimitKey,
  count: () => Promise<number>
): Promise<void> {
  const connectionId = await connectionIdForShop(shop, platform);
  if (!connectionId) return;

  const ent = await entitlementsFor(connectionId);
  // Unlimited is the common case on every paid tier — don't pay for a
  // COUNT(*) to discover it.
  if (!Number.isFinite(ent.limits[limit])) return;

  const check = checkLimit(ent, limit, await count());
  if (!check.allowed) throw limitError(check);
}

export function assertCanAddResource(shop: string, platform: string): Promise<void> {
  return assertLimit(shop, platform, "resources", () => countResources(shop, platform));
}

export function assertCanAddService(shop: string, platform: string): Promise<void> {
  return assertLimit(shop, platform, "services", () => countServices(shop, platform));
}

export async function assertCanInviteMember(connectionId: string): Promise<void> {
  const ent = await entitlementsFor(connectionId);
  if (!Number.isFinite(ent.limits.teamMembers)) return;
  const check = checkLimit(ent, "teamMembers", await countTeamMembers(connectionId));
  if (!check.allowed) throw limitError(check);
}

export async function assertCanAddBusiness(userId: string): Promise<void> {
  // Scoped to the *user's* existing connections, since "businesses" is
  // the one limit that isn't per-shop. Read off whichever connection
  // they already have — a user with none is creating their first, which
  // every plan allows.
  const connections = await prisma.connection.findMany({
    where: { userId, status: "active" },
    select: { id: true },
  });
  if (connections.length === 0) return;

  // The most generous plan across their accounts wins. A merchant paying
  // for Business on one account shouldn't be blocked by a Free one.
  const entitlements = await Promise.all(connections.map((c) => entitlementsFor(c.id)));
  const cap = Math.max(...entitlements.map((e) => e.limits.businesses));
  if (!Number.isFinite(cap) || connections.length < cap) return;

  const best = entitlements.reduce((a, b) => (planRank(a.plan) >= planRank(b.plan) ? a : b));
  throw limitError(checkLimit(best, "businesses", connections.length));
}

export async function assertCanTakeBooking(shop: string, platform: string, source: string): Promise<void> {
  // Staff-entered bookings are never metered — see countBookingsThisMonth.
  if (source !== "form") return;
  return assertLimit(shop, platform, "bookingsPerMonth", () => countBookingsThisMonth(shop, platform));
}

/**
 * Everything an "over your plan limit" banner needs after a downgrade.
 * Never blocks anything — a Growth account that drops to Starter keeps
 * all six resources; this is what tells the merchant so, instead of
 * their data quietly disappearing.
 */
export async function overLimits(shop: string, platform: string, userId?: string): Promise<LimitCheck[]> {
  const connectionId = await connectionIdForShop(shop, platform);
  if (!connectionId) return [];
  const ent = await entitlementsFor(connectionId);

  const checks = await Promise.all([
    countResources(shop, platform).then((n) => checkLimit(ent, "resources", n)),
    countServices(shop, platform).then((n) => checkLimit(ent, "services", n)),
    countTeamMembers(connectionId).then((n) => checkLimit(ent, "teamMembers", n)),
    userId
      ? countBusinesses(userId).then((n) => checkLimit(ent, "businesses", n))
      : Promise.resolve(null),
  ]);

  return checks.filter((c): c is LimitCheck => !!c && c.over);
}

/**
 * Everything the Billing screen needs to show "what you're using against
 * what you're allowed" in one round trip, rather than five.
 */
export interface UsageSnapshot {
  resources: number;
  services: number;
  teamMembers: number;
  bookingsPerMonth: number;
  businesses: number;
}

export async function usageSnapshot(
  shop: string,
  platform: string,
  connectionId: string,
  userId?: string
): Promise<UsageSnapshot> {
  const [resources, services, teamMembers, bookingsPerMonth, businesses] = await Promise.all([
    countResources(shop, platform),
    countServices(shop, platform),
    countTeamMembers(connectionId),
    countBookingsThisMonth(shop, platform),
    userId ? countBusinesses(userId) : Promise.resolve(1),
  ]);
  return { resources, services, teamMembers, bookingsPerMonth, businesses };
}

/**
 * Whether a *person* has a feature, across every business they own.
 *
 * Needed for the one gate that fires before a business exists:
 * connecting Shopify from the App Store, where there is no (shop,
 * platform) to resolve entitlements against yet.
 *
 * Unlike `entitlementsForShop`, this **falls closed** for a user with no
 * businesses at all. That inversion is deliberate and specific to this
 * case: "no account yet" must not be a way around a feature that is
 * switched off for everyone, and the alternative — letting a brand-new
 * Shopify install through while every existing merchant is blocked — is
 * exactly backwards.
 */
export async function userHasFeature(userId: string, feature: FeatureKey): Promise<boolean> {
  const connections = await prisma.connection.findMany({
    where: { userId, status: "active" },
    select: { id: true },
  });
  if (connections.length === 0) return false;

  const all = await Promise.all(connections.map((c) => entitlementsFor(c.id)));
  return all.some((e) => e.features.has(feature));
}
