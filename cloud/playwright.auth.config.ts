import { defineConfig, devices } from "@playwright/test";

/**
 * The authenticated end-to-end suite — everything behind Clerk that the
 * public suite deliberately can't reach: Settings → Billing, the plan
 * limits biting, the admin console's guard, the deletion danger zone.
 *
 * **Localhost only, and it enforces that.** These tests create Clerk
 * users and exercise account deletion, which is genuinely destructive.
 * There is no E2E_BASE_URL escape hatch here on purpose — the public
 * suite is the one you point at production.
 *
 * Serial, not parallel: the fixtures create and delete real Clerk users,
 * and Clerk's API is rate-limited enough that four workers racing on it
 * produces flakes that look like product bugs.
 */
export default defineConfig({
  testDir: "./tests/e2e/auth",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: process.env.AUTH_E2E_BASE_URL || "http://localhost:3100",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  // Skipped when AUTH_E2E_BASE_URL points at a server you started
  // yourself — useful when you need its logs.
  webServer: process.env.AUTH_E2E_BASE_URL
    ? undefined
    : { command: "npm run dev", url: "http://localhost:3100", reuseExistingServer: true, timeout: 90_000 },
});
