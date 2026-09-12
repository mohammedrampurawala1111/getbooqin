// One-off backfill for Phase 2a: every Connection that predates billing
// gets a Subscription row.
//
// ## What existing accounts get, and why it's a decision
//
// The default here is **the same 30-day Growth trial a new signup gets**,
// starting the day this runs. That is the least surprising thing to do
// and it needs no explaining to anyone — but it is a *choice*, and the
// plan's own risk list calls it out: an account that has been using the
// product for months arguably deserves better than a new signup, and the
// honest alternative is a dated comp ("Growth, free, for 12 months,
// because you were here before we charged").
//
// If you want that instead, don't edit this script — grant it per account
// from /admin, where the audit log records who did it and why. That is
// exactly what the admin plan-override mechanism is for, and six months
// from now "why is this account free?" will have an answer.
//
// Idempotent: ensureSubscription() is a no-op for a connection that
// already has a row, so this is safe to run on every deploy and safe to
// run twice.
//
//   DATABASE_URL=... npx tsx scripts_backfill_subscriptions.ts
import prisma from "./src/db.js";
import { ensureSubscription } from "./src/billing/subscriptions.js";
import { TRIAL_DAYS, TRIAL_PLAN } from "./src/billing/entitlements.js";

async function main() {
  const connections = await prisma.connection.findMany({
    where: { status: "active" },
    select: { id: true, shop: true, platform: true },
    orderBy: { createdAt: "asc" },
  });

  let created = 0;
  let skipped = 0;

  for (const connection of connections) {
    const before = await prisma.subscription.findUnique({ where: { connectionId: connection.id } });
    if (before) {
      skipped += 1;
      continue;
    }
    await ensureSubscription(connection.id);
    created += 1;
    console.log(
      `[backfill-subscriptions] ${connection.platform}/${connection.shop}: ${TRIAL_PLAN} trial, ${TRIAL_DAYS} days`
    );
  }

  console.log(
    `[backfill-subscriptions] done — ${created} created, ${skipped} already had one, ${connections.length} total`
  );
}

main()
  .catch((err) => {
    console.error("[backfill-subscriptions] failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
