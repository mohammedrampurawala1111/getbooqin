/**
 * Which Embedded Signup path a merchant took, and the one call that
 * must not happen on the wrong one.
 *
 * A coexistence number is already registered — to the merchant's own
 * WhatsApp Business app. Calling /register on it moves it onto the
 * Cloud API and signs them out of the app they run their business from.
 * There is no undo inside a working day. So the branch in finishSetup
 * is the highest-consequence line in this feature, and these tests
 * exist to keep it honest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../db.js";
import { modeFromSignupEvent } from "../embeddedSignup.js";
import { completeSignup, finishSetup } from "../accounts.js";

const RUN = Date.now();
const ownerId = `wa-mode-owner-${RUN}`;
const shop = `wa-mode-${RUN}`;
let connectionId: string;

beforeEach(async () => {
  process.env.META_APP_ID = "app-id";
  process.env.META_APP_SECRET = "app-secret";
  await prisma.user.create({ data: { id: ownerId, email: `${ownerId}@example.com` } });
  const conn = await prisma.connection.create({
    data: { userId: ownerId, platform: "manual", shop, credentials: "", status: "active" },
  });
  connectionId = conn.id;
});

afterEach(async () => {
  await prisma.whatsAppAccount.deleteMany({ where: { connectionId } });
  await prisma.connection.deleteMany({ where: { id: connectionId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
});

describe("modeFromSignupEvent", () => {
  it("reads coexistence from the business-app event", () => {
    expect(modeFromSignupEvent("FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING")).toBe("coexistence");
  });

  it.each(["FINISH", "FINISH_ONLY_WABA"])("reads classic from %s", (event) => {
    expect(modeFromSignupEvent(event)).toBe("classic");
  });

  it.each(["CANCEL", "ERROR", "", "SOMETHING_NEW"])("refuses to guess for %p", (event) => {
    // Guessing "classic" for an event we don't know would register a
    // number Meta never told us to.
    expect(modeFromSignupEvent(event)).toBeNull();
  });
});

/**
 * A fetch stub that records every Graph path called, so a test can
 * assert on what was *not* requested — which is the point here.
 */
function stubGraph(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const impl = vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    calls.push(path);

    const body =
      Object.entries(overrides).find(([fragment]) => path.includes(fragment))?.[1] ??
      (path.includes("oauth/access_token")
        ? { access_token: "token-from-meta" }
        : path.includes("/phone_numbers")
          ? { data: [{ id: "pn-from-waba", display_phone_number: "+91 98765 43210", verified_name: "Salon" }] }
          : { id: "pn-1", display_phone_number: "+91 98765 43210", verified_name: "Salon", quality_rating: "GREEN" });

    return new Response(JSON.stringify(body), { status: 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("coexistence keeps the merchant's app", () => {
  it("never calls /register", async () => {
    const { impl, calls } = stubGraph();

    await completeSignup({ connectionId, code: "c", wabaId: "waba-1", mode: "coexistence" }, impl);

    expect(calls.some((path) => path.endsWith("/register"))).toBe(false);
  });

  it("still subscribes the app, or nothing would ever come back", async () => {
    const { impl, calls } = stubGraph();

    await completeSignup({ connectionId, code: "c", wabaId: "waba-1", mode: "coexistence" }, impl);

    expect(calls.some((path) => path.endsWith("/subscribed_apps"))).toBe(true);
  });

  it("resolves the number from the WABA, since the event carries only waba_id", async () => {
    const { impl, calls } = stubGraph();

    const account = await completeSignup({ connectionId, code: "c", wabaId: "waba-1", mode: "coexistence" }, impl);

    expect(calls.some((path) => path.endsWith("/phone_numbers"))).toBe(true);
    expect(account.phoneNumberId).toBe("pn-from-waba");
    expect(account.status).toBe("active");
  });

  it("records the mode, so a later retry cannot register the number by accident", async () => {
    // finishSetup is a button on the Settings screen. It reads the mode
    // off the row rather than being told again, so the stored value is
    // what protects the app on every subsequent retry.
    const { impl } = stubGraph();
    const account = await completeSignup({ connectionId, code: "c", wabaId: "waba-1", mode: "coexistence" }, impl);
    expect(account.onboardingMode).toBe("coexistence");

    const retry = stubGraph();
    await finishSetup(account.id, retry.impl);

    expect(retry.calls.some((path) => path.endsWith("/register"))).toBe(false);
  });

  it("fails clearly when the WABA has no number on it yet", async () => {
    const { impl } = stubGraph({ "/phone_numbers": { data: [] } });

    await expect(
      completeSignup({ connectionId, code: "c", wabaId: "waba-1", mode: "coexistence" }, impl)
    ).rejects.toThrow(/no phone number/i);
  });
});

describe("classic takes the number onto the API", () => {
  it("registers the number, which is what that path is for", async () => {
    const { impl, calls } = stubGraph();

    await completeSignup(
      { connectionId, code: "c", wabaId: "waba-1", phoneNumberId: "pn-1", mode: "classic" },
      impl
    );

    expect(calls.some((path) => path.endsWith("/register"))).toBe(true);
  });

  it("uses the number Meta named rather than looking one up", async () => {
    const { impl, calls } = stubGraph();

    const account = await completeSignup(
      { connectionId, code: "c", wabaId: "waba-1", phoneNumberId: "pn-1", mode: "classic" },
      impl
    );

    expect(account.phoneNumberId).toBe("pn-1");
    expect(calls.some((path) => path.endsWith("/phone_numbers"))).toBe(false);
  });
});
