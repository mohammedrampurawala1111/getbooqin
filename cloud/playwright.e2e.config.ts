import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end smoke suite, run in a real Chrome.
 *
 * Separate from the axe suite (playwright.config.ts) because it asks a
 * different question: not "is this accessible" but "does the thing
 * actually work when a browser loads it". They share a directory tree
 * and nothing else.
 *
 * Defaults to localhost so a stray `npx playwright test` can't point
 * itself at production by accident; pass E2E_BASE_URL to aim it
 * somewhere real. Every case here is read-only — it loads pages and
 * asserts on what came back. Nothing in it signs up, pays, or writes.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3100",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  // No webServer when pointed at a real deployment.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: "npm run dev", url: "http://localhost:3100", reuseExistingServer: true, timeout: 60_000 },
});
