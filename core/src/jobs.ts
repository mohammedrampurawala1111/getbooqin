/**
 * Phase 0 / B1 — scheduled-job bookkeeping and the reminder sweep itself.
 *
 * ## What was actually wrong
 *
 * The trim plan reported that nothing schedules reminders and that they
 * never fire in production. That's half right, and the half that's wrong
 * matters. `server/combined.js` — the production entrypoint — has always
 * run `Mailer.sendReminders()` on a 10-minute in-process interval, so
 * reminders do go out. What the plan's audit found was that the *other*
 * trigger, `/cron/reminders`, has no scheduler pointed at it, which is
 * true — and, given the interval already exists, not the actual problem.
 *
 * The real defects that leaves are three, and they're the ones this
 * module fixes:
 *
 * 1. **Nothing records that a sweep happened.** A working reminder sweep
 *    and a dead one look identical from outside, because most hours have
 *    nothing to send — "no reminder emails today" is the normal, healthy
 *    output. If the interval died with the process, or threw every tick,
 *    nobody would find out until a customer missed an appointment. That's
 *    the failure the whole item exists to prevent, and a schedule alone
 *    doesn't prevent it.
 *
 * 2. **Two sweeps can run at once, and send twice.** `sendReminders()`
 *    reads `reminderSent: false` rows and only flips the flag *after* a
 *    successful send, so two overlapping sweeps both pick up the same
 *    booking and the customer gets the reminder twice. Today that needs
 *    two app machines (`min_machines_running` is 1, so it hasn't bitten
 *    yet) or someone calling `/cron/reminders` by hand while the interval
 *    ticks. The moment this scales past one machine it is guaranteed.
 *
 * 3. **The two triggers did different work** — the route also ran an
 *    expired-chat-conversation cleanup, the interval didn't. (That
 *    cleanup has since gone with the chat widget itself, in Phase 1's
 *    trim, but the two triggers still share one definition so they
 *    cannot drift again.)
 *
 * ## The shape of the fix
 *
 * `runReminders()` is the single definition of the sweep; both the
 * interval and the route call it, so they can't drift again. `record()`
 * wraps any job in a claim-then-report cycle: the claim is an atomic
 * conditional UPDATE that doubles as a short lease, so a second sweep
 * arriving inside the lease window declines to run rather than
 * duplicating the first one's emails; the report writes success or
 * failure to the same row either way. `statuses()` turns those rows into
 * `/healthz?strict=1` and, later, the admin console's health tile (§W8) —
 * where a job that has stopped running, or never started, reads as stale.
 *
 * ## On there being no external scheduler
 *
 * There is deliberately no second trigger right now: the in-process
 * interval is the only thing that fires the sweep, and `/cron/reminders`
 * exists for manual runs and for whatever scheduler gets pointed at it
 * later. That is a supportable position *because* of the recording
 * above — an external cron's real value was never the redundant
 * invocation, it was being the one signal that originates outside the
 * app process. `/healthz?strict=1` provides that signal directly, to
 * any uptime monitor, without a scheduler: if the interval dies with the
 * process, or the app wedges, the row stops advancing and the check goes
 * red. Adding a scheduler back later needs no code change — the lease
 * already makes two triggers safe to run together.
 */
import prisma from "./db.js";
import * as Mailer from "./booking/mailer.js";

/** Every job this module knows about, with how often it's expected to run. */
export const JOBS = {
  /** Reminder emails. See runReminders(). */
  reminders: {
    label: "Reminder emails",
    /**
     * Matches REMINDER_INTERVAL_MS in server/combined.js, which is the
     * only thing that fires this. If a scheduler is ever pointed at
     * /cron/reminders on a slower cadence, this is the number that has
     * to move — it is what "stale" is measured against.
     */
    expectedEveryMinutes: 10,
    /**
     * How long a claim holds off another run of the same job. Longer than
     * a sweep realistically takes, shorter than the 10-minute in-process
     * interval — so a genuinely-spaced next tick always gets through, and
     * only a *concurrent* one is turned away.
     */
     leaseSeconds: 300,
  },
} as const;

export type JobName = keyof typeof JOBS;

/**
 * How long past its expected interval a job may go before it counts as
 * stale, i.e. before /healthz?strict=1 starts returning 503.
 *
 * Sized to absorb the things that legitimately delay a tick — a deploy
 * replacing machines, a slow sweep, one failed run — without absorbing a
 * genuinely dead one. At a 10-minute interval that means two consecutive
 * misses trip it, and the alarm arrives within half an hour rather than
 * two and a half.
 *
 * This used to be 90 minutes on top of an hourly expectation, sized for
 * GitHub Actions' scheduling jitter back when an external cron was
 * planned. With the in-process interval as the only trigger there is no
 * jitter to absorb, and 150 minutes of silently dead reminders is far
 * too long to wait — especially now that this check is the *only*
 * out-of-process signal that the sweep is alive.
 */
const STALE_GRACE_MINUTES = 20;

/**
 * Either the job ran and this is what it returned, or another run held
 * the lease and this one stood down. Declining is a normal outcome, not
 * an error — callers should report it as a 200, not a failure.
 */
