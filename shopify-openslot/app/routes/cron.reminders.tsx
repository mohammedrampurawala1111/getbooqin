import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Mailer, ChatFlow } from "getbooqin-core";

/**
 * There is no WP-Cron here. Point an external scheduler (GitHub Actions on a
 * schedule trigger, cron-job.org, Fly.io Machines schedule, a Vercel Cron
 * Job…) at this route, hourly, with:
 *
 *   Authorization: Bearer <CRON_SECRET>
 *
 * See DEVELOPERS.md for a ready-to-use GitHub Actions workflow.
 */
async function run(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization") || "";

  if (!secret || auth !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const [reminders, cleanup] = await Promise.all([Mailer.sendReminders(), ChatFlow.cleanup()]);

  return new Response(JSON.stringify({ ok: true, reminders_sent: reminders.sent, conversations_deleted: cleanup.deleted }), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  return run(request);
}

export async function loader({ request }: LoaderFunctionArgs) {
  return run(request);
}
