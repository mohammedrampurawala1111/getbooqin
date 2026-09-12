// One-off backfill for Phase 1's vocabulary change (see
// src/booking/presets.ts). Every shop's nouns now come from
// `settings.terms` and nothing derives them from `settings.preset` any
// more, so a row written before this — or one whose `terms` was never
// populated because the shop never picked a template — would render
// blank nouns in headings.
//
// getSettings() already backfills at read time via withDefaultTerms(),
// which is what makes this safe rather than urgent: the point of running
// it is to put a real value *at rest*, so the vocabulary card on Settings
// → General shows the words the shop is actually using instead of empty
// inputs, and so nothing depends on the read-time fallback staying
// forever.
//
// Also drops `customized_fields` from stored rows, which nothing reads
// since applyPreset() was removed.
//
// Idempotent: a row that already has a complete `terms` object and no
// `customized_fields` key is left untouched, and reported as skipped.
//
//   DATABASE_URL=... npx tsx scripts_backfill_terms.ts
import prisma from "./src/db.js";
import { withDefaultTerms, starterTemplate, type Terms } from "./src/booking/presets.js";

const TERM_KEYS: (keyof Terms)[] = [
  "resource_single", "resource_plural",
  "service_single", "service_plural",
  "booking_single", "booking_plural",
  "customer_single", "customer_plural",
];

function isComplete(terms: unknown): terms is Terms {
  if (!terms || typeof terms !== "object") return false;
  const t = terms as Record<string, unknown>;
  return TERM_KEYS.every((key) => typeof t[key] === "string" && (t[key] as string).trim() !== "");
}

async function main() {
  const rows = await prisma.shopSettings.findMany();
  let written = 0;
  let skipped = 0;

  for (const row of rows) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(row.data);
    } catch {
      console.error(`[backfill-terms] ${row.platform}/${row.shop}: settings JSON is unparseable — skipping`);
      continue;
    }

    const hadCustomized = "customized_fields" in data;
    if (isComplete(data.terms) && !hadCustomized) {
      skipped += 1;
      continue;
    }

    // A shop that picked a starter template during onboarding but never
    // got its words written keeps that template's vocabulary; everything
    // else falls back to the neutral set. Whatever it already has wins
    // word by word — this only ever fills gaps.
    const seed = typeof data.preset === "string" ? starterTemplate(data.preset).terms : undefined;
    const partial = (data.terms && typeof data.terms === "object" ? data.terms : {}) as Partial<Terms>;
    data.terms = withDefaultTerms({ ...seed, ...partial });
    delete data.customized_fields;

    await prisma.shopSettings.update({
      where: { platform_shop: { platform: row.platform, shop: row.shop } },
      data: { data: JSON.stringify(data) },
    });
    written += 1;
    console.log(`[backfill-terms] ${row.platform}/${row.shop}: terms written${hadCustomized ? ", customized_fields dropped" : ""}`);
  }

  console.log(`[backfill-terms] done — ${written} updated, ${skipped} already complete, ${rows.length} total`);
}

main()
  .catch((err) => {
    console.error("[backfill-terms] failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
