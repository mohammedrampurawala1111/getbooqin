/**
 * The environment contract.
 *
 * The property worth testing is the distinction the file exists for:
 * refusing to boot over a missing session secret, and *not* refusing
 * over a missing Sentry DSN. A check that blocks a deploy for telemetry
 * gets deleted by the third person who hits it, and then nothing checks
 * anything.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_VARS, checkEnvironment, assertEnvironment, productionWarnings } from "../env.js";

const SAVED = { ...process.env };

/** Sets every declared variable, so a test can remove exactly one. */
function fullyConfigured() {
  for (const v of ENV_VARS) process.env[v.name] = `set-${v.name}`;
}

beforeEach(() => {
  for (const v of ENV_VARS) delete process.env[v.name];
});

afterEach(() => {
  for (const v of ENV_VARS) delete process.env[v.name];
  Object.assign(process.env, SAVED);
});

describe("what stops a boot", () => {
  it("refuses when a required variable is missing", () => {
    fullyConfigured();
    delete process.env.SESSION_SIGNING_SECRET;

    expect(() => assertEnvironment(() => {})).toThrow(/SESSION_SIGNING_SECRET/);
  });

  it("names every missing required variable at once, not the first", () => {
    // Four deploys that each fail naming one more secret is the
    // experience this replaces.
    fullyConfigured();
    delete process.env.DATABASE_URL;
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.APP_URL;

    const error = (() => {
      try {
        assertEnvironment(() => {});
        return null;
      } catch (e) {
        return e as Error;
      }
    })();

    expect(error?.message).toContain("DATABASE_URL");
    expect(error?.message).toContain("CLERK_SECRET_KEY");
    expect(error?.message).toContain("APP_URL");
    expect(error?.message).toContain("3 required");
  });

  it("treats an empty string as missing", () => {
    // `fly secrets set FOO=` is a real way to end up here, and an empty
    // connection string fails later and less clearly.
    fullyConfigured();
    process.env.DATABASE_URL = "   ";

    expect(() => assertEnvironment(() => {})).toThrow(/DATABASE_URL/);
  });
});

describe("what does not stop a boot", () => {
  it("starts without Sentry, and says error reporting is off", () => {
    fullyConfigured();
    delete process.env.SENTRY_DSN;

    const lines: string[] = [];
    expect(() => assertEnvironment((l) => lines.push(l))).not.toThrow();
    expect(lines.join("\n")).toMatch(/error reporting/);
  });

  it("starts without either payment rail, naming both", () => {
    // A deployment that cannot take money is a real thing to run — a
    // staging environment is exactly that — but it must not be a
    // surprise.
    fullyConfigured();
    for (const v of ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]) {
      delete process.env[v];
    }

    const lines: string[] = [];
    expect(() => assertEnvironment((l) => lines.push(l))).not.toThrow();
    expect(lines.join("\n")).toMatch(/Razorpay rail/);
    expect(lines.join("\n")).toMatch(/PayPal rail/);
  });

  it("reports one lost capability per problem, not one per variable", () => {
    // Both Razorpay keys missing is one broken rail, not two findings.
    fullyConfigured();
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;

    const rail = checkEnvironment().lostCapabilities.filter((c) => c.capability.includes("Razorpay rail"));
    expect(rail).toHaveLength(1);
    expect(rail[0].vars).toEqual(["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"]);
  });

  it("says so plainly when everything is configured", () => {
    fullyConfigured();

    const lines: string[] = [];
    assertEnvironment((l) => lines.push(l));

    expect(lines.join("\n")).toContain("fully configured");
  });
});

