# End-to-end suites

Two suites, because they answer different questions and carry different
risk.

## `test:e2e` — public, safe to point at production

```
E2E_BASE_URL=https://getbooqin.fly.dev E2E_BOOKING_SLUG=<a slug> npm run test:e2e
```

Read-only throughout: it loads pages and asserts on what came back.
Nothing signs up, pays, or writes. Covers the public pages, the terms
actually containing the renewal/refund/tax/deletion sections that make
charging lawful, the security boundaries (`/admin` unreachable,
`/dashboard` requires a session, the webhook rejecting an unsigned
POST), and — the one that earns its keep — **the landing page's prices
against `plans.ts`**. That page quoted $0/$29/$79 against a product
charging ₹399/₹799 for months; the only version of that fix which
survives a future edit is one that fails the build.

## `test:e2e:auth` — authenticated, localhost only

```
set -a && . ./.env && set +a
PLATFORM_ADMIN_EMAILS=gb-e2e-admin+clerk_test@example.com npm run dev    # separate terminal
PLATFORM_ADMIN_EMAILS=gb-e2e-admin+clerk_test@example.com npm run test:e2e:auth
```

**Never point this at production.** It creates Clerk users and exercises
account deletion. `seedTenant()` refuses any `DATABASE_URL` that isn't
obviously local, and the config has no base-URL override for the same
reason.

### Why the setup is fiddly

Three things had to be got right, and each failed in a way that looked
like a product bug:

1. **Sign-in uses a Clerk *ticket*, not a password.** A brand-new user's
   first password sign-in returns `status: "needs_client_trust"` —
   Clerk's device verification — which no browser automation can clear
   and which the testing token does not bypass (that token exists for
   bot detection, a different check). `signInTokens.createSignInToken()`
   plus `signIn.create({ strategy: "ticket" })` skips first factors
   entirely.

2. **`clerkSetup()` reads `CLERK_PUBLISHABLE_KEY`**, but this app stores
   it as `VITE_CLERK_PUBLISHABLE_KEY` because Vite compiles it into the
   client bundle at build time. `global-setup.ts` aliases it.

3. **The admin fixture's email is fixed**, not random. The guard
   requires the address to be in `PLATFORM_ADMIN_EMAILS`, which the app
   server reads from *its own* environment at startup — a per-run random
   address could never be on the list, and the admin tests would then
   pass for the wrong reason, because nobody can reach `/admin` when the
   allowlist is empty. Global setup refuses to run without it, rather
   than letting that happen quietly.

### What it covers

- Settings → Billing: the trial banner, usage meters, prices in the
  shop's own currency (the derivation that silently defaulted every
  account to USD and broke checkout for three deploys), the monthly /
  yearly toggle, and the tax fields.
- The admin guard as two real people: a signed-in merchant gets 404, a
  platform admin gets the accounts table.
- Every admin form demanding a reason, and a comp actually changing the
  plan and recording why.

### What neither suite covers

The Razorpay hosted page. Checkout redirects off-site to authorise a
mandate, and asserting on a third party's UI would be testing their
product. The webhook that follows is covered by unit tests and was
verified end-to-end against production by hand — see the Phase 2 notes.
