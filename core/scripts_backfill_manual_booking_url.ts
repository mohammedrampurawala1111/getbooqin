// One-off backfill for connections that went live before onboarding.tsx's
// handleGoLive started pinning booking_page_url to the real public booking
// page (see routes/book.$connectionId.tsx). Every manual connection created
// before that fix has booking_page_url still at defaultSettings()'s
// `https://${shop}` fallback — for a manual connection `shop` is an opaque
// manual-<uuid> key, not a reachable domain, so every confirmation/cancel
// email's manage link (Bookings.manageUrl) has been pointing nowhere.
//
// Run once after the code fix ships, from core/: APP_URL=https://getbooqin.fly.dev npx tsx scripts_backfill_manual_booking_url.ts
import prisma from "./src/db.js";
import * as Settings from "./src/booking/settings.js";

const BROKEN_DEFAULT_RE = /^https:\/\/manual-/;

async function main() {
  const appUrl = process.env.APP_URL;
  if (!appUrl) throw new Error("APP_URL is not set");

  const connections = await prisma.connection.findMany({ where: { platform: "manual" } });
  let fixed = 0;

  for (const connection of connections) {
    const settings = await Settings.getSettings(connection.shop, connection.platform);
    // Only touch rows still on the broken default — a merchant who has
    // already set their own booking_page_url (however unlikely today, since
    // cloud's settings page has no field for it yet) keeps their value.
    if (!BROKEN_DEFAULT_RE.test(settings.booking_page_url)) continue;

    await Settings.setSettings(connection.shop, connection.platform, {
      booking_page_url: `${appUrl}/book/${connection.id}`,
    });
    fixed++;
  }

  console.log(`Backfilled booking_page_url for ${fixed} of ${connections.length} manual connection(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
