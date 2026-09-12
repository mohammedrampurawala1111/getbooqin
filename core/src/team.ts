/**
 * Multi-user team management for a Connection (a business). A Connection's
 * `userId` remains the implicit "owner" (see the schema comment on
 * Connection) — this module is what everything else (role checks, the
 * roster, invites) actually reads and writes. Follows the
 * ./connections.ts module pattern: plain async functions keyed by
 * (connectionId, ...), string-typed role/status fields (never a Prisma
 * enum, matching this schema's existing convention).
 *
 * See docs/team-management-spec.md (role permission matrix, edge cases) and
 * docs/team-ui-spec.md (the screens this backs) for the product spec this
 * implements.
 */
import type { ConnectionMember, ConnectionInvite } from "@prisma/client";
import { assertCanInviteMember } from "./billing/enforcement.js";
import prisma from "./db.js";
import { signPayload } from "./auth/session.js";
import { isEmail } from "./booking/bookingsShared.js";
import * as Mailer from "./booking/mailer.js";
import { GetBooqinError } from "./booking/errors.js";

/* --------------------------------------------------------------- Roles */

export const ROLE_RANK = { read: 0, write: 1, admin: 2, owner: 3 } as const;
export type Role = keyof typeof ROLE_RANK;

// The three roles an admin/owner can actually assign — "owner" is implicit
// (Connection.userId, backfilled into ConnectionMember by this feature's
// migration) and never assignable through invites or role changes.
export type InvitableRole = "admin" | "write" | "read";
const INVITABLE_ROLES = new Set<InvitableRole>(["admin", "write", "read"]);

function isInvitableRole(value: string): value is InvitableRole {
  return INVITABLE_ROLES.has(value as InvitableRole);
}

/** Is `role` at least as privileged as `min`? Unrecognized role strings rank below everything. */
export function atLeast(role: string, min: Role): boolean {
  const roleRank = Object.prototype.hasOwnProperty.call(ROLE_RANK, role) ? ROLE_RANK[role as Role] : -1;
  return roleRank >= ROLE_RANK[min];
}

/** Every place an invite email is written or compared normalizes through here (trim + lower-case) — see the invite dedup/uniqueness constraint and the accept-flow's email-match check, which both rely on this being applied consistently. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/* ------------------------------------------------------------ Membership */

export async function getMembership(userId: string, connectionId: string): Promise<ConnectionMember | null> {
  return prisma.connectionMember.findUnique({ where: { connectionId_userId: { connectionId, userId } } });
}

export interface MemberSummary {
  userId: string;
  email: string;
  role: Role;
  invitedByUserId: string | null;
  createdAt: Date;
}

// core's User model has no name field (identity/profile lives in Clerk) —
// callers that need a display name/initials (the Team settings page) look
// the userId up against Clerk themselves, the same way
// dashboard.$connectionId.tsx's own sidebar already resolves the signed-in
// user's name. This only returns what our own DB actually holds.
export async function listMembers(connectionId: string): Promise<MemberSummary[]> {
  const members = await prisma.connectionMember.findMany({
    where: { connectionId },
    include: { user: { select: { email: true } } },
  });
  return members
    .map((m) => ({
      userId: m.userId,
      email: m.user.email,
      role: m.role as Role,
      invitedByUserId: m.invitedByUserId,
      createdAt: m.createdAt,
    }))
    .sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role] || a.createdAt.getTime() - b.createdAt.getTime());
}

export interface PendingInviteSummary {
  id: string;
  email: string;
  role: InvitableRole;
  invitedByUserId: string;
  createdAt: Date;
  expiresAt: Date;
}

export async function listPendingInvites(connectionId: string): Promise<PendingInviteSummary[]> {
  const invites = await prisma.connectionInvite.findMany({
    where: { connectionId, status: "pending" },
    orderBy: { createdAt: "desc" },
  });
  return invites.map((i) => ({
    id: i.id,
    email: i.email,
    role: i.role as InvitableRole,
    invitedByUserId: i.invitedByUserId,
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
  }));
}

