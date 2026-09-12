import { createClerkClient } from "@clerk/backend";
import { PrismaClient } from "@prisma/client";

/**
 * A disposable merchant: a real Clerk user, a real Connection, and the
 * settings/subscription rows a dashboard needs to render.
 *
 * Real, not mocked, because the thing worth testing is whether Clerk's
 * session actually carries through `authenticateRequest` into
 * `requireTenant` — a mock would assert that our mock works.
 *
 * **Local only.** This creates and deletes users and businesses, and
 * `deleteBusiness()` is genuinely destructive. Pointing it at production
 * would erase real data, so `seedTenant` refuses any DATABASE_URL that
 * isn't obviously local.
 */
const prisma = new PrismaClient();

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });

/** A password that satisfies Clerk's strength rules without being guessable. */
export const TEST_PASSWORD = "gb-e2e-Xq7!vnP2wz";

/**
 * The platform-admin fixture's address is **fixed**, unlike every other
 * seeded user's.
 *
 * It has to be: the admin guard requires the email to appear in
 * `PLATFORM_ADMIN_EMAILS`, which the app server reads from its own
 * environment at startup — so a per-run random address could never be
 * on the list, and the admin tests would pass for the wrong reason
 * (nobody can reach /admin when the allowlist is empty).
 *
 * Any leftover Clerk user with this address is deleted before it is
 * recreated, so a crashed run doesn't wedge the next one.
 */
export const ADMIN_EMAIL = "gb-e2e-admin+clerk_test@example.com";

export interface SeededTenant {
  clerkUserId: string;
  email: string;
  password: string;
  connectionId: string;
  shop: string;
  platform: string;
}

function assertLocalDatabase(): void {
  const url = process.env.DATABASE_URL ?? "";
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  if (!isLocal) {
    throw new Error(
      `Refusing to seed: DATABASE_URL does not look local. These fixtures create and DELETE accounts.\n` +
        `Point DATABASE_URL at a local Postgres before running the authenticated suite.`
    );
  }
}

export async function seedTenant(label: string, opts: { email?: string } = {}): Promise<SeededTenant> {
  assertLocalDatabase();

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  // `+clerk_test` is Clerk's reserved test-address convention: these
  // skip real email delivery and, crucially, skip the device-trust
  // verification a brand-new user otherwise hits on first sign-in
  // (status: "needs_client_trust"), which no browser automation can
  // clear. Only works on a development instance, which is the only kind
  // this suite is allowed to touch.
  const email = opts.email ?? `gb-e2e-${label}-${stamp}+clerk_test@example.com`;

  // A fixed address (the admin fixture) may survive a crashed run.
  if (opts.email) {
    const existing = await clerk.users.getUserList({ emailAddress: [opts.email] });
    for (const stale of existing.data) {
      await prisma.connection.deleteMany({ where: { userId: stale.id } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: stale.id } }).catch(() => {});
      await clerk.users.deleteUser(stale.id).catch(() => {});
    }
  }

  const user = await clerk.users.createUser({
    emailAddress: [email],
    password: TEST_PASSWORD,
    skipPasswordChecks: true,
  });

  const shop = `e2e-${label}-${stamp}`;
  const platform = "manual";

  // core's User row: normally written by the Clerk webhook, which isn't
  // running against a local dev server.
  await prisma.user.create({ data: { id: user.id, email } });

  const connection = await prisma.connection.create({
    data: { userId: user.id, platform, shop, credentials: "", status: "active" },
  });
  await prisma.connectionMember.create({
    data: { connectionId: connection.id, userId: user.id, role: "owner" },
  });
  await prisma.shopSettings.create({
    data: {
      shop,
      platform,
      // INR so the account resolves to a currency that actually has
      // plans behind it — the same derivation the checkout uses.
      data: JSON.stringify({ business_name: `E2E ${label}`, currency: "INR", timezone: "Asia/Kolkata" }),
    },
  });
  await prisma.subscription.create({
    data: {
      connectionId: connection.id,
      plan: "growth",
      status: "trialing",
      currency: "INR",
      trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
    },
  });

  return { clerkUserId: user.id, email, password: TEST_PASSWORD, connectionId: connection.id, shop, platform };
}

/** Promotes a seeded tenant to platform admin — both halves, as the guard requires. */
export async function makePlatformAdmin(tenant: SeededTenant): Promise<void> {
  await prisma.user.update({ where: { id: tenant.clerkUserId }, data: { isPlatformAdmin: true } });
}

