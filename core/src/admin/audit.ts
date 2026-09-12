/**
 * The audit log. Every platform-admin action goes through `record()`,
 * and it is written **in the same transaction as the change it
 * describes** — not after it, and not best-effort.
 *
 * That coupling is the whole point. Handing out free plans, comped
 * tiers and feature grants without an immutable record of who did what
 * and why is how a small team ends up, six months later, unable to
 * answer "why is this account free?" — and unable to tell a mistake from
 * a decision.
 *
 * `reason` is required at the schema level, not by convention. It costs
 * five seconds to type and it is the difference between an audit trail
 * and a pile of timestamps.
 */
import prisma from "../db.js";
import type { Prisma } from "@prisma/client";

type Db = Prisma.TransactionClient;

export type AdminAction =
  | "plan.change"
  | "trial.extend"
  | "entitlement.grant"
  | "entitlement.revoke"
  | "subscription.cancel"
  | "account.suspend"
  | "account.restore";

export interface AuditEntry {
  actorUserId: string;
  action: AdminAction;
  targetType: "connection" | "user";
  targetId: string;
  /** Snapshots, both optional — a grant has no `before`. Serialised here so call sites pass plain objects. */
  before?: unknown;
  after?: unknown;
  reason: string;
  ip?: string;
}

/** Keeps a snapshot small and free of anything that isn't ours to store. */
function snapshot(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value).slice(0, 4_000);
}

export function record(entry: AuditEntry, db: Db = prisma) {
  return db.adminAuditLog.create({
    data: {
      actorUserId: entry.actorUserId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      before: snapshot(entry.before),
      after: snapshot(entry.after),
      reason: entry.reason.trim(),
      ip: entry.ip ?? "",
    },
  });
}

export interface AuditQuery {
  actorUserId?: string;
  targetId?: string;
  limit?: number;
  cursor?: string;
}

export async function list(query: AuditQuery = {}) {
  const rows = await prisma.adminAuditLog.findMany({
    where: {
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      ...(query.targetId ? { targetId: query.targetId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(query.limit ?? 50, 200),
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const actorIds = [...new Set(rows.map((r) => r.actorUserId))];
  const actors = actorIds.length
    ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true } })
    : [];
  const emailById = new Map(actors.map((a) => [a.id, a.email]));

  return rows.map((row) => ({
    id: row.id,
    actorUserId: row.actorUserId,
    actorEmail: emailById.get(row.actorUserId) ?? row.actorUserId,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    before: row.before,
    after: row.after,
    reason: row.reason,
    createdAt: row.createdAt,
  }));
}