describe("the list itself", () => {
  it("declares a capability for every non-required variable", () => {
    // Without one the boot log would say a variable is missing without
    // saying what that costs, which is the part anyone actually needs.
    for (const v of ENV_VARS.filter((v) => v.requirement === "capability")) {
      expect(v.capability, v.name).toBeTruthy();
    }
  });

  it("declares each variable once", () => {
    const names = ENV_VARS.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("covers the secrets the app actually reads", () => {
    // A spot check against the real consumers, so a new secret added in
    // passing is noticed here rather than in production.
    const names = new Set(ENV_VARS.map((v) => v.name));
    for (const expected of [
      "DATABASE_URL",
      "CLERK_SECRET_KEY",
      "CONNECTION_ENCRYPTION_KEY",
      "RAZORPAY_WEBHOOK_SECRET",
      "PAYPAL_WEBHOOK_ID",
      "INVOICE_LEGAL_NAME",
      "PLATFORM_ADMIN_EMAILS",
      "SMTP_HOST",
    ]) {
      expect(names, expected).toContain(expected);
    }
  });
});

describe("configured, but configured with a rehearsal", () => {
  /**
   * The property under test is that these are invisible to
   * checkEnvironment(): every one of them is a variable that is *set*.
   * A test that only asserted the warning fires would still pass if the
   * two checks were merged, which is the design mistake worth guarding.
   */
  const PRODUCTION: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    VITE_CLERK_PUBLISHABLE_KEY: "pk_live_abc",
    CLERK_SECRET_KEY: "sk_live_abc",
    APP_URL: "https://app.getbooqin.com",
    RAZORPAY_KEY_ID: "rzp_live_abc",
    PAYPAL_CLIENT_ID: "paypal-id",
    PAYPAL_ENV: "live",
    MAIL_FROM_EMAIL: "notify@getbooqin.com",
  };

  it("says nothing when production really is production", () => {
    expect(productionWarnings(PRODUCTION)).toEqual([]);
  });

  it("stays quiet outside production, where test keys are the point", () => {
    const dev = { ...PRODUCTION, NODE_ENV: "development", RAZORPAY_KEY_ID: "rzp_test_abc" };
    expect(productionWarnings(dev)).toEqual([]);
  });

  it.each([
    ["a Clerk development instance", { VITE_CLERK_PUBLISHABLE_KEY: "pk_test_abc" }, /Clerk is a development instance/],
    ["a Clerk development secret", { CLERK_SECRET_KEY: "sk_test_abc" }, /development key/],
    ["a fly.dev public origin", { APP_URL: "https://getbooqin.fly.dev" }, /isn't yours/],
    ["Razorpay in test mode", { RAZORPAY_KEY_ID: "rzp_test_abc" }, /no money moves/],
    ["PayPal in sandbox", { PAYPAL_ENV: "sandbox" }, /no money moves/],
    ["a relay's own From address", { MAIL_FROM_EMAIL: "b675ff001@smtp-brevo.com" }, /unaligned/],
  ])("warns about %s", (_label, override, expected) => {
    const warnings = productionWarnings({ ...PRODUCTION, ...override });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.problem).toMatch(expected);
    // Every warning has to name the action, not just the state.
    expect(warnings[0]!.fix.length).toBeGreaterThan(20);
  });

  it("is invisible to checkEnvironment, which is the whole problem", () => {
    // A deployment holding nothing but sandbox credentials is
    // "fully configured" by the missing-variable check. If this ever
    // fails, the two checks have been merged and the launch blocker
    // this file exists for is being reported as a missing secret.
    fullyConfigured();
    process.env.NODE_ENV = "production";
    process.env.RAZORPAY_KEY_ID = "rzp_test_abc";
    process.env.APP_URL = "https://getbooqin.fly.dev";

    expect(checkEnvironment().ok).toBe(true);
    expect(checkEnvironment().lostCapabilities).toEqual([]);
    expect(productionWarnings()).not.toEqual([]);
  });

  it("never stops a boot over a rehearsal credential", () => {
    fullyConfigured();
    process.env.NODE_ENV = "production";
    process.env.RAZORPAY_KEY_ID = "rzp_test_abc";

    expect(() => assertEnvironment(() => {})).not.toThrow();
  });

  it("logs the problem and its fix, so the line is actionable on its own", () => {
    fullyConfigured();
    process.env.NODE_ENV = "production";
    process.env.APP_URL = "https://getbooqin.fly.dev";

    const lines: string[] = [];
    assertEnvironment((l) => lines.push(l));

    expect(lines.some((l) => l.includes("NOT PRODUCTION-READY"))).toBe(true);
    expect(lines.some((l) => l.includes("fly certs add"))).toBe(true);
  });
});
