/**
 * Lifecycle emails — the exactly-once bookkeeping.
 *
 * Real Postgres, because the whole mechanism *is* a unique index: the
 * trial sweep runs every ten minutes, and the only thing standing
 * between a merchant and 432 copies of "your trial ends in 3 days" is
 * that constraint. Mocking it out would test nothing.
 *
 * nodemailer is mocked so the sends are observable and no SMTP server
 * is needed.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn().mockResolvedValue({ messageId: "1", accepted: [], rejected: [], response: "ok" });
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail }) } }));

const prisma = (await import("../db.js")).default;
const Lifecycle = await import("../lifecycle.js");

const RUN = Date.now();
const STARTED = new Date();
const userId = `usr-lifecycle-${RUN}`;
const ownerEmail = `usr-lifecycle-${RUN}@example.com`;
const shop = `lifecycle-test-${RUN}`;
let connectionId = "";

const DAY = 86_400_000;

async function subscription(trialEndsAt: Date | null, status = "trialing") {
  await prisma.subscription.upsert({
    where: { connectionId },
    create: { connectionId, plan: "growth", status, trialEndsAt },
    update: { plan: "growth", status, trialEndsAt },
  });
}

/**
 * Only this account's emails.
 *
 * runTrialNudges() sweeps the whole database, and a dev database has
 * other accounts in it — several with trials ending the same week,
 * seeded by earlier QA runs. Asserting on `calls[0]` reads whichever of
 * them happened to sort first, which is how a test passes for the wrong
 * reason.
 */
function ours(): { to: string; subject: string; text: string }[] {
  return sendMail.mock.calls
    .map((c) => c[0] as { to: string; subject: string; text: string })
    .filter((m) => m.to === ownerEmail);
}

beforeEach(async () => {
  sendMail.mockClear();
  process.env.SMTP_HOST = "smtp.example.com";
  process.env.MAIL_FROM_EMAIL = "notify@getbooqin.com";
  process.env.APP_URL = "https://app.example.com";
  if (connectionId) await prisma.lifecycleEmail.deleteMany({ where: { connectionId } });
});

