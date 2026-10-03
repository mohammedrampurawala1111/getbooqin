// One-off backfill for the 10-01-2026 review's item 14.
//
// createManualConnection() mints `manual-<uuid>` as an account's internal
// shop key, and defaultSettings() used to seed `business_name` from it. A
// merchant who finished onboarding before that default was overwritten got
// their first Resource named after the UUID (onboarding.tsx names it
// `settings.business_name || "Bookings"`), and that name is what the
// bookings table, the public booking page and every confirmation email
// then showed: "Standard appointment with manual-77cd2e49-85b3-…".
//
// settingsShared.ts's isInternalShopKey() stops new accounts reaching that
// state. This fixes the rows already written.
//
// Renames such a Resource to the account's real business name when one is
// now known, and to "Bookings" when it is not — the same fallback
// onboarding itself uses, so the result is what the row would have been
// had it been created today.
//
// Idempotent: only rows whose name still matches the internal-key pattern
// are touched, and a second run reports them all as skipped.
//
//   DATABASE_URL=... npx tsx scripts_backfill_resource_names.ts
//
// Pass --dry to list what would change without writing.
import prisma from "./src/db.js";
import { isInternalShopKey } from "./src/booking/settingsShared.js";
import { getSettings } from "./src/booking/settings.js";

const dryRun = process.argv.includes("--dry");

async function main() {
  // Narrowed in SQL first — `manual-` is cheap to match and the precise
  // UUID shape is then checked in isInternalShopKey(), so this never
  // renames a resource a merchant deliberately called "manual-something".
  const candidates = await prisma.resource.findMany({
    where: { name: { startsWith: "manual-" } },
    select: { id: true, shop: true, platform: true, name: true },
  });

  let renamed = 0;
  let skipped = 0;

  for (const resource of candidates) {
    if (!isInternalShopKey(resource.name)) {
      skipped += 1;
      continue;
    }

    const settings = await getSettings(resource.shop, resource.platform);
    // business_name is now "" rather than the shop key for these accounts,
    // so this falls through to the same default onboarding would have used.
    const replacement = settings.business_name || "Bookings";

    console.log(`${dryRun ? "[dry] " : ""}resource ${resource.id} (${resource.shop}): "${resource.name}" -> "${replacement}"`);
    if (!dryRun) {
      await prisma.resource.update({ where: { id: resource.id }, data: { name: replacement } });
    }
    renamed += 1;
  }

  console.log(`\n${dryRun ? "would rename" : "renamed"} ${renamed}, skipped ${skipped}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