export type JobOutcome<T> = { ran: true; result: T } | { ran: false; reason: string };

export interface JobStatus {
  name: JobName;
  label: string;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastError: string | null;
  lastResult: string | null;
  runCount: number;
  failureCount: number;
  /** No successful run inside its expected interval plus the grace window — "never ran" included. */
  stale: boolean;
  /** Minutes since the last *successful* run, or null if there has never been one. */
  minutesSinceSuccess: number | null;
}

/** Keeps an admin-facing error message to one readable line. */
function summarise(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 500);
}

/**
 * Claims the right to run `name` now, atomically. Returns false when
 * another run claimed it less than `leaseSeconds` ago.
 *
 * One statement, deliberately: a read-then-write would have exactly the
 * race it is here to close. `ON CONFLICT … DO UPDATE … WHERE` updates
 * nothing when the lease is still held, so the affected-row count is the
 * answer. The lease lives in `lastRunAt` rather than a separate lock
 * column because "when did this last start" is the thing being written
 * anyway, and a lease that expires on its own can't be leaked by a
 * process that dies mid-sweep.
 */
async function claim(name: JobName, leaseSeconds: number): Promise<boolean> {
  const claimed = await prisma.$executeRaw`
    INSERT INTO "JobRun" ("name", "lastRunAt", "runCount", "failureCount", "createdAt", "updatedAt")
    VALUES (${name}, now(), 1, 0, now(), now())
    ON CONFLICT ("name") DO UPDATE
      SET "lastRunAt" = now(),
          "runCount"  = "JobRun"."runCount" + 1,
          "updatedAt" = now()
      WHERE "JobRun"."lastRunAt" < now() - make_interval(secs => ${leaseSeconds}::double precision)
  `;
  return claimed > 0;
}

/** Records how a claimed run ended. Never throws — see record(). */
async function report(
  name: JobName,
  outcome: { ok: true; result: unknown } | { ok: false; error: unknown }
): Promise<void> {
  try {
    await prisma.jobRun.update({
      where: { name },
      data: outcome.ok
        ? {
            lastSuccessAt: new Date(),
            lastError: null,
            lastResult: JSON.stringify(outcome.result ?? null).slice(0, 2000),
          }
        : {
            lastFailureAt: new Date(),
            lastError: summarise(outcome.error),
            failureCount: { increment: 1 },
          },
    });
  } catch (error) {
    // A job that did real work must not be reported as failed because the
    // audit row couldn't be written afterwards.
    console.error(`[getbooqin jobs] could not record the "${name}" run — the job itself was unaffected:`, error);
  }
}

/**
 * Claims `name`, runs `fn`, records the outcome, and returns what `fn`
 * returned. A thrown error is recorded and re-thrown unchanged — this
 * wrapper observes, it does not swallow.
 */
export async function record<T>(name: JobName, fn: () => Promise<T>): Promise<JobOutcome<T>> {
  if (!(await claim(name, JOBS[name].leaseSeconds))) {
    return { ran: false, reason: "another run of this job started less than a lease ago" };
  }

  try {
    const result = await fn();
    await report(name, { ok: true, result });
    return { ran: true, result };
  } catch (error) {
    await report(name, { ok: false, error });
    throw error;
  }
}

export interface RemindersResult {
  reminders_sent: number;
}

/**
 * The hourly (well — every ten minutes in process, hourly from outside)
 * housekeeping sweep. The single definition of it: `/cron/reminders` and
 * `server/combined.js`'s interval both go through here, so the two can't
 * drift apart the way they had (the route ran a chat-conversation
 * cleanup the interval didn't — see the header comment).
 *
 * Platform-agnostic — `sendReminders()` walks every booking in the
 * database, so manual (non-Shopify) accounts are covered too.
 */
export function runReminders(): Promise<JobOutcome<RemindersResult>> {
  return record("reminders", async () => {
    const reminders = await Mailer.sendReminders();
    return { reminders_sent: reminders.sent };
  });
}

/** Current state of one job, including "it has never run". */
export async function status(name: JobName): Promise<JobStatus> {
  const row = await prisma.jobRun.findUnique({ where: { name } });
  const spec = JOBS[name];

  const minutesSinceSuccess = row?.lastSuccessAt
    ? Math.floor((Date.now() - row.lastSuccessAt.getTime()) / 60_000)
    : null;

  return {
    name,
    label: spec.label,
    lastRunAt: row?.lastRunAt ?? null,
    lastSuccessAt: row?.lastSuccessAt ?? null,
    lastFailureAt: row?.lastFailureAt ?? null,
    lastError: row?.lastError ?? null,
    lastResult: row?.lastResult ?? null,
    runCount: row?.runCount ?? 0,
    failureCount: row?.failureCount ?? 0,
    // "Never ran" has to read as stale, not as "no data, probably fine" —
    // it is the single most likely state for this to be in.
    stale: minutesSinceSuccess === null || minutesSinceSuccess > spec.expectedEveryMinutes + STALE_GRACE_MINUTES,
    minutesSinceSuccess,
  };
}

/** Every known job's state, for the admin console's health section. */
export function statuses(): Promise<JobStatus[]> {
  return Promise.all((Object.keys(JOBS) as JobName[]).map(status));
}
