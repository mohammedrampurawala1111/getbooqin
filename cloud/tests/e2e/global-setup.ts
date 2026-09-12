import { clerkSetup } from "@clerk/testing/playwright";
import type { FullConfig } from "@playwright/test";

/**
 * Fetches Clerk's testing token once for the whole run.
 *
 * Without it Clerk answers every programmatic sign-in with
 * `status: "needs_client_trust"` — its bot/device check, which no
 * browser automation can pass — and every authenticated test fails
 * looking like a product bug rather than a harness one.
 *
 * The key aliasing below is not incidental. `clerkSetup()` reads
 * `CLERK_PUBLISHABLE_KEY`, but this app stores it as
 * `VITE_CLERK_PUBLISHABLE_KEY` because Vite compiles it into the client
 * bundle at build time (see fly.toml's build args). Without the alias
 * clerkSetup has no instance to ask, no token is issued, and the failure
 * surfaces three layers away.
 */
export default async function globalSetup(_: FullConfig) {
  if (!process.env.CLERK_PUBLISHABLE_KEY && process.env.VITE_CLERK_PUBLISHABLE_KEY) {
    process.env.CLERK_PUBLISHABLE_KEY = process.env.VITE_CLERK_PUBLISHABLE_KEY;
  }

  for (const key of ["CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY"]) {
    if (!process.env[key]) {
      throw new Error(
        `${key} is required for the authenticated suite. Load cloud/.env first:\n` +
          `  set -a && . ./.env && set +a && npm run test:e2e:auth`
      );
    }
  }

  // The admin guard needs the fixture's address on the *server's*
  // allowlist, and the server reads it at startup — so this is checked
  // here rather than discovered as three admin tests that quietly pass
  // because nobody can reach /admin at all.
  const allowlist = (process.env.PLATFORM_ADMIN_EMAILS ?? "").toLowerCase();
  if (!allowlist.includes("gb-e2e-admin+clerk_test@example.com")) {
    throw new Error(
      "The authenticated suite needs the admin fixture allowlisted on the app server.\n" +
        "  PLATFORM_ADMIN_EMAILS=gb-e2e-admin+clerk_test@example.com npm run dev\n" +
        "and export the same value for the test run."
    );
  }

  await clerkSetup();

  if (!process.env.CLERK_TESTING_TOKEN) {
    throw new Error("clerkSetup() returned no testing token — sign-in would hit Clerk's bot check and fail.");
  }
}
