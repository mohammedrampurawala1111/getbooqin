import type { LoaderFunctionArgs } from "react-router";
import { Jobs, prisma } from "getbooqin-core";

/**
 * Phase 0 / B4 — the endpoint health checks and uptime monitors watch.
 *
 * Deliberately not `/`: that route is Shopify's embedded-app launch
 * target and renders a full page, so a 200 from it says the web server
 * answered, not that anything behind it works.
 *
 * ## Two questions, two callers, and why they can't share a status code
 *
 * "Can this machine serve requests?" and "is the product actually
 * working?" are different questions with different right answers, and
 * conflating them is how a healthy deploy gets rolled back.
 *
 *   • **Liveness** (default) — 503 only when the database is
 *     unreachable. This is what Fly's own http_service check and any
 *     load balancer should watch. A stale reminder cron must NOT fail
 *     it: the machine is serving bookings perfectly well, and pulling it
 *     out of rotation (or aborting a deploy) over a background job that
 *     hasn't run would turn a background problem into an outage.
 *
 *   • **Strict** (`?strict=1`) — also 503 when a scheduled job has gone
 *     stale. This is what an external uptime monitor should watch,
 *     because a page is exactly the right response there. Reminder
 *     emails are sold on every tier including free, and a sweep that
 *     stops looks identical to a quiet hour — nothing else anywhere
 *     would notice. See core/src/jobs.ts.
 *
 * Both report the same body, so the `degraded` flag and per-job detail
 * are visible either way; only the status code differs.
 *
 * Unauthenticated on purpose, so it can be watched without sharing
 * CRON_SECRET with a third party. It exposes timestamps and counts, and
 * a job's last error message — nothing tenant-scoped.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const strict = new URL(request.url).searchParams.get("strict") === "1";

  const checks: Record<string, unknown> = {};
  let live = true;
  let degraded = false;

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch (error) {
    live = false;
    checks.database = error instanceof Error ? error.message : "unreachable";
  }

  try {
    const jobs = await Jobs.statuses();
    checks.jobs = jobs.map((job) => ({
      name: job.name,
      stale: job.stale,
      last_success_at: job.lastSuccessAt?.toISOString() ?? null,
      minutes_since_success: job.minutesSinceSuccess,
      run_count: job.runCount,
      failure_count: job.failureCount,
      last_error: job.lastError,
    }));
    if (jobs.some((job) => job.stale)) degraded = true;
  } catch (error) {
    // The jobs query failing when `SELECT 1` succeeded means the schema
    // is wrong, not the connection — a real problem, but still not one
    // that stops this machine serving bookings.
    degraded = true;
    checks.jobs = error instanceof Error ? error.message : "unavailable";
  }

  const ok = live && (!strict || !degraded);

  return Response.json(
    { ok, live, degraded, checks },
    {
      status: ok ? 200 : 503,
      // Never let a CDN or proxy answer a health check from cache.
      headers: { "Cache-Control": "no-store" },
    }
  );
}
