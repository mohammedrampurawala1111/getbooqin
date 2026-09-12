/**
 * Phase 0 / B1 — scheduled-job bookkeeping.
 *
 * The two properties that matter and that nothing had before: a sweep
 * that stops running becomes visible, and two sweeps can't run at once
 * and send the same customer the same reminder twice. Both are about
 * concurrency and clock arithmetic against the real JobRun row, so this
 * runs against Postgres rather than a mocked client.
 */
import { afterEach, describe, expect, it } from "vitest";
import prisma from "../db.js";
import * as Jobs from "../jobs.js";

afterEach(async () => {
  await prisma.jobRun.deleteMany({ where: { name: "reminders" } });
});

describe("job leasing (B1)", () => {
  it("lets exactly one of several simultaneous sweeps through", async () => {
    let ran = 0;
    const sweep = () =>
      Jobs.record("reminders", async () => {
        ran += 1;
        // Long enough that the others are certainly inside the window.
        await new Promise((r) => setTimeout(r, 30));
        return { reminders_sent: 1 };
      });

    const outcomes = await Promise.all([sweep(), sweep(), sweep(), sweep()]);

    expect(ran).toBe(1);
    expect(outcomes.filter((o) => o.ran)).toHaveLength(1);
    for (const declined of outcomes.filter((o) => !o.ran)) {
      expect(declined).toMatchObject({ ran: false });
    }
  });

  it("lets the next scheduled tick through once the lease has expired", async () => {
    await Jobs.record("reminders", async () => ({ reminders_sent: 0 }));

    // The in-process scheduler ticks every 10 minutes and the lease is 5,
    // so a normally-spaced tick must never be turned away. Rewind the row
    // rather than waiting five minutes for it.
    await prisma.jobRun.update({
      where: { name: "reminders" },
      data: { lastRunAt: new Date(Date.now() - 10 * 60_000) },
    });

    const outcome = await Jobs.record("reminders", async () => ({ reminders_sent: 2 }));
    expect(outcome).toMatchObject({ ran: true, result: { reminders_sent: 2 } });
  });

  it("releases nothing on failure but records it, and re-throws untouched", async () => {
    const boom = new Error("SMTP refused the connection");
    await expect(
      Jobs.record("reminders", async () => {
        throw boom;
      })
    ).rejects.toBe(boom);

    const status = await Jobs.status("reminders");
    expect(status.failureCount).toBe(1);
    expect(status.lastError).toBe("SMTP refused the connection");
    expect(status.lastFailureAt).toBeInstanceOf(Date);
    // It ran — it just ran badly. Both have to be distinguishable, or a
    // job failing every hour reads the same as a job that isn't running.
    expect(status.lastRunAt).toBeInstanceOf(Date);
    expect(status.lastSuccessAt).toBeNull();
    expect(status.stale).toBe(true);
  });

  it("clears a previous failure once a run succeeds again", async () => {
    await Jobs.record("reminders", async () => {
      throw new Error("transient");
    }).catch(() => {});
    await prisma.jobRun.update({
      where: { name: "reminders" },
      data: { lastRunAt: new Date(Date.now() - 10 * 60_000) },
    });
    await Jobs.record("reminders", async () => ({ reminders_sent: 3 }));

    const status = await Jobs.status("reminders");
    expect(status.lastError).toBeNull();
    expect(status.lastResult).toBe(JSON.stringify({ reminders_sent: 3 }));
    expect(status.failureCount).toBe(1);
    expect(status.runCount).toBe(2);
    expect(status.stale).toBe(false);
  });
});

describe("staleness (B1)", () => {
  it("reports a job that has never run as stale, not as unknown", async () => {
    const status = await Jobs.status("reminders");

    expect(status.lastRunAt).toBeNull();
    expect(status.minutesSinceSuccess).toBeNull();
    // The whole point: "no data" is the state a never-scheduled cron is
    // in, and it must not read as healthy.
    expect(status.stale).toBe(true);
  });

  it("tolerates a late run without crying wolf, but not a missed one", async () => {
    await Jobs.record("reminders", async () => ({ reminders_sent: 0 }));

    // The sweep runs every 10 minutes. A deploy replacing machines, or a
    // single failed tick, can push the last success out past that
    // without anything being wrong.
    await prisma.jobRun.update({
      where: { name: "reminders" },
      data: { lastSuccessAt: new Date(Date.now() - 25 * 60_000) },
    });
    expect((await Jobs.status("reminders")).stale).toBe(false);

    // Three consecutive missed ticks is not a hiccup.
    await prisma.jobRun.update({
      where: { name: "reminders" },
      data: { lastSuccessAt: new Date(Date.now() - 45 * 60_000) },
    });
    expect((await Jobs.status("reminders")).stale).toBe(true);
  });

  it("lists every known job so the admin tile can't silently omit one", async () => {
    const all = await Jobs.statuses();
    expect(all.map((j) => j.name).sort()).toEqual(Object.keys(Jobs.JOBS).sort());
  });
});
