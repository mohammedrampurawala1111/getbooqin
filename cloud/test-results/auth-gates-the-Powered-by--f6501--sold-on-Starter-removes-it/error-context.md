# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: auth/gates.spec.ts >> the Powered by badge — what Starter is actually sold on >> Starter removes it
- Location: tests/e2e/auth/gates.spec.ts:98:3

# Error details

```
Error: Missing Clerk Secret Key. Go to https://dashboard.clerk.com and get your key for your instance.
```

```
TypeError: Cannot read properties of undefined (reading 'shop')
```

# Test source

```ts
  33  |  *
  34  |  * Any leftover Clerk user with this address is deleted before it is
  35  |  * recreated, so a crashed run doesn't wedge the next one.
  36  |  */
  37  | export const ADMIN_EMAIL = "gb-e2e-admin+clerk_test@example.com";
  38  | 
  39  | export interface SeededTenant {
  40  |   clerkUserId: string;
  41  |   email: string;
  42  |   password: string;
  43  |   connectionId: string;
  44  |   shop: string;
  45  |   platform: string;
  46  | }
  47  | 
  48  | function assertLocalDatabase(): void {
  49  |   const url = process.env.DATABASE_URL ?? "";
  50  |   const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  51  |   if (!isLocal) {
  52  |     throw new Error(
  53  |       `Refusing to seed: DATABASE_URL does not look local. These fixtures create and DELETE accounts.\n` +
  54  |         `Point DATABASE_URL at a local Postgres before running the authenticated suite.`
  55  |     );
  56  |   }
  57  | }
  58  | 
  59  | export async function seedTenant(label: string, opts: { email?: string } = {}): Promise<SeededTenant> {
  60  |   assertLocalDatabase();
  61  | 
  62  |   const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  63  |   // `+clerk_test` is Clerk's reserved test-address convention: these
  64  |   // skip real email delivery and, crucially, skip the device-trust
  65  |   // verification a brand-new user otherwise hits on first sign-in
  66  |   // (status: "needs_client_trust"), which no browser automation can
  67  |   // clear. Only works on a development instance, which is the only kind
  68  |   // this suite is allowed to touch.
  69  |   const email = opts.email ?? `gb-e2e-${label}-${stamp}+clerk_test@example.com`;
  70  | 
  71  |   // A fixed address (the admin fixture) may survive a crashed run.
  72  |   if (opts.email) {
  73  |     const existing = await clerk.users.getUserList({ emailAddress: [opts.email] });
  74  |     for (const stale of existing.data) {
  75  |       await prisma.connection.deleteMany({ where: { userId: stale.id } }).catch(() => {});
  76  |       await prisma.user.deleteMany({ where: { id: stale.id } }).catch(() => {});
  77  |       await clerk.users.deleteUser(stale.id).catch(() => {});
  78  |     }
  79  |   }
  80  | 
  81  |   const user = await clerk.users.createUser({
  82  |     emailAddress: [email],
  83  |     password: TEST_PASSWORD,
  84  |     skipPasswordChecks: true,
  85  |   });
  86  | 
  87  |   const shop = `e2e-${label}-${stamp}`;
  88  |   const platform = "manual";
  89  | 
  90  |   // core's User row: normally written by the Clerk webhook, which isn't
  91  |   // running against a local dev server.
  92  |   await prisma.user.create({ data: { id: user.id, email } });
  93  | 
  94  |   const connection = await prisma.connection.create({
  95  |     data: { userId: user.id, platform, shop, credentials: "", status: "active" },
  96  |   });
  97  |   await prisma.connectionMember.create({
  98  |     data: { connectionId: connection.id, userId: user.id, role: "owner" },
  99  |   });
  100 |   await prisma.shopSettings.create({
  101 |     data: {
  102 |       shop,
  103 |       platform,
  104 |       // INR so the account resolves to a currency that actually has
  105 |       // plans behind it — the same derivation the checkout uses.
  106 |       data: JSON.stringify({ business_name: `E2E ${label}`, currency: "INR", timezone: "Asia/Kolkata" }),
  107 |     },
  108 |   });
  109 |   await prisma.subscription.create({
  110 |     data: {
  111 |       connectionId: connection.id,
  112 |       plan: "growth",
  113 |       status: "trialing",
  114 |       currency: "INR",
  115 |       trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
  116 |     },
  117 |   });
  118 | 
  119 |   return { clerkUserId: user.id, email, password: TEST_PASSWORD, connectionId: connection.id, shop, platform };
  120 | }
  121 | 
  122 | /** Promotes a seeded tenant to platform admin — both halves, as the guard requires. */
  123 | export async function makePlatformAdmin(tenant: SeededTenant): Promise<void> {
  124 |   await prisma.user.update({ where: { id: tenant.clerkUserId }, data: { isPlatformAdmin: true } });
  125 | }
  126 | 
  127 | /**
  128 |  * Best-effort teardown. Every step is individually guarded: a test that
  129 |  * already deleted its own account (the deletion spec does exactly that)
  130 |  * must not leave a Clerk user behind because the database half threw.
  131 |  */
  132 | export async function destroyTenant(tenant: SeededTenant): Promise<void> {
> 133 |   const scope = { shop: tenant.shop, platform: tenant.platform };
      |                                ^ TypeError: Cannot read properties of undefined (reading 'shop')
  134 |   for (const step of [
  135 |     () => prisma.bookingAddon.deleteMany({ where: scope }),
  136 |     () => prisma.booking.deleteMany({ where: scope }),
  137 |     () => prisma.customer.deleteMany({ where: scope }),
  138 |     () => prisma.serviceResource.deleteMany({ where: scope }),
  139 |     () => prisma.schedule.deleteMany({ where: scope }),
  140 |     () => prisma.resource.deleteMany({ where: scope }),
  141 |     () => prisma.serviceConfig.deleteMany({ where: scope }),
  142 |     () => prisma.productCache.deleteMany({ where: scope }),
  143 |     () => prisma.shopSettings.deleteMany({ where: scope }),
  144 |     () => prisma.entitlement.deleteMany({ where: { connectionId: tenant.connectionId } }),
  145 |     () => prisma.billingEvent.deleteMany({ where: { connectionId: tenant.connectionId } }),
  146 |     () => prisma.subscription.deleteMany({ where: { connectionId: tenant.connectionId } }),
  147 |     () => prisma.connectionMember.deleteMany({ where: { connectionId: tenant.connectionId } }),
  148 |     () => prisma.adminAuditLog.deleteMany({ where: { actorUserId: tenant.clerkUserId } }),
  149 |     () => prisma.connection.deleteMany({ where: { id: tenant.connectionId } }),
  150 |     () => prisma.user.deleteMany({ where: { id: tenant.clerkUserId } }),
  151 |     () => clerk.users.deleteUser(tenant.clerkUserId),
  152 |   ]) {
  153 |     await step().catch(() => {});
  154 |   }
  155 | }
  156 | 
  157 | export async function disconnectFixtures(): Promise<void> {
  158 |   await prisma.$disconnect();
  159 | }
  160 | 
  161 | /**
  162 |  * Signs a seeded tenant in, using a Clerk **sign-in ticket**.
  163 |  *
  164 |  * Not `clerk.signIn({ strategy: "password" })`, which is the obvious
  165 |  * choice and does not work here: a brand-new user's first sign-in comes
  166 |  * back `status: "needs_client_trust"` — Clerk's device verification —
  167 |  * and no amount of testing token clears it, because it is not the bot
  168 |  * check the testing token exists to bypass.
  169 |  *
  170 |  * A ticket is the documented programmatic path. It is minted server-side
  171 |  * against a user id and consumed by `signIn.create({ strategy:
  172 |  * "ticket" })`, which skips first factors entirely — no password, no
  173 |  * email code, no device trust.
  174 |  */
  175 | export async function signInAs(page: import("@playwright/test").Page, tenant: SeededTenant): Promise<void> {
  176 |   const { token } = await clerk.signInTokens.createSignInToken({
  177 |     userId: tenant.clerkUserId,
  178 |     expiresInSeconds: 300,
  179 |   });
  180 | 
  181 |   // Clerk has to be loaded before its client can consume the ticket, so
  182 |   // land on a page that mounts ClerkProvider first.
  183 |   await page.goto("/login");
  184 |   await page.waitForFunction(() => (window as globalThis.Window & { Clerk?: { loaded?: boolean } }).Clerk?.loaded === true, {
  185 |     timeout: 15_000,
  186 |   });
  187 | 
  188 |   const status = await page.evaluate(async (ticket: string) => {
  189 |     const c = (window as unknown as { Clerk: { client: { signIn: { create: (o: unknown) => Promise<{ status: string; createdSessionId: string }> } }; setActive: (o: unknown) => Promise<void> } }).Clerk;
  190 |     const attempt = await c.client.signIn.create({ strategy: "ticket", ticket });
  191 |     if (attempt.status === "complete") await c.setActive({ session: attempt.createdSessionId });
  192 |     return attempt.status;
  193 |   }, token);
  194 | 
  195 |   if (status !== "complete") {
  196 |     throw new Error(`Clerk ticket sign-in did not complete (status: ${status}).`);
  197 |   }
  198 | 
  199 |   // setActive writes the session cookie asynchronously; without this the
  200 |   // next navigation can race it and land back on /login.
  201 |   await page.waitForFunction(() => !!(window as unknown as { Clerk?: { user?: unknown } }).Clerk?.user, {
  202 |     timeout: 10_000,
  203 |   });
  204 | }
  205 | 
  206 | /**
  207 |  * A platform admin: the fixed allowlisted address, plus the
  208 |  * `isPlatformAdmin` column. **Both halves**, because the guard requires
  209 |  * both — which is the property the admin tests exist to prove.
  210 |  */
  211 | export async function seedPlatformAdmin(): Promise<SeededTenant> {
  212 |   const tenant = await seedTenant("admin", { email: ADMIN_EMAIL });
  213 |   await makePlatformAdmin(tenant);
  214 |   return tenant;
  215 | }
  216 | 
  217 | /** Puts a seeded tenant on a plan, so a test can assert what that plan gates. */
  218 | export async function setPlan(tenant: SeededTenant, plan: string): Promise<void> {
  219 |   await prisma.subscription.upsert({
  220 |     where: { connectionId: tenant.connectionId },
  221 |     create: { connectionId: tenant.connectionId, plan, status: "active", currency: "INR" },
  222 |     update: { plan, status: "active", trialEndsAt: null },
  223 |   });
  224 | }
  225 | 
  226 | /** Grants one entitlement key, the way the admin console would. */
  227 | export async function grantFeature(tenant: SeededTenant, key: string, value = "on"): Promise<void> {
  228 |   await prisma.entitlement.upsert({
  229 |     where: { connectionId_key: { connectionId: tenant.connectionId, key } },
  230 |     create: {
  231 |       connectionId: tenant.connectionId, key, value,
  232 |       grantedByUserId: tenant.clerkUserId, reason: "e2e fixture",
  233 |     },
```