/**
 * Every mutating admin action. Each one writes its audit row **in the
 * same transaction** as the change — see admin/audit.ts on why that
 * coupling isn't optional — and each one requires a `reason`.
 *
 * ## Prefer a plan override to a provider discount
 *
 * `setPlan()` never touches Razorpay. "Growth, free, until 31 Dec" for a
 * beta user, a design partner or a friend moves no money, carries no
 * payment risk, and works identically whatever rail the account is on.
 * It is the mechanism to reach for ~95% of the time. A real discount on
 * a real mandate is a different, riskier thing and deliberately isn't
 * here yet.
 */
import prisma from "../db.js";
import { GetBooqinError } from "../booking/errors.js";
import { record, type AdminAction } from "./audit.js";
import { setPlanManually, extendTrial } from "../billing/subscriptions.js";
import { FEATURE_KEYS, LIMIT_KEYS, isPlanId, limitFromString, type PlanId } from "../billing/plans.js";

export interface ActorContext {
  actorUserId: string;
  reason: string;
  ip?: string;
}

/** A blank reason is refused here, not just discouraged in the UI. */
function requireReason(ctx: ActorContext): string {
  const reason = ctx.reason?.trim() ?? "";
  if (reason.length < 3) {
    throw new GetBooqinError("getbooqin_reason_required", "Give a reason — it goes in the audit log.", 400);
  }
  return reason;
}

async function snapshotSubscription(connectionId: string) {
  const row = await prisma.subscription.findUnique({ where: { connectionId } });
  if (!row) return null;
  return {
    plan: row.plan, status: row.status, trialEndsAt: row.trialEndsAt,
    currentPeriodEnd: row.currentPeriodEnd, billingProvider: row.billingProvider,
  };
}

async function write(
  connectionId: string,
  ctx: ActorContext,
  action: AdminAction,
  before: unknown,
  apply: (db: Parameters<typeof record>[1]) => Promise<unknown>
) {
  const reason = requireReason(ctx);
  return prisma.$transaction(async (tx) => {
    const after = await apply(tx);
    await record(
      { actorUserId: ctx.actorUserId, action, targetType: "connection", targetId: connectionId, before, after, reason, ip: ctx.ip },
      tx
    );
    return after;
  });
}

/**
 * Comp an account, or enable the hidden tier for the first person who
 * asks for it. `until` is the honest way to do a time-boxed comp: the
 * plan simply stops at that date rather than needing anyone to remember.
 */
export async function setPlan(connectionId: string, plan: PlanId, ctx: ActorContext, until?: Date | null) {
  if (!isPlanId(plan)) throw new GetBooqinError("getbooqin_invalid_plan", `Unknown plan "${plan}".`, 400);
  const before = await snapshotSubscription(connectionId);
  return write(connectionId, ctx, "plan.change", before, async (tx) => {
    const row = await setPlanManually(connectionId, plan, { until }, tx);
    return { plan: row.plan, status: row.status, currentPeriodEnd: row.currentPeriodEnd };
  });
}

/** The single most-used support action in any early-stage SaaS. */
export async function extendTrialTo(connectionId: string, until: Date, ctx: ActorContext) {
  if (!(until instanceof Date) || Number.isNaN(until.getTime())) {
    throw new GetBooqinError("getbooqin_invalid_date", "Pick a valid date.", 400);
  }
  if (until.getTime() <= Date.now()) {
    // An "extension" into the past would silently expire the trial
    // instead — a date-picker slip shouldn't cut someone off.
    throw new GetBooqinError("getbooqin_invalid_date", "That date has already passed.", 400);
  }
  const before = await snapshotSubscription(connectionId);
  return write(connectionId, ctx, "trial.extend", before, async (tx) => {
    const row = await extendTrial(connectionId, until, tx);
    return { status: row.status, trialEndsAt: row.trialEndsAt };
  });
}

export function isEntitlementKey(key: string): boolean {
  if ((FEATURE_KEYS as readonly string[]).includes(key)) return true;
  if (!key.startsWith("limit.")) return false;
  return (LIMIT_KEYS as readonly string[]).includes(key.slice("limit.".length));
}

/**
 * *This is early access.* Ship a feature dark, grant it to five
 * accounts, watch, then move it into a plan — same mechanism, no
 * deploys. It is also what replaced the `ENABLE_*` env booleans Phase 1
 * deleted.
 */
export async function grantEntitlement(
  connectionId: string,
  args: { key: string; value: string; expiresAt?: Date | null },
  ctx: ActorContext
) {
  if (!isEntitlementKey(args.key)) {
    throw new GetBooqinError("getbooqin_invalid_entitlement", `"${args.key}" isn't a known feature or limit.`, 400);
  }
  const value = args.value.trim();
  if (args.key.startsWith("limit.")) {
    // limitFromString turns anything unparseable into 0, which would
    // silently cap an account at nothing. Catch it here instead.
    if (!/^(unlimited|\d+)$/i.test(value)) {
      throw new GetBooqinError("getbooqin_invalid_entitlement", 'A limit must be a whole number, or "unlimited".', 400);
    }
    void limitFromString(value);
  } else if (value !== "on" && value !== "off") {
    throw new GetBooqinError("getbooqin_invalid_entitlement", 'A feature grant is either "on" or "off".', 400);
  }

  const reason = requireReason(ctx);
  const before = await prisma.entitlement.findUnique({ where: { connectionId_key: { connectionId, key: args.key } } });

  return prisma.$transaction(async (tx) => {
    const row = await tx.entitlement.upsert({
      where: { connectionId_key: { connectionId, key: args.key } },
      create: {
        connectionId, key: args.key, value, reason,
        grantedByUserId: ctx.actorUserId, expiresAt: args.expiresAt ?? null,
      },
      update: { value, reason, grantedByUserId: ctx.actorUserId, expiresAt: args.expiresAt ?? null },
    });
    await record(
      {
        actorUserId: ctx.actorUserId, action: "entitlement.grant",
        targetType: "connection", targetId: connectionId,
        before: before ? { key: before.key, value: before.value, expiresAt: before.expiresAt } : null,
        after: { key: row.key, value: row.value, expiresAt: row.expiresAt },
        reason, ip: ctx.ip,
      },
      tx
    );
    return row;
  });
}

export async function revokeEntitlement(connectionId: string, key: string, ctx: ActorContext) {
  const reason = requireReason(ctx);
  const before = await prisma.entitlement.findUnique({ where: { connectionId_key: { connectionId, key } } });
  if (!before) throw new GetBooqinError("getbooqin_not_found", "That override isn't on this account.", 404);

  return prisma.$transaction(async (tx) => {
    await tx.entitlement.delete({ where: { connectionId_key: { connectionId, key } } });
    await record(
      {
        actorUserId: ctx.actorUserId, action: "entitlement.revoke",
        targetType: "connection", targetId: connectionId,
        before: { key: before.key, value: before.value, expiresAt: before.expiresAt },
        after: null, reason, ip: ctx.ip,
      },
      tx
    );
  });
}