/* ---------------------------------------------------------------- Invites */

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Not tied to the invite row's own id — for a brand-new invite (inviteMember's
// upsert `create` branch) that id doesn't exist yet at the point this needs
// to be computed. A connectionId+email pairing plus signPayload's own
// timestamp+HMAC is already unguessable enough, and decoupling it this way
// means inviteMember can write the *real* token/expiresAt in the very same
// call that creates or refreshes the row, instead of a placeholder-then-fix
// two-step (QA finding: that two-step left a permanently broken invite row
// behind — garbage token, already-expired expiresAt — if the process died
// between the two awaits).
function generateInviteToken(connectionId: string, email: string): string {
  return signPayload({ connectionId, email }, INVITE_TTL_MS);
}

// Best-effort send, always called *after* the invite row is already
// persisted with its real token — a throw here only ever affects the
// returned `emailSent` flag (decision: invite creation/refresh must not
// fail just because the email couldn't be sent; Resend is the recovery
// path for exactly this).
async function trySendInvite(invite: ConnectionInvite): Promise<boolean> {
  try {
    const connection = await prisma.connection.findUniqueOrThrow({ where: { id: invite.connectionId } });
    const inviter = await prisma.user.findUnique({ where: { id: invite.invitedByUserId } });
    await Mailer.sendTeamInvite(connection, invite, inviter?.email ?? "");
    return true;
  } catch (error) {
    console.error(`[team] failed to send invite email to ${invite.email} (connection ${invite.connectionId}):`, error);
    return false;
  }
}

export async function inviteMember({
  connectionId,
  email,
  role,
  invitedByUserId,
}: {
  connectionId: string;
  email: string;
  role: string;
  invitedByUserId: string;
}): Promise<{ invite: ConnectionInvite; emailSent: boolean; alreadyPending: boolean }> {
  if (!isInvitableRole(role)) {
    throw new GetBooqinError("getbooqin_invalid_role", "Role must be one of Admin, Write, or Read.", 400);
  }
  const normalizedEmail = normalizeEmail(email);
  if (!isEmail(normalizedEmail)) {
    throw new GetBooqinError("getbooqin_invalid_email", "Enter a valid email address.", 400);
  }

  // Plan limit. Counts outstanding invites as well as accepted members —
  // an invite is a seat already spent, and letting a 2-seat account
  // invite ten people only to turn nine of them away at accept time is a
  // worse experience for everyone involved.
  await assertCanInviteMember(connectionId);

  // Case-insensitive: Clerk-side emails aren't guaranteed to already be
  // lower-cased, so an exact-match lookup against a hand-typed invite email
  // could miss a real account (see the orchestrator's normalization
  // decision — this is the "every comparison" half of it).
  const existingUser = await prisma.user.findFirst({ where: { email: { equals: normalizedEmail, mode: "insensitive" } } });
  if (existingUser) {
    const existingMembership = await prisma.connectionMember.findUnique({
      where: { connectionId_userId: { connectionId, userId: existingUser.id } },
    });
    if (existingMembership) {
      throw new GetBooqinError(
        "getbooqin_already_member",
        `${existingUser.email} is already on the team — change their role in the list above instead of sending a new invite.`,
        400
      );
    }
  }

  // Was there already a pending invite for this email? Determines whether
  // the caller should say "invite sent" or "invite re-sent" (BA edge case
  // 3.1) — checked before the upsert below, which would otherwise erase
  // this distinction.
  const priorInvite = await prisma.connectionInvite.findUnique({ where: { connectionId_email: { connectionId, email: normalizedEmail } } });
  const alreadyPending = priorInvite?.status === "pending";

  // Real token/expiresAt computed up front so this upsert is a single
  // atomic write — see generateInviteToken's comment above for why this
  // replaced the old placeholder-then-rotate two-step.
  const token = generateInviteToken(connectionId, normalizedEmail);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  // Upsert-by-email backed by the @@unique([connectionId, email])
  // constraint — a second invite() call for the same email refreshes the
  // existing row in place rather than creating a duplicate (BA edge case
  // 3.1).
  const invite = await prisma.connectionInvite.upsert({
    where: { connectionId_email: { connectionId, email: normalizedEmail } },
    create: { connectionId, email: normalizedEmail, role, invitedByUserId, token, expiresAt },
    // Re-opens a previously revoked/expired/accepted row back to "pending"
    // — re-inviting the same email always means "I want them to be able to
    // join again," regardless of what became of the last invite.
    update: { role, invitedByUserId, token, expiresAt, status: "pending", acceptedAt: null },
  });

  const emailSent = await trySendInvite(invite);
  return { invite, emailSent, alreadyPending };
}

