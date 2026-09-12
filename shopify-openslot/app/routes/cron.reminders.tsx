import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Jobs } from "getbooqin-core";

/**
 * External trigger for the housekeeping sweep (reminder emails + expired
 * chat-conversation cleanup). The sweep itself is Jobs.runReminders() —
 * `server/combined.js` runs the same function on a 10-minute in-process
 * interval, and the two used to be separate near-copies that had already
 * drifted (Phase 0's B1; see core/src/jobs.ts for the full finding).
 *
 * Nothing is currently scheduled against this route — the in-process
 * interval is what fires the sweep in production, and external
 * monitoring comes from /healthz?strict=1 rather than from a second
 * trigger (see core/src/jobs.ts). This stays for manual runs and for
 * whatever scheduler gets pointed at it later; the contract is a GET or
 * POST with:
 *
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Adding a scheduler back needs no code change here. Jobs.record()'s
 * lease already makes a second trigger safe: a call that lands while a
 * sweep is running is answered with `ran: false` and a 200, not
 * duplicate reminder emails and not an error.
 */
async function run(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization") || "";

  if (!secret || auth !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const outcome = await Jobs.runReminders();

    return Response.json(
      outcome.ran
        ? { ok: true, skipped: false, ...outcome.result }
        : { ok: true, skipped: true, reason: outcome.reason }
    );
  } catch (error) {
    // Jobs.record() has already written the failure to the JobRun row,
    // which is what /healthz?strict=1 reads. The 500 is for whoever
    // called this — a scheduler that treats a non-2xx as a failed run.
    console.error("[getbooqin cron] reminders sweep failed:", error);
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

export async function action({ request }: ActionFunctionArgs) {
  return run(request);
}

export async function loader({ request }: LoaderFunctionArgs) {
  return run(request);
}
