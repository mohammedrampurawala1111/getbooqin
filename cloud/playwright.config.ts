import { defineConfig } from "@playwright/test";

// Axe-core smoke suite (UX audit's #9 finding: "add axe-core to CI" — form-
// label and contrast regressions had been introduced and re-fixed three
// times across this audit series without one). Scoped to routes that need
// no authenticated session or seeded tenant data beyond a connection row —
// see tests/a11y/README.md for what's covered and what still needs a
// Clerk test-session fixture to reach.
export default defineConfig({
  testDir: "./tests/a11y",
  timeout: 30_000,
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: process.env.A11Y_BASE_URL || "http://localhost:3100",
    trace: "retain-on-failure",
  },
  webServer: process.env.A11Y_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:3100",
        reuseExistingServer: true,
        timeout: 60_000,
      },
});