/**
 * Best-effort teardown. Every step is individually guarded: a test that
 * already deleted its own account (the deletion spec does exactly that)
 * must not leave a Clerk user behind because the database half threw.
 */
export async function destroyTenant(tenant: SeededTenant): Promise<void> {
  const scope = { shop: tenant.shop, platform: tenant.platform };
  for (const step of [
    () => prisma.bookingAddon.deleteMany({ where: scope }),
    () => prisma.booking.deleteMany({ where: scope }),
    () => prisma.customer.deleteMany({ where: scope }),
    () => prisma.serviceResource.deleteMany({ where: scope }),
    () => prisma.schedule.deleteMany({ where: scope }),
    () => prisma.resource.deleteMany({ where: scope }),
    () => prisma.serviceConfig.deleteMany({ where: scope }),
    () => prisma.productCache.deleteMany({ where: scope }),
    () => prisma.shopSettings.deleteMany({ where: scope }),
    () => prisma.entitlement.deleteMany({ where: { connectionId: tenant.connectionId } }),
    () => prisma.billingEvent.deleteMany({ where: { connectionId: tenant.connectionId } }),
    () => prisma.subscription.deleteMany({ where: { connectionId: tenant.connectionId } }),
    () => prisma.connectionMember.deleteMany({ where: { connectionId: tenant.connectionId } }),
    () => prisma.adminAuditLog.deleteMany({ where: { actorUserId: tenant.clerkUserId } }),
    () => prisma.connection.deleteMany({ where: { id: tenant.connectionId } }),
    () => prisma.user.deleteMany({ where: { id: tenant.clerkUserId } }),
    () => clerk.users.deleteUser(tenant.clerkUserId),
  ]) {
    await step().catch(() => {});
  }
}

export async function disconnectFixtures(): Promise<void> {
  await prisma.$disconnect();
}

/**
 * Signs a seeded tenant in, using a Clerk **sign-in ticket**.
 *
 * Not `clerk.signIn({ strategy: "password" })`, which is the obvious
 * choice and does not work here: a brand-new user's first sign-in comes
 * back `status: "needs_client_trust"` — Clerk's device verification —
 * and no amount of testing token clears it, because it is not the bot
 * check the testing token exists to bypass.
 *
 * A ticket is the documented programmatic path. It is minted server-side
 * against a user id and consumed by `signIn.create({ strategy:
 * "ticket" })`, which skips first factors entirely — no password, no
 * email code, no device trust.
 */
export async function signInAs(page: import("@playwright/test").Page, tenant: SeededTenant): Promise<void> {
  const { token } = await clerk.signInTokens.createSignInToken({
    userId: tenant.clerkUserId,
    expiresInSeconds: 300,
  });

  // Clerk has to be loaded before its client can consume the ticket, so
  // land on a page that mounts ClerkProvider first.
  await page.goto("/login");
  await page.waitForFunction(() => (window as globalThis.Window & { Clerk?: { loaded?: boolean } }).Clerk?.loaded === true, {
    timeout: 15_000,
  });

  const status = await page.evaluate(async (ticket: string) => {
    const c = (window as unknown as { Clerk: { client: { signIn: { create: (o: unknown) => Promise<{ status: string; createdSessionId: string }> } }; setActive: (o: unknown) => Promise<void> } }).Clerk;
    const attempt = await c.client.signIn.create({ strategy: "ticket", ticket });
    if (attempt.status === "complete") await c.setActive({ session: attempt.createdSessionId });
    return attempt.status;
  }, token);

  if (status !== "complete") {
    throw new Error(`Clerk ticket sign-in did not complete (status: ${status}).`);
  }

  // setActive writes the session cookie asynchronously; without this the
  // next navigation can race it and land back on /login.
  await page.waitForFunction(() => !!(window as unknown as { Clerk?: { user?: unknown } }).Clerk?.user, {
    timeout: 10_000,
  });
}

/**
 * A platform admin: the fixed allowlisted address, plus the
 * `isPlatformAdmin` column. **Both halves**, because the guard requires
 * both — which is the property the admin tests exist to prove.
 */
export async function seedPlatformAdmin(): Promise<SeededTenant> {
  const tenant = await seedTenant("admin", { email: ADMIN_EMAIL });
  await makePlatformAdmin(tenant);
  return tenant;
}
