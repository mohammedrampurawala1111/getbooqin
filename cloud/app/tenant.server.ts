import { data } from "react-router";
import { prisma, Team, type Role } from "getbooqin-core";
import { requireUserSession } from "~/session.server";

// Every screen under dashboard/:connectionId needs the same thing: prove the
// requesting user has at least `minRole` access to this connection, then
// derive the (shop, platform) pair core's booking-workflow functions are
// scoped by. Centralized here so each route's loader/action is a one-line
// call instead of repeating requireUserSession + a membership check + the
// 404 check.
//
// `minRole` defaults to "read" so every existing loader call site (which
// only ever needs "can this user see this connection at all") keeps
// working unchanged — read-role members should still see everything, per
// the role permission matrix (docs/team-management-spec.md §2). Mutating
// actions bump this explicitly at their own call site: "write" for the
// operational dashboard routes (bookings/services/resources/customers/
// timeoff/waitlist), "admin" for Settings (every section, including its
// own loader — Settings is business configuration/sensitive data, not
// merely "read" like an operational list).
//
// Ownership used to be a hard FK check (Connection.userId === userId, via
// the now-removed getUserConnection) — that's now just the "owner" row
// this feature's migration backfilled into ConnectionMember, so a single
// membership lookup covers owner/admin/write/read alike.
export async function requireTenant(request: Request, connectionId: string, minRole: Role = "read") {
  const session = await requireUserSession(request);
  const connection = await prisma.connection.findUnique({ where: { id: connectionId } });
  // A disconnected store (Settings › Integrations' "Disconnect") sets
  // status to "revoked" — treat it the same as not found, mirroring the
  // check core's verifySessionToken already does for the tenant-select
  // cookie, so the dashboard actually becomes unreachable.
  if (!connection || connection.status !== "active") {
    throw data("Store not found", { status: 404 });
  }
  const membership = await Team.getMembership(session.userId, connectionId);
  // Same "store not found" shape as the checks above, not a 403 — a
  // teammate who isn't (or is no longer) on this connection's team learns
  // nothing about whether the connection itself exists, same principle as
  // every other out-of-tenant access in this app.
  if (!membership || !Team.atLeast(membership.role, minRole)) {
    throw data("Store not found", { status: 404 });
  }
  return {
    userId: session.userId,
    connection,
    shop: connection.shop,
    platform: connection.platform,
    role: membership.role as Role,
  };
}
