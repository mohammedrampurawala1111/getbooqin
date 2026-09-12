/**
 * The admin console's two load-bearing properties: who gets in, and
 * whether every change leaves a record.
 *
 * Access is tested hardest because it is the only surface in the product
 * that sits above every tenant at once.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../db.js";
import { isPlatformAdmin, isAllowlistedEmail, promoteAllowlistedUser } from "../access.js";
import { setPlan, extendTrialTo, grantEntitlement, revokeEntitlement, isEntitlementKey } from "../actions.js";
import * as Audit from "../audit.js";
import * as Accounts from "../accounts.js";
import { entitlementsFor } from "../../billing/entitlements.js";

const RUN = Date.now();
const adminEmail = `admin-${RUN}@getbooqin.test`;
const outsiderEmail = `outsider-${RUN}@example.com`;
const adminId = `adm-${RUN}`;
const outsiderId = `out-${RUN}`;
let connectionId: string;

const savedAllowlist = process.env.PLATFORM_ADMIN_EMAILS;

beforeAll(async () => {
  process.env.PLATFORM_ADMIN_EMAILS = `${adminEmail}, someone-else@getbooqin.test`;
  await prisma.user.create({ data: { id: adminId, email: adminEmail, isPlatformAdmin: true } });
  await prisma.user.create({ data: { id: outsiderId, email: outsiderEmail } });
  const conn = await prisma.connection.create({
    data: { userId: outsiderId, platform: "manual", shop: `adm-${RUN}`, credentials: "", status: "active" },
  });
  connectionId = conn.id;
});

afterEach(async () => {
  await prisma.adminAuditLog.deleteMany({ where: { targetId: connectionId } });
  await prisma.entitlement.deleteMany({ where: { connectionId } });
});

afterAll(async () => {
  if (savedAllowlist === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
  else process.env.PLATFORM_ADMIN_EMAILS = savedAllowlist;
  await prisma.adminAuditLog.deleteMany({ where: { actorUserId: adminId } });
  await prisma.entitlement.deleteMany({ where: { connectionId } });
  await prisma.subscription.deleteMany({ where: { connectionId } });
  await prisma.connection.deleteMany({ where: { id: connectionId } });
  await prisma.user.deleteMany({ where: { id: { in: [adminId, outsiderId] } } });
});

describe("access — both layers are required", () => {
  it("admits a user who has the column AND is on the allowlist", async () => {
    expect(await isPlatformAdmin(adminId)).toBe(true);
  });

  it("refuses the column alone", async () => {
    // A bad write to User.isPlatformAdmin must not be enough on its own.
    await prisma.user.update({ where: { id: outsiderId }, data: { isPlatformAdmin: true } });
    expect(await isPlatformAdmin(outsiderId)).toBe(false);
    await prisma.user.update({ where: { id: outsiderId }, data: { isPlatformAdmin: false } });
  });

  it("refuses the allowlist alone", async () => {
    // ...and being named in the env var isn't enough either, which is
    // what stops the app self-promoting anyone who signs up with a
    // matching address.
    await prisma.user.update({ where: { id: adminId }, data: { isPlatformAdmin: false } });
    expect(await isPlatformAdmin(adminId)).toBe(false);
    await prisma.user.update({ where: { id: adminId }, data: { isPlatformAdmin: true } });
  });

  it("refuses an unknown user", async () => {
    expect(await isPlatformAdmin(`nobody-${RUN}`)).toBe(false);
  });

  it("denies everyone when the allowlist is empty", async () => {
    // "Unset means open" is the kind of default that turns a missing env
    // var into a full compromise.
    const saved = process.env.PLATFORM_ADMIN_EMAILS;
    process.env.PLATFORM_ADMIN_EMAILS = "";
    try {
      expect(isAllowlistedEmail(adminEmail)).toBe(false);
      expect(await isPlatformAdmin(adminId)).toBe(false);
    } finally {
      process.env.PLATFORM_ADMIN_EMAILS = saved;
    }
  });

  it("matches allowlist entries case- and whitespace-insensitively", () => {
    expect(isAllowlistedEmail(adminEmail.toUpperCase())).toBe(true);
    expect(isAllowlistedEmail(`  ${adminEmail}  `)).toBe(true);
    expect(isAllowlistedEmail("someone-else@getbooqin.test")).toBe(true);
    expect(isAllowlistedEmail(outsiderEmail)).toBe(false);
  });

  it("promoteAllowlistedUser only ever promotes someone already allowlisted", async () => {
    expect(await promoteAllowlistedUser(outsiderEmail)).toBe(false);
    const after = await prisma.user.findUnique({ where: { id: outsiderId } });
    expect(after?.isPlatformAdmin).toBe(false);
  });
});

describe("actions require a reason", () => {
  const noReason = { actorUserId: adminId, reason: "" };

  it("refuses a plan change with no reason", async () => {
    await expect(setPlan(connectionId, "growth", noReason)).rejects.toMatchObject({
      code: "getbooqin_reason_required",
    });
  });

  it("refuses a whitespace-only reason", async () => {
    await expect(setPlan(connectionId, "growth", { actorUserId: adminId, reason: "   " })).rejects.toMatchObject({
      code: "getbooqin_reason_required",
    });
  });

  it("refuses a grant with no reason", async () => {
    await expect(grantEntitlement(connectionId, { key: "waitlist", value: "on" }, noReason)).rejects.toMatchObject({
      code: "getbooqin_reason_required",
    });
  });
});

describe("plan override", () => {
  const ctx = { actorUserId: adminId, reason: "design partner", ip: "1.2.3.4" };

  it("comps an account without touching a payment provider", async () => {
    await setPlan(connectionId, "growth", ctx);
    const ent = await entitlementsFor(connectionId);
    expect(ent.plan).toBe("growth");
    expect(ent.status).toBe("active");
    expect(ent.billingProvider).toBe("manual");
  });

  it("writes an audit row with before, after and the reason", async () => {
    await setPlan(connectionId, "starter", ctx);
    const [entry] = await Audit.list({ targetId: connectionId });
    expect(entry).toMatchObject({ action: "plan.change", reason: "design partner", actorEmail: adminEmail });
    expect(entry.after).toContain("starter");
  });

  it("a time-boxed comp expires on its own", async () => {
    // The honest way to do "free until 31 Dec" — nobody has to remember
    // to take it away.
    await setPlan(connectionId, "growth", ctx, new Date(Date.now() - 86_400_000));
    expect((await entitlementsFor(connectionId)).plan).toBe("free");
  });

  it("rejects an unknown plan", async () => {
    await expect(setPlan(connectionId, "enterprise" as never, ctx)).rejects.toMatchObject({
      code: "getbooqin_invalid_plan",
    });
  });
});

describe("trial extension", () => {
  const ctx = { actorUserId: adminId, reason: "asked for more time" };

  it("extends and records", async () => {
    const until = new Date(Date.now() + 14 * 86_400_000);
    await extendTrialTo(connectionId, until, ctx);
    const ent = await entitlementsFor(connectionId);
    expect(ent.status).toBe("trialing");
    expect(ent.trialDaysLeft).toBe(14);
    expect((await Audit.list({ targetId: connectionId }))[0].action).toBe("trial.extend");
  });

  it("refuses a date in the past, which would cut the account off instead", async () => {
    await expect(extendTrialTo(connectionId, new Date(Date.now() - 86_400_000), ctx)).rejects.toMatchObject({
      code: "getbooqin_invalid_date",
    });
  });

  it("refuses an unparseable date", async () => {
    await expect(extendTrialTo(connectionId, new Date("nonsense"), ctx)).rejects.toMatchObject({
      code: "getbooqin_invalid_date",
    });
  });
});

describe("entitlement grants", () => {
  const ctx = { actorUserId: adminId, reason: "early access pilot" };

  it("grants a feature the plan doesn't include", async () => {
    await setPlan(connectionId, "free", { ...ctx, reason: "reset for test" });
    await grantEntitlement(connectionId, { key: "waitlist", value: "on" }, ctx);
    expect((await entitlementsFor(connectionId)).features.has("waitlist")).toBe(true);
  });

  it("raises a numeric limit", async () => {
    await grantEntitlement(connectionId, { key: "limit.resources", value: "25" }, ctx);
    expect((await entitlementsFor(connectionId)).limits.resources).toBe(25);
  });

  it("accepts unlimited", async () => {
    await grantEntitlement(connectionId, { key: "limit.services", value: "unlimited" }, ctx);
    expect((await entitlementsFor(connectionId)).limits.services).toBe(Infinity);
  });

  it("refuses a limit value that isn't a number or 'unlimited'", async () => {
    // limitFromString turns garbage into 0, which would silently cap an
    // account at nothing. Catch it at the door instead.
    await expect(grantEntitlement(connectionId, { key: "limit.resources", value: "lots" }, ctx)).rejects.toMatchObject({
      code: "getbooqin_invalid_entitlement",
    });
    await expect(grantEntitlement(connectionId, { key: "limit.resources", value: "-5" }, ctx)).rejects.toMatchObject({
      code: "getbooqin_invalid_entitlement",
    });
  });

  it("refuses a feature value that isn't on or off", async () => {
    await expect(grantEntitlement(connectionId, { key: "waitlist", value: "maybe" }, ctx)).rejects.toMatchObject({
      code: "getbooqin_invalid_entitlement",
    });
  });

  it("refuses a key that isn't a real feature or limit", async () => {
    await expect(grantEntitlement(connectionId, { key: "wataitlist", value: "on" }, ctx)).rejects.toMatchObject({
      code: "getbooqin_invalid_entitlement",
    });
    await expect(grantEntitlement(connectionId, { key: "limit.nonsense", value: "5" }, ctx)).rejects.toMatchObject({
      code: "getbooqin_invalid_entitlement",
    });
  });

  it("re-granting the same key updates it rather than erroring", async () => {
    await grantEntitlement(connectionId, { key: "limit.resources", value: "5" }, ctx);
    await grantEntitlement(connectionId, { key: "limit.resources", value: "9" }, { ...ctx, reason: "raised again" });
    expect((await entitlementsFor(connectionId)).limits.resources).toBe(9);
    expect(await prisma.entitlement.count({ where: { connectionId, key: "limit.resources" } })).toBe(1);
  });

  it("revokes, and records both the grant and the revoke", async () => {
    await grantEntitlement(connectionId, { key: "export", value: "on" }, ctx);
    await revokeEntitlement(connectionId, "export", { ...ctx, reason: "pilot over" });
    expect((await entitlementsFor(connectionId)).features.has("export")).toBe(false);
    const actions = (await Audit.list({ targetId: connectionId })).map((a) => a.action);
    expect(actions).toContain("entitlement.grant");
    expect(actions).toContain("entitlement.revoke");
  });

  it("revoking something that isn't there is a 404, not a silent success", async () => {
    await expect(revokeEntitlement(connectionId, "export", ctx)).rejects.toMatchObject({ code: "getbooqin_not_found" });
  });

  it("isEntitlementKey accepts only real keys", () => {
    expect(isEntitlementKey("waitlist")).toBe(true);
    expect(isEntitlementKey("limit.teamMembers")).toBe(true);
    expect(isEntitlementKey("limit.teamMember")).toBe(false);
    expect(isEntitlementKey("admin")).toBe(false);
  });
});

describe("accounts list", () => {
  it("surfaces the account with its plan and counts, and no tenant data", async () => {
    await setPlan(connectionId, "growth", { actorUserId: adminId, reason: "listing test" });
    const rows = await Accounts.list();
    const row = rows.find((r) => r.connectionId === connectionId);
    expect(row).toBeTruthy();
    expect(row!.plan).toBe("growth");
    expect(row!.ownerEmail).toBe(outsiderEmail);
    // Counts only — never a customer name or a booking.
    expect(Object.keys(row!)).not.toContain("customers");
    expect(Object.keys(row!)).not.toContain("bookings");
  });

  it("the expiring filter finds trials inside a week", async () => {
    await extendTrialTo(connectionId, new Date(Date.now() + 3 * 86_400_000), {
      actorUserId: adminId, reason: "expiring filter test",
    });
    const rows = await Accounts.list({ filter: "expiring" });
    expect(rows.some((r) => r.connectionId === connectionId)).toBe(true);

    await extendTrialTo(connectionId, new Date(Date.now() + 60 * 86_400_000), {
      actorUserId: adminId, reason: "back out of range",
    });
    const later = await Accounts.list({ filter: "expiring" });
    expect(later.some((r) => r.connectionId === connectionId)).toBe(false);
  });

  it("search matches on owner email", async () => {
    const rows = await Accounts.list({ search: outsiderEmail });
    expect(rows.some((r) => r.connectionId === connectionId)).toBe(true);
  });
});
