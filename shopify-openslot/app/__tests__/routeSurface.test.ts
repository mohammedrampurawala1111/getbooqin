/**
 * What this app is, expressed as the set of routes it serves.
 *
 * The Shopify app used to be a second product: fifteen embedded admin
 * screens over the same database the cloud dashboard already had. Every
 * feature was built twice, every fix had to be remembered twice, and
 * the two drifted in between. Phase 4 collapsed all of it to one screen
 * that deep-links out.
 *
 * The risk now runs in two directions, and this file guards both:
 *
 *  1. **A second admin grows back.** Adding `app.bookings.tsx` is a
 *     twenty-minute job that quietly reintroduces the whole problem.
 *     Any new `app.*` screen fails this test and has to be argued for.
 *
 *  2. **The collapse took a keeper with it.** The storefront proxy, the
 *     theme extension's API, the Shopify webhooks, OAuth and the cron
 *     endpoints are things *only this app can do* — deleting one would
 *     break booking from a storefront, and nothing else in the repo
 *     would notice.
 *
 * A build proves these files compile. It does not prove they are still
 * routed, or that nobody has added a screen back, which is what this is
 * for.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTES_DIR = join(import.meta.dirname, "..", "routes");
const routeFiles = readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));

/** Everything this app must keep serving, because nothing else can. */
const MUST_KEEP = [
  // OAuth / install.
  "auth.$.tsx",
  "auth.login.tsx",
  // The storefront app proxy — the booking widget talks to these.
  "apps.getbooqin.$.tsx",
  "apps.getbooqin.config.tsx",
  "apps.getbooqin.services.tsx",
  "apps.getbooqin.resources.tsx",
  "apps.getbooqin.slots.tsx",
  "apps.getbooqin.days.tsx",
  "apps.getbooqin.bookings.tsx",
  "apps.getbooqin.bookings.$uid.tsx",
  "apps.getbooqin.bookings.$uid.cancel.tsx",
  "apps.getbooqin.bookings.$uid.reschedule.tsx",
  "apps.getbooqin.waitlist.join.tsx",
  "apps.getbooqin.waitlist.$token.tsx",
  "apps.getbooqin.waitlist.$uid.leave.tsx",
  "apps.getbooqin.product-service.tsx",
  "apps.getbooqin.embed-ping.tsx",
  // Admin block extension's own API — not an admin screen.
  "api.resources-addons.tsx",
  // Shopify's mandatory webhooks, plus the product sync.
  "webhooks.app.uninstalled.tsx",
  "webhooks.app.scopes_update.tsx",
  "webhooks.customers.data_request.tsx",
  "webhooks.customers.redact.tsx",
  "webhooks.shop.redact.tsx",
  "webhooks.products.tsx",
  // Scheduled work and the App Store's required public pages.
  "cron.reminders.tsx",
  "cron.waitlist.tsx",
  "privacy.tsx",
  "terms.tsx",
  "healthz.tsx",
];

describe("the embedded admin is one screen", () => {
  it("serves exactly the shell and one page under /app", () => {
    const embedded = routeFiles.filter((f) => f === "app.tsx" || f.startsWith("app._") || /^app\.[a-z]/.test(f));

    expect(embedded.sort()).toEqual(["app._index.tsx", "app.tsx"]);
  });

  it("has no screen that duplicates the cloud dashboard", () => {
    // The exact list that was removed. Named rather than inferred, so
    // re-adding one by the same name is an obvious failure.
    for (const gone of [
      "app.bookings.tsx",
      "app.bookings_.$id.tsx",
      "app.calendar.tsx",
      "app.customers.tsx",
      "app.resources.tsx",
      "app.resources_.$id.tsx",
      "app.services.tsx",
      "app.services_.$id.tsx",
      "app.settings.tsx",
      "app.setup.tsx",
      "app.timeoff.tsx",
      "app.waitlist.tsx",
    ]) {
      expect(routeFiles, `${gone} is back — that is a second admin`).not.toContain(gone);
    }
  });
});

describe("everything only this app can do is still routed", () => {
  it.each(MUST_KEEP)("still serves %s", (file) => {
    expect(routeFiles).toContain(file);
  });

  it("keeps the app proxy whole — the storefront widget calls every one of these", () => {
    const proxy = routeFiles.filter((f) => f.startsWith("apps.getbooqin."));
    expect(proxy.length).toBeGreaterThanOrEqual(16);
  });
});

describe("the one screen actually points somewhere", () => {
  const home = readFileSync(join(ROUTES_DIR, "app._index.tsx"), "utf8");
  const cloudRoutes = readFileSync(
    join(import.meta.dirname, "..", "..", "..", "cloud", "app", "routes.ts"),
    "utf8"
  );

  it("deep-links only to paths the cloud dashboard actually declares", () => {
    // The entire purpose of this screen is the links out of it. A
    // renamed route in the cloud app would otherwise turn every one of
    // them into a 404 with nothing failing anywhere.
    const linked = [...home.matchAll(/dashboard\("(\/[^"]*)"\)/g)].map((m) => m[1].replace(/^\//, ""));

    expect(linked.length).toBeGreaterThan(0);
    for (const path of linked) {
      expect(cloudRoutes, `the cloud dashboard has no "${path}" route`).toContain(`route("${path}"`);
    }
  });

  it("sends an unconnected store somewhere it can connect", () => {
    expect(home).toContain("/connect/shopify");
    expect(cloudRoutes).toContain('route("connect/shopify"');
  });

  it("opens the dashboard in a new tab, not inside Shopify's iframe", () => {
    // Replacing the admin iframe with our own dashboard strands the
    // merchant in a page wearing Shopify's chrome with no way back.
    const links = home.match(/<Button[^>]*url=\{dashboard\([^)]*\)\}[^>]*>/gs) ?? [];
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toContain('target="_blank"');
    }
  });
});