export async function resendInvite({
  connectionId,
  inviteId,
}: {
  connectionId: string;
  inviteId: string;
  actingUserId: string;
}): Promise<{ invite: ConnectionInvite; emailSent: boolean }> {
  const invite = await prisma.connectionInvite.findUnique({ where: { id: inviteId } });
  if (!invite || invite.connectionId !== connectionId) {
    throw new GetBooqinError("getbooqin_invite_not_found", "That invite could not be found.", 404);
  }
  // Resending only makes sense for an invite that hasn't already been
  // used — resurrecting an accepted invite back to "pending" would
  // silently relabel a real, already-granted membership as still-pending
  // and email the person a redundant/confusing "join" link. Not reachable
  // from the Team page's own UI today (Pending Invites only ever lists
  // status: "pending" rows), but a direct request from an already-admin
  // actor could still hit this, so it's guarded here rather than trusted
  // to the caller.
  if (invite.status === "accepted") {
    throw new GetBooqinError("getbooqin_invite_already_accepted", "This invite has already been accepted.", 409);
  }

  const token = generateInviteToken(connectionId, invite.email);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const updated = await prisma.connectionInvite.update({
    where: { id: invite.id },
    data: { token, expiresAt, status: "pending", acceptedAt: null },
  });

  const emailSent = await trySendInvite(updated);
  return { invite: updated, emailSent };
}

export async function revokeInvite({
  connectionId,
  inviteId,
}: {
  connectionId: string;
  inviteId: string;
  actingUserId: string;
}): Promise<void> {
  const invite = await prisma.connectionInvite.findUnique({ where: { id: inviteId } });
  if (!invite || invite.connectionId !== connectionId) {
    throw new GetBooqinError("getbooqin_invite_not_found", "That invite could not be found.", 404);
  }
  // Same reasoning as resendInvite's guard above: an already-accepted
  // invite is a completed transaction (the real access grant is the
  // separate ConnectionMember row, untouched either way) — flipping its
  // status to "revoked" would only falsify the audit trail, not undo
  // anything real.
  if (invite.status === "accepted") {
    throw new GetBooqinError("getbooqin_invite_already_accepted", "This invite has already been accepted and can't be revoked.", 409);
  }
  if (invite.status === "revoked") return; // already revoked — idempotent
  await prisma.connectionInvite.update({ where: { id: inviteId }, data: { status: "revoked" } });
}

/** Raw DB lookup for the /invite/:token loader — needs to resolve and display an invite's state (including terminal ones) regardless of whether anyone is signed in yet, which acceptInvite() (below) alone can't do since it mutates on success. */
export async function getInviteByToken(token: string) {
  return prisma.connectionInvite.findUnique({ where: { token }, include: { connection: true } });
}

/**
 * The most recent invite still actually joinable for this email, across
 * every business — checked once, right after signup and before any
 * Connection gets created (onboarding.tsx's loader), so an invited
 * teammate is routed to accept it instead of being funneled into creating
 * their own business (QA report's BUG-1: /signup has no concept of
 * invites and forces a new one regardless). A user can hold pending
 * invites to several businesses at once (this module's own per-business
 * dedup, not a global unique-email constraint — see inviteMember) — this
 * just surfaces the most recently sent one; someone holding more than one
 * still needs each business's own emailed link for the rest, same as
 * today.
 */
export async function findPendingInviteForEmail(email: string): Promise<ConnectionInvite | null> {
  const normalizedEmail = normalizeEmail(email);
  const invites = await prisma.connectionInvite.findMany({
    where: { email: normalizedEmail, status: "pending" },
    orderBy: { createdAt: "desc" },
  });
  // status: "pending" alone doesn't rule out expiry — inviteState() is the
  // one place that already knows expiresAt has to be checked against real
  // time too (see its own comment on BA edge case 3.6).
  return invites.find((invite) => inviteState(invite) === "pending") ?? null;
}

