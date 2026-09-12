/**
 * What the admin console is allowed to see.
 *
 * **It never renders tenant booking data.** Accounts, plans, counts and
 * entitlements — not customer names, not booking details, not a clinic's
 * patient list. Every query in this file is written to make that
 * structural rather than a rule someone has to remember: nothing here
 * selects a Customer or a Booking row, only counts of them.
 *
 * If support genuinely needs to see a merchant's screen, that is a
 * separate, explicitly-consented, separately-audited impersonation
 * feature — deliberately out of scope. Building it casually into an
 * admin panel is a privacy incident waiting to happen, and doubly so
 * with clinic data in these tables.
 */
import prisma from "../db.js";
import { entitlementsFor } from "../billing/entitlements.js";
import { PLANS, type PlanId } from "../billing/plans.js";

export type AccountFilter = "all" | "trialing" | "paying" | "past_due" | "free" | "expiring";

export interface AccountSummary {
  connectionId: string;
  businessName: string;
  shop: string;
  platform: string;
  ownerEmail: string;
  plan: PlanId;
  planName: string;
  status: string;
  trialEndsAt: Date | null;
  trialDaysLeft: number | null;
  currentPeriodEnd: Date | null;
  currency: string;
  billingProvider: string;
  bookingsThisMonth: number;
  resourceCount: number;
  overrideCount: number;
  createdAt: Date;
}

function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * The business's own name, out of its settings blob. Read rather than
 * joined because settings are a JSON column; falling back to the shop id
 * matters for accounts that never completed onboarding, which are
 * exactly the ones an admin is most likely to be looking for.
 */
function businessNameFrom(raw: string | undefined, shop: string): string {
  if (!raw) return shop;
  try {
    const parsed = JSON.parse(raw) as { business_name?: string };
    const name = (parsed.business_name ?? "").trim();
    return name && name !== shop ? name : shop;
  } catch {
    return shop;
  }
}

export async function list(opts: { filter?: AccountFilter; search?: string; limit?: number } = {}): Promise<AccountSummary[]> {
  const now = new Date();
  const search = (opts.search ?? "").trim().toLowerCase();

  const connections = await prisma.connection.findMany({
    where: { status: "active" },
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.limit ?? 200, 500),
    select: {
      id: true, shop: true, platform: true, createdAt: true,
      user: { select: { email: true } },
      subscription: true,
      _count: { select: { entitlements: true } },
    },
  });

  const shops = connections.map((c) => c.shop);
  const [settingsRows, bookingCounts, resourceCounts] = await Promise.all([
    prisma.shopSettings.findMany({ where: { shop: { in: shops } }, select: { shop: true, platform: true, data: true } }),
    prisma.booking.groupBy({
      by: ["shop", "platform"],
      where: { shop: { in: shops }, source: "form", createdAt: { gte: monthStart(now) } },
      _count: { _all: true },
    }),
    prisma.resource.groupBy({
      by: ["shop", "platform"],
      where: { shop: { in: shops }, status: true },
      _count: { _all: true },
    }),
  ]);

  const key = (shop: string, platform: string) => `${platform}:${shop}`;
  const settingsBy = new Map(settingsRows.map((r) => [key(r.shop, r.platform), r.data]));
  const bookingsBy = new Map(bookingCounts.map((r) => [key(r.shop, r.platform), r._count._all]));
  const resourcesBy = new Map(resourceCounts.map((r) => [key(r.shop, r.platform), r._count._all]));

  const summaries: AccountSummary[] = connections.map((c) => {
    const sub = c.subscription;
    const plan = (sub?.plan ?? "free") as PlanId;
    const trialEndsAt = sub?.status === "trialing" ? sub.trialEndsAt : null;
    return {
      connectionId: c.id,
      businessName: businessNameFrom(settingsBy.get(key(c.shop, c.platform)), c.shop),
      shop: c.shop,
      platform: c.platform,
      ownerEmail: c.user.email,
      plan,
      planName: PLANS[plan]?.name ?? plan,
      status: sub?.status ?? "free",
      trialEndsAt,
      trialDaysLeft: trialEndsAt ? Math.max(0, Math.ceil((trialEndsAt.getTime() - now.getTime()) / 86_400_000)) : null,
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      currency: sub?.currency ?? "USD",
      billingProvider: sub?.billingProvider ?? "manual",
      bookingsThisMonth: bookingsBy.get(key(c.shop, c.platform)) ?? 0,
      resourceCount: resourcesBy.get(key(c.shop, c.platform)) ?? 0,
      overrideCount: c._count.entitlements,
      createdAt: c.createdAt,
    };
  });

  return summaries.filter((a) => {
    if (search && !`${a.businessName} ${a.ownerEmail} ${a.shop}`.toLowerCase().includes(search)) return false;
    switch (opts.filter) {
      case "trialing": return a.status === "trialing";
      case "paying": return a.status === "active" && a.billingProvider !== "manual";
      case "past_due": return a.status === "past_due";
      case "free": return a.status === "free" || a.plan === "free";
      // The filter that earns its keep: who is about to lose access, and
      // therefore who needs a decision this week.
      case "expiring": return a.status === "trialing" && (a.trialDaysLeft ?? 99) <= 7;
      default: return true;
    }
  });
}

export interface AccountDetail extends AccountSummary {
  entitlements: Awaited<ReturnType<typeof entitlementsFor>>;
  overrides: { id: string; key: string; value: string; reason: string; grantedByUserId: string; expiresAt: Date | null; createdAt: Date }[];
  teamMemberCount: number;
  serviceCount: number;
  recentBillingEvents: { id: string; type: string; provider: string; processedAt: Date | null; error: string | null; createdAt: Date }[];
}

export async function detail(connectionId: string): Promise<AccountDetail | null> {
  const [summary] = await list({ limit: 500 }).then((all) => all.filter((a) => a.connectionId === connectionId));
  if (!summary) return null;

  const [entitlements, overrides, teamMemberCount, serviceCount, recentBillingEvents] = await Promise.all([
    entitlementsFor(connectionId),
    prisma.entitlement.findMany({ where: { connectionId }, orderBy: { createdAt: "desc" } }),
    prisma.connectionMember.count({ where: { connectionId } }),
    prisma.serviceConfig.count({ where: { shop: summary.shop, platform: summary.platform, status: true } }),
    prisma.billingEvent.findMany({
      where: { connectionId },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, type: true, provider: true, processedAt: true, error: true, createdAt: true },
    }),
  ]);

  return {
    ...summary,
    entitlements,
    overrides: overrides.map((o) => ({
      id: o.id, key: o.key, value: o.value, reason: o.reason,
      grantedByUserId: o.grantedByUserId, expiresAt: o.expiresAt, createdAt: o.createdAt,
    })),
    teamMemberCount,
    serviceCount,
    recentBillingEvents,
  };
}
