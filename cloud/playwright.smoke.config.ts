import { defineConfig, devices } from "@playwright/test";

/**
 * The post-deploy release gate.
 *
 * Separate from the public suite on purpose. That one is a test suite —
 * it grows, it covers copy, it is fine for it to be slow. This one is a
 * decision: it runs against whatever was just deployed and its failure
 * means roll back. Keeping it small and read-only is what makes it
 * trustworthy enough to act on.
 *
 *   E2E_BASE_URL=https://getbooqin.fly.dev npm run smoke
 *
 * No webServer: this always points at something already running. It
 * never seeds, never signs in and never writes, so it is safe against
 * production — which is the only environment whose answer matters here.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "smoke.spec.ts",
  // One retry. A cold Fly machine can lose the first request of a
  // deploy, and rolling back over that would be worse than waiting two
  // seconds.
  retries: 1,
  timeout: 30_000,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3100",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
});
