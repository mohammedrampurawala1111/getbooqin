/**
 * QA regression coverage for core/src/team.ts, tracing the BA's
 * given/when/then edge cases (docs/team-management-spec.md §3) against the
 * real implementation on a live Postgres DB (same convention as
 * src/booking/__tests__ — no Prisma mocking, unique per-test identifiers,
 * cleanup in afterAll). Written by QA, not the implementing engineer —
 * see docs/team-management-spec.md / docs/team-ui-spec.md for the spec
 * these assert against.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import prisma from "../db.js";
import * as Team from "../team.js";
import * as Mailer from "../booking/mailer.js";
import { setPlanManually } from "../billing/subscriptions.js";
import { isGetBooqinError } from "../booking/errors.js";

const RUN = Date.now();
const shop = `team-test-${RUN}.myshopify.com`;
const platform = "shopify";

const ownerEmail = `owner-${RUN}@example.com`;
const memberEmail = `existing-member-${RUN}@example.com`;

let connectionId: string;
let ownerUserId: string;
let existingMemberUserId: string;

async function createUser(email: string): Promise<string> {
  const user = await prisma.user.create({ data: { id: `usr-${RUN}-${Math.random().toString(36).slice(2)}`, email } });
  return user.id;
}

describe("Team", () => {
  afterAll(async () => {
    await prisma.connectionInvite.deleteMany({ where: { connectionId } });
    await prisma.connectionMember.deleteMany({ where: { connectionId } });
    await prisma.connection.deleteMany({ where: { id: connectionId } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerUserId, existingMemberUserId].filter(Boolean) } } });
  });

  it("sets up an owner + connection + an existing non-owner member fixture", async () => {
    ownerUserId = await createUser(ownerEmail);
    existingMemberUserId = await createUser(memberEmail);
    const connection = await prisma.connection.create({
      data: { userId: ownerUserId, platform, shop, credentials: "", status: "active" },
    });
    connectionId = connection.id;
    // Team seats are a plan limit now (§W7) — a connection with no
    // subscription resolves to Free, which allows the owner and nobody
    // else. Every fixture here is about inviting people, so the fixture
    // account has to be one that can: Business, which is unlimited.
    await setPlanManually(connectionId, "business");
    await prisma.connectionMember.create({ data: { connectionId, userId: ownerUserId, role: "owner" } });
    await prisma.connectionMember.create({ data: { connectionId, userId: existingMemberUserId, role: "write" } });
    expect(connectionId).toBeTruthy();
  });

  describe("inviteMember — email normalization and validation", () => {
    it("normalizes (trim + lower-case) the stored invite email", async () => {
      const { invite } = await Team.inviteMember({
        connectionId,
        email: `  Mixed.Case-${RUN}@Example.COM  `,
        role: "write",
        invitedByUserId: ownerUserId,
      });
      expect(invite.email).toBe(`mixed.case-${RUN}@example.com`);
    });

    it("rejects role 'owner' as not invitable", async () => {
      await expect(
        Team.inviteMember({ connectionId, email: `owner-attempt-${RUN}@example.com`, role: "owner", invitedByUserId: ownerUserId })
      ).rejects.toMatchObject({ code: "getbooqin_invalid_role" });
    });

    it("rejects an invalid email address", async () => {
      await expect(
        Team.inviteMember({ connectionId, email: "not-an-email", role: "write", invitedByUserId: ownerUserId })
      ).rejects.toMatchObject({ code: "getbooqin_invalid_email" });
    });

    // BA edge case 3.2 — inviting an email that's already an active member.
    it("rejects inviting an email that's already an active member (edge case 3.2)", async () => {
      await expect(
        Team.inviteMember({ connectionId, email: memberEmail, role: "admin", invitedByUserId: ownerUserId })
      ).rejects.toMatchObject({ code: "getbooqin_already_member" });
    });

    // core/src/team.ts §4.4 / decision 3 — the "already a member" check must
    // be case-insensitive, since Clerk emails aren't guaranteed lower-case
    // and the admin free-types the invite email.
    it("rejects the already-a-member case even with different casing/whitespace on the invite (normalization, decision 3)", async () => {
      const upperVariant = `  ${memberEmail.toUpperCase()}  `;
      await expect(
        Team.inviteMember({ connectionId, email: upperVariant, role: "admin", invitedByUserId: ownerUserId })
      ).rejects.toMatchObject({ code: "getbooqin_already_member" });
    });

    it("does NOT reject a member email that only matches on a different connection", async () => {
      // memberEmail is a member of `connectionId` — a second, unrelated
      // connection inviting the same email must not see it as "already a
      // member" of *that* connection.
      const otherConn = await prisma.connection.create({
        data: { userId: ownerUserId, platform, shop: `${shop}-other`, credentials: "", status: "active" },
      });
      await setPlanManually(otherConn.id, "business");
      try {
        await prisma.connectionMember.create({ data: { connectionId: otherConn.id, userId: ownerUserId, role: "owner" } });
        const { invite } = await Team.inviteMember({
          connectionId: otherConn.id,
          email: memberEmail,
          role: "read",
          invitedByUserId: ownerUserId,
        });
        expect(invite.status).toBe("pending");
      } finally {
        await prisma.connectionInvite.deleteMany({ where: { connectionId: otherConn.id } });
        await prisma.connectionMember.deleteMany({ where: { connectionId: otherConn.id } });
        await prisma.connection.delete({ where: { id: otherConn.id } });
      }
    });
  });

  describe("inviteMember — re-inviting a still-pending email (edge case 3.1) and resend token rotation (decision 1)", () => {
    const email = `resend-${RUN}@example.com`;

    it("refreshes the same ConnectionInvite row in place rather than creating a duplicate, and reports alreadyPending", async () => {
      const first = await Team.inviteMember({ connectionId, email, role: "write", invitedByUserId: ownerUserId });
      expect(first.alreadyPending).toBe(false);

      const rowsAfterFirst = await prisma.connectionInvite.findMany({ where: { connectionId, email } });
      expect(rowsAfterFirst).toHaveLength(1);

      const second = await Team.inviteMember({ connectionId, email, role: "admin", invitedByUserId: ownerUserId });
      expect(second.alreadyPending).toBe(true);
      expect(second.invite.id).toBe(first.invite.id); // same row, not a new one
      expect(second.invite.role).toBe("admin"); // role updates to whatever was just submitted
      expect(second.invite.token).not.toBe(first.invite.token); // token rotated

      const rowsAfterSecond = await prisma.connectionInvite.findMany({ where: { connectionId, email } });
      expect(rowsAfterSecond).toHaveLength(1); // still exactly one row for this email
    });

    it("THE OLD TOKEN NO LONGER RESOLVES after a resend — acceptInvite must look up by the DB token column, not just decode a still-valid signature (decision 1 / BA §4.1)", async () => {
      const before = await Team.inviteMember({ connectionId, email, role: "write", invitedByUserId: ownerUserId });
      const staleToken = before.invite.token;

      const resendResult = await Team.resendInvite({ connectionId, inviteId: before.invite.id, actingUserId: ownerUserId });
      const freshToken = resendResult.invite.token;
      expect(freshToken).not.toBe(staleToken);

      // The stale, previously-emailed link's token must not resolve to any
      // row at all once it's been superseded.
      expect(await Team.getInviteByToken(staleToken)).toBeNull();
      expect(await Team.getInviteByToken(freshToken)).not.toBeNull();

      // acceptInvite() on the stale token must be rejected outright (not
      // silently accepted using the still-live DB row via signature decode).
      const acceptor = await createUser(`resend-acceptor-${RUN}@example.com`);
      try {
        await expect(Team.acceptInvite({ token: staleToken, userId: acceptor })).rejects.toMatchObject({
          code: "getbooqin_invite_invalid",
        });
        // The fresh token, in contrast, must still work.
        const member = await Team.acceptInvite({ token: freshToken, userId: acceptor });
        expect(member.role).toBe("write");
      } finally {
        await prisma.connectionMember.deleteMany({ where: { connectionId, userId: acceptor } });
        await prisma.user.delete({ where: { id: acceptor } });
      }
    });
  });

  describe("inviteMember — email delivery failure must not fail the whole operation (decision 4 / BA §4.5)", () => {
    it("still creates/rotates the invite row and reports emailSent:false when Mailer.sendTeamInvite throws", async () => {
      const email = `mail-fail-${RUN}@example.com`;
      const spy = vi.spyOn(Mailer, "sendTeamInvite").mockRejectedValueOnce(new Error("SMTP exploded"));
      try {
        const result = await Team.inviteMember({ connectionId, email, role: "write", invitedByUserId: ownerUserId });
        expect(result.emailSent).toBe(false);
        expect(result.invite.status).toBe("pending");

        const row = await prisma.connectionInvite.findUnique({ where: { connectionId_email: { connectionId, email } } });
        expect(row).not.toBeNull();
        expect(row!.status).toBe("pending");
        expect(row!.token).toBe(result.invite.token);
      } finally {
        spy.mockRestore();
      }

      // The row must still be resendable — Resend is the documented
      // recovery path for a failed send, so the row must not have been
      // rolled back. (Not asserting emailSent here: this workspace's core
      // package has no APP_URL in its own .env — only cloud's does, shared
      // at runtime via the combined process — so Mailer.sendTeamInvite()
      // itself throws "APP_URL is not set" in this isolated `core` test
      // run regardless of mocking. That's an environment/test-harness gap,
      // not a team.ts bug: the row-persists-and-is-resendable guarantee is
      // what's under test, and it holds either way.)
      const resend = await Team.resendInvite({
        connectionId,
        inviteId: (await prisma.connectionInvite.findUniqueOrThrow({ where: { connectionId_email: { connectionId, email } } })).id,
        actingUserId: ownerUserId,
      });
      expect(resend.invite.status).toBe("pending");
      expect(typeof resend.emailSent).toBe("boolean");
    });
  });

  describe("acceptInvite — status/expiry gating (edge cases 3.3 and 3.6)", () => {
    it("rejects acceptance of a revoked invite even though the signed token is still within its own TTL (edge case 3.3)", async () => {
      const email = `revoked-${RUN}@example.com`;
      const { invite } = await Team.inviteMember({ connectionId, email, role: "write", invitedByUserId: ownerUserId });
      await Team.revokeInvite({ connectionId, inviteId: invite.id, actingUserId: ownerUserId });

      const acceptor = await createUser(`revoked-acceptor-${RUN}@example.com`);
      try {
        await expect(Team.acceptInvite({ token: invite.token, userId: acceptor })).rejects.toMatchObject({
          code: "getbooqin_invite_revoked",
        });
        expect(await prisma.connectionMember.findUnique({ where: { connectionId_userId: { connectionId, userId: acceptor } } })).toBeNull();
      } finally {
        await prisma.user.delete({ where: { id: acceptor } });
      }
    });

    it("rejects acceptance of an invite whose DB expiresAt has passed, even though the signed token itself would still verify (edge case 3.6)", async () => {
      const email = `expired-${RUN}@example.com`;
      const { invite } = await Team.inviteMember({ connectionId, email, role: "write", invitedByUserId: ownerUserId });
      // Force the DB row's own expiresAt into the past without touching the
      // token string — this is exactly BA edge case 3.6's scenario: the
      // signed token's own baked-in TTL (7 days from signPayload) is still
      // valid, only the DB column has passed.
      await prisma.connectionInvite.update({ where: { id: invite.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

      const acceptor = await createUser(`expired-acceptor-${RUN}@example.com`);
      try {
        await expect(Team.acceptInvite({ token: invite.token, userId: acceptor })).rejects.toMatchObject({
          code: "getbooqin_invite_expired",
        });
        expect(await prisma.connectionMember.findUnique({ where: { connectionId_userId: { connectionId, userId: acceptor } } })).toBeNull();
        // status must not have been silently flipped to "accepted" by the
        // out-of-window request.
        const row = await prisma.connectionInvite.findUniqueOrThrow({ where: { id: invite.id } });
        expect(row.status).toBe("pending");
      } finally {
        await prisma.user.delete({ where: { id: acceptor } });
      }
    });

    it("accepts a valid pending invite, creates the membership with the invite's role, and marks it accepted", async () => {
      const email = `accept-ok-${RUN}@example.com`;
      const { invite } = await Team.inviteMember({ connectionId, email, role: "admin", invitedByUserId: ownerUserId });
      const acceptor = await createUser(email);
      let secondAcceptor: string | undefined;
      try {
        const member = await Team.acceptInvite({ token: invite.token, userId: acceptor });
        expect(member.role).toBe("admin");

        const row = await prisma.connectionInvite.findUniqueOrThrow({ where: { id: invite.id } });
        expect(row.status).toBe("accepted");
        expect(row.acceptedAt).not.toBeNull();

        // A second acceptance attempt (e.g. the link opened again) must not
        // silently re-accept.
        secondAcceptor = await createUser(`accept-ok-second-${RUN}@example.com`);
        await expect(Team.acceptInvite({ token: invite.token, userId: secondAcceptor })).rejects.toMatchObject({
          code: "getbooqin_invite_already_accepted",
        });
      } finally {
        await prisma.connectionMember.deleteMany({ where: { connectionId, userId: acceptor } });
        await prisma.user.delete({ where: { id: acceptor } });
        if (secondAcceptor) await prisma.user.delete({ where: { id: secondAcceptor } });
      }
    });
  });

  describe("findPendingInviteForEmail — onboarding.tsx's join-instead-of-create-a-business check (QA report BUG-1)", () => {
    it("returns null when the email holds no invite at all", async () => {
      expect(await Team.findPendingInviteForEmail(`no-invite-${RUN}@example.com`)).toBeNull();
    });

    it("finds a pending invite, matching case-insensitively/untrimmed the same way inviteMember stores it", async () => {
      const email = `find-pending-${RUN}@example.com`;
      const { invite } = await Team.inviteMember({ connectionId, email, role: "write", invitedByUserId: ownerUserId });

      const found = await Team.findPendingInviteForEmail(`  ${email.toUpperCase()}  `);
      expect(found?.id).toBe(invite.id);
    });

    it("ignores a revoked or already-accepted invite for that email", async () => {
      const revokedEmail = `find-revoked-${RUN}@example.com`;
      const revoked = await Team.inviteMember({ connectionId, email: revokedEmail, role: "write", invitedByUserId: ownerUserId });
      await Team.revokeInvite({ connectionId, inviteId: revoked.invite.id, actingUserId: ownerUserId });
      expect(await Team.findPendingInviteForEmail(revokedEmail)).toBeNull();

      const acceptedEmail = `find-accepted-${RUN}@example.com`;
      const accepted = await Team.inviteMember({ connectionId, email: acceptedEmail, role: "write", invitedByUserId: ownerUserId });
      const acceptor = await createUser(acceptedEmail);
      try {
        await Team.acceptInvite({ token: accepted.invite.token, userId: acceptor });
        expect(await Team.findPendingInviteForEmail(acceptedEmail)).toBeNull();
      } finally {
        await prisma.connectionMember.deleteMany({ where: { connectionId, userId: acceptor } });
        await prisma.user.delete({ where: { id: acceptor } });
      }
    });

    it("ignores a pending row whose DB expiresAt has passed (edge case 3.6, same gate as acceptInvite)", async () => {
      const email = `find-expired-${RUN}@example.com`;
      const { invite } = await Team.inviteMember({ connectionId, email, role: "write", invitedByUserId: ownerUserId });
      await prisma.connectionInvite.update({ where: { id: invite.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect(await Team.findPendingInviteForEmail(email)).toBeNull();
    });

    it("picks the most recently sent invite when the same email has pending invites to more than one business (edge case: multi-business invites, docs/team-management-spec.md)", async () => {
      const email = `find-multi-${RUN}@example.com`;
      const secondConnection = await prisma.connection.create({
        data: { userId: ownerUserId, platform, shop: `team-test-second-${RUN}.myshopify.com`, credentials: "", status: "active" },
      });
      await setPlanManually(secondConnection.id, "business");
      try {
        const older = await Team.inviteMember({ connectionId, email, role: "read", invitedByUserId: ownerUserId });
        // createdAt has millisecond resolution — force a real ordering gap
        // rather than relying on two upserts landing in the same tick.
        await prisma.connectionInvite.update({ where: { id: older.invite.id }, data: { createdAt: new Date(Date.now() - 60_000) } });
        const newer = await Team.inviteMember({ connectionId: secondConnection.id, email, role: "admin", invitedByUserId: ownerUserId });

        const found = await Team.findPendingInviteForEmail(email);
        expect(found?.id).toBe(newer.invite.id);
      } finally {
        await prisma.connectionInvite.deleteMany({ where: { connectionId: secondConnection.id } });
        await prisma.connection.delete({ where: { id: secondConnection.id } });
      }
    });
  });

  describe("owner protection (edge case 3.4) — updateMemberRole/removeMember must reject targeting the owner row unconditionally", () => {
    it("updateMemberRole rejects any role change targeting the owner", async () => {
      await expect(
        Team.updateMemberRole({ connectionId, targetUserId: ownerUserId, role: "admin", actingUserId: existingMemberUserId })
      ).rejects.toMatchObject({ code: "getbooqin_cannot_modify_owner" });

      // Even the owner acting on themself.
      await expect(
        Team.updateMemberRole({ connectionId, targetUserId: ownerUserId, role: "read", actingUserId: ownerUserId })
      ).rejects.toMatchObject({ code: "getbooqin_cannot_modify_owner" });

      const row = await prisma.connectionMember.findUniqueOrThrow({ where: { connectionId_userId: { connectionId, userId: ownerUserId } } });
      expect(row.role).toBe("owner"); // unchanged
    });

    it("removeMember rejects removing the owner, including the owner acting on their own row", async () => {
      await expect(
        Team.removeMember({ connectionId, targetUserId: ownerUserId, actingUserId: existingMemberUserId })
      ).rejects.toMatchObject({ code: "getbooqin_cannot_modify_owner" });

      await expect(
        Team.removeMember({ connectionId, targetUserId: ownerUserId, actingUserId: ownerUserId })
      ).rejects.toMatchObject({ code: "getbooqin_cannot_modify_owner" });

      expect(await prisma.connectionMember.findUnique({ where: { connectionId_userId: { connectionId, userId: ownerUserId } } })).not.toBeNull();
    });

    it("updateMemberRole never accepts 'owner' as a target role for a non-owner member (no promotion path)", async () => {
      await expect(
        Team.updateMemberRole({ connectionId, targetUserId: existingMemberUserId, role: "owner", actingUserId: ownerUserId })
      ).rejects.toMatchObject({ code: "getbooqin_invalid_role" });
    });

    it("updateMemberRole/removeMember on a non-owner member succeed normally", async () => {
      const updated = await Team.updateMemberRole({ connectionId, targetUserId: existingMemberUserId, role: "admin", actingUserId: ownerUserId });
      expect(updated.role).toBe("admin");

      await Team.removeMember({ connectionId, targetUserId: existingMemberUserId, actingUserId: ownerUserId });
      expect(await prisma.connectionMember.findUnique({ where: { connectionId_userId: { connectionId, userId: existingMemberUserId } } })).toBeNull();

      // Restore the fixture for any tests that run after this file in the
      // same connection (afterAll cleans the whole connection anyway).
      await prisma.connectionMember.create({ data: { connectionId, userId: existingMemberUserId, role: "write" } });
    });
  });

  describe("atLeast() / role ranking", () => {
    it("ranks owner > admin > write > read, and treats unrecognized roles as below everything", () => {
      expect(Team.atLeast("owner", "admin")).toBe(true);
      expect(Team.atLeast("admin", "owner")).toBe(false);
      expect(Team.atLeast("write", "write")).toBe(true);
      expect(Team.atLeast("read", "write")).toBe(false);
      expect(Team.atLeast("bogus-role", "read")).toBe(false);
    });
  });

  describe("normalizeEmail()", () => {
    it("trims and lower-cases", () => {
      expect(Team.normalizeEmail("  Jane@Biz.COM  ")).toBe("jane@biz.com");
    });
  });
});

// Sanity check that isGetBooqinError (used by invite.$token.tsx's loader to
// map thrown errors to specific terminal screens) actually recognizes the
// errors these functions throw — if this ever stopped being true, every
// race-condition branch in the loader (revoked/expired/already-accepted
// between its own state check and acceptInvite()) would fall through to an
// uncaught 500 instead of the intended screen.
describe("GetBooqinError interop with the invite.$token.tsx loader's error mapping", () => {
  it("isGetBooqinError recognizes Team.acceptInvite's thrown errors", async () => {
    try {
      await Team.acceptInvite({ token: "not-a-real-token", userId: "nobody" });
      throw new Error("expected acceptInvite to throw");
    } catch (err) {
      expect(isGetBooqinError(err)).toBe(true);
    }
  });
});
