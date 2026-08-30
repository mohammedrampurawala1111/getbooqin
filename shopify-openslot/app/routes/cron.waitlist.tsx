import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Waitlist } from "getbooqin-core";

/**
 * Expires stale waitlist offers and cascades each one to the next matching
 * candidate. Deliberately a separate cron from cron.reminders.tsx: offer
 * windows can be as short as 30 minutes (see presets.ts's
 * waitlist_offer_window_hours), so this needs scheduling far more often
 * than the hourly reminders sweep — every 5-10 minutes is a reasonable
 * starting point. Same external-scheduler + CRON_SECRET pattern, see
 * cron.reminders.tsx and DEVELOPERS.md.
 */
async function run(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization") || "";

  if (!secret || auth !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await Waitlist.expireStaleOffers();

  return new Response(JSON.stringify({ ok: true, ...result }), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  return run(request);
}

export async function loader({ request }: LoaderFunctionArgs) {
  return run(request);
}