export type InviteState = "pending" | "expired" | "revoked" | "accepted";

/** Classifies a resolved invite row into the /invite/:token screen states (docs/team-ui-spec.md §2.4) — expiry is judged against the DB row's own expiresAt, never the signed token's baked-in TTL (BA edge case 3.6). */
export function inviteState(invite: Pick<ConnectionInvite, "status" | "expiresAt">): InviteState {
  if (invite.status === "revoked") return "revoked";
  if (invite.status === "accepted") return "accepted";
  if (invite.status !== "pending" || invite.expiresAt.getTime() < Date.now()) return "expired";
  return "pending";
}

/**
 * Looks the invite up by the *presented token string itself*
 * (ConnectionInvite.findUnique on `token`), not by decoding/re-verifying
 * the signed payload — this is what makes a resend's token rotation
 * actually invalidate the old emailed link (see rotateAndSend above): once
 * `token` is overwritten, the old string simply doesn't match any row.
 * Callers are expected to have already confirmed (via getInviteByToken +
 * inviteState) that this invite is actually acceptable, and — per BA edge
 * case 3.5 — that the authenticated userId's own email matches the invite;
 * that check lives in the route loader, which is the only place that knows
 * "signed in as the wrong person" needs a distinct screen rather than a
 * thrown error.
 */
export async function acceptInvite({ token, userId }: { token: string; userId: string }): Promise<ConnectionMember> {
  const invite = await prisma.connectionInvite.findUnique({ where: { token } });
  if (!invite) {
    throw new GetBooqinError("getbooqin_invite_invalid", "This invite link isn't valid.", 404);
  }
  const state = inviteState(invite);
  if (state === "revoked") {
    throw new GetBooqinError("getbooqin_invite_revoked", "This invite is no longer valid.", 410);
  }
  if (state === "accepted") {
    throw new GetBooqinError("getbooqin_invite_already_accepted", "This invite has already been used.", 410);
  }
  if (state === "expired") {
    throw new GetBooqinError("getbooqin_invite_expired", "This invite has expired.", 410);
  }

  const member = await prisma.connectionMember.upsert({
    where: { connectionId_userId: { connectionId: invite.connectionId, userId } },
    create: { connectionId: invite.connectionId, userId, role: invite.role, invitedByUserId: invite.invitedByUserId },
    update: { role: invite.role, invitedByUserId: invite.invitedByUserId },
  });

  await prisma.connectionInvite.update({ where: { id: invite.id }, data: { status: "accepted", acceptedAt: new Date() } });

  return member;
}

/* --------------------------------------------------------- Manage members */

export async function updateMemberRole({
  connectionId,
  targetUserId,
  role,
}: {
  connectionId: string;
  targetUserId: string;
  role: string;
  actingUserId: string;
}): Promise<ConnectionMember> {
  if (!isInvitableRole(role)) {
    throw new GetBooqinError("getbooqin_invalid_role", "Role must be one of Admin, Write, or Read.", 400);
  }
  const target = await prisma.connectionMember.findUnique({ where: { connectionId_userId: { connectionId, userId: targetUserId } } });
  if (!target) {
    throw new GetBooqinError("getbooqin_member_not_found", "That member could not be found.", 404);
  }
  // The rule is "never touch the owner row," full stop — not "unless
  // they're the last one" (BA edge case 3.4). No UI control ever submits
  // this for the owner row, but the reject here is the real guarantee.
  if (target.role === "owner") {
    throw new GetBooqinError("getbooqin_cannot_modify_owner", "The owner's role can't be changed.", 403);
  }
  return prisma.connectionMember.update({ where: { id: target.id }, data: { role } });
}

export async function removeMember({
  connectionId,
  targetUserId,
}: {
  connectionId: string;
  targetUserId: string;
  actingUserId: string;
}): Promise<void> {
  const target = await prisma.connectionMember.findUnique({ where: { connectionId_userId: { connectionId, userId: targetUserId } } });
  if (!target) return; // already gone — removal is idempotent
  if (target.role === "owner") {
    throw new GetBooqinError("getbooqin_cannot_modify_owner", "The owner can't be removed.", 403);
  }
  await prisma.connectionMember.delete({ where: { id: target.id } });
}