afterAll(async () => {
  // Including the claims the sweep burnt on this database's other
  // accounts — the sweep is global, and leaving those behind would mean
  // a real account here never gets its trial email.
  await prisma.lifecycleEmail.deleteMany({ where: { sentAt: { gte: STARTED } } });
  await prisma.lifecycleEmail.deleteMany({ where: { connectionId } });
  await prisma.subscription.deleteMany({ where: { connectionId } });
  await prisma.connection.deleteMany({ where: { id: connectionId } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

describe("setup", () => {
  it("creates an account to send to", async () => {
    await prisma.user.create({ data: { id: userId, email: ownerEmail } });
    const connection = await prisma.connection.create({
      data: { userId, platform: "manual", shop, credentials: "", status: "active" },
    });
    connectionId = connection.id;
    expect(connectionId).toBeTruthy();
  });
});

describe("each email is sent exactly once", () => {
  it("sends the welcome the first time and never again", async () => {
    expect(await Lifecycle.sendWelcome(connectionId)).toBe(true);
    expect(await Lifecycle.sendWelcome(connectionId)).toBe(false);
    expect(await Lifecycle.sendWelcome(connectionId)).toBe(false);

    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("holds under concurrency — the index decides, not a read-then-write", async () => {
    // Two app machines, or a double-clicked "Go live".
    const results = await Promise.all([
      Lifecycle.sendWelcome(connectionId),
      Lifecycle.sendWelcome(connectionId),
      Lifecycle.sendWelcome(connectionId),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("gives the claim back when the send fails, so the next attempt retries", async () => {
    // The alternative — marking it sent regardless — loses the email
    // permanently on one bad SMTP minute.
    sendMail.mockRejectedValueOnce(new Error("smtp down"));

    await expect(Lifecycle.sendWelcome(connectionId)).rejects.toThrow("smtp down");
    expect(await prisma.lifecycleEmail.count({ where: { connectionId, kind: "welcome" } })).toBe(0);

    expect(await Lifecycle.sendWelcome(connectionId)).toBe(true);
  });
});

describe("the trial sweep", () => {
  it("nudges a trial inside the three-day window, once", async () => {
    const endsAt = new Date(Date.now() + 2 * DAY);
    await subscription(endsAt);

    await Lifecycle.runTrialNudges();
    // The next tick, ten minutes later, and the 431 after that.
    await Lifecycle.runTrialNudges();

    expect(ours()).toHaveLength(1);
    expect(ours()[0].subject).toMatch(/trial ends on/);
  });

  it("leaves a trial with weeks to run completely alone", async () => {
    await subscription(new Date(Date.now() + 20 * DAY));

    await Lifecycle.runTrialNudges();

    expect(ours()).toHaveLength(0);
  });

  it("sends the ended email once the trial is over", async () => {
    await subscription(new Date(Date.now() - 1 * DAY));

    await Lifecycle.runTrialNudges();

    expect(ours()).toHaveLength(1);
    expect(ours()[0].subject).toMatch(/trial has ended/);
  });

  it("does not send a warning about a trial that has already ended", async () => {
    // An account whose trial lapsed before this sweep ever ran. "Your
    // trial ends in 3 days" about a date in the past is worse than
    // silence.
    await subscription(new Date(Date.now() - 5 * DAY));
    await Lifecycle.runTrialNudges();

    expect(ours()).toHaveLength(1);
    expect(ours()[0].subject).not.toMatch(/ends on/);
    // And the warning is burnt, so a clock change can't resurrect it.
    expect(await prisma.lifecycleEmail.count({ where: { connectionId, kind: "trial_ending" } })).toBe(1);
  });

  it("ignores an account that has already paid", async () => {
    await subscription(new Date(Date.now() - 1 * DAY), "active");

    await Lifecycle.runTrialNudges();

    expect(ours()).toHaveLength(0);
  });

  it("carries on when one account's email fails", async () => {
    // One bad address must not stop everyone else's trial nudge — the
    // sweep is a loop, and an unhandled throw in it is a silent outage
    // for every account after the broken one.
    await subscription(new Date(Date.now() + 1 * DAY));
    // This account specifically, not "whichever send happens first".
    sendMail.mockImplementationOnce(async (message: { to: string }) => {
      if (message.to === ownerEmail) throw new Error("mailbox full");
      return { messageId: "1", accepted: [], rejected: [], response: "ok" };
    });

    const result = await Lifecycle.runTrialNudges();

    // Resolved, not thrown — and this account is not counted as sent.
    expect(result.ending_sent + result.ended_sent).toBeGreaterThanOrEqual(0);
    expect(await prisma.lifecycleEmail.count({ where: { connectionId, kind: "trial_ending" } })).toBe(0);
  });
});

describe("what the trial emails actually say", () => {
  it("names the date the trial ends, not 'soon'", async () => {
    await subscription(new Date("2026-10-12T09:00:00Z"));
    // Fixed 'now' so the window maths is not tied to today's date.
    await Lifecycle.runTrialNudges(new Date("2026-10-10T09:00:00Z"));

    expect(ours()[0].subject).toContain("12 October");
    expect(ours()[0].text).toContain("12 October");
  });

  it("says plainly that nothing is deleted", async () => {
    // The single most common reason someone panics at a trial-end email
    // is thinking their data goes with it.
    await subscription(new Date(Date.now() + 1 * DAY));
    await Lifecycle.runTrialNudges();

    expect(ours()[0].text).toMatch(/[Nn]othing is deleted/);
  });

  it("sends to the account owner's login address", async () => {
    await subscription(new Date(Date.now() + 1 * DAY));
    await Lifecycle.runTrialNudges();

    expect(ours()).toHaveLength(1);
  });
});
