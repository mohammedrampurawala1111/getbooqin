/**
 * applyPreset() used to be a blind overwrite: `setSettings(shop, platform,
 * { preset: key, terms: preset.terms, ...preset.defaults })` would clobber
 * any rule a merchant had already hand-tuned the moment they re-applied a
 * preset or picked a different one. Now that presets.ts's `defaults` carries
 * real per-industry rules (not just slot_interval), that overwrite would
 * fire on every template switch, not just an edge case — so it needed a
 * customized_fields-based non-destructive merge. This exercises that against
 * real Postgres (no mocking Prisma), same pattern as overlap.test.ts.
 */
import { afterAll, describe, expect, it } from "vitest";
import prisma from "../../db.js";
import * as Settings from "../settings.js";

const shop = `apply-preset-test-${Date.now()}.myshopify.com`;
const platform = "shopify";

describe("applyPreset() customization tracking", () => {
  afterAll(async () => {
    await prisma.shopSettings.deleteMany({ where: { shop } });
  });

  it("applies every rule default on first pick, with nothing customized yet", async () => {
    const settings = await Settings.applyPreset(shop, platform, "clinic");
    expect(settings.preset).toBe("clinic");
    expect(settings.terms.customer_single).toBe("Patient");
    expect(settings.min_notice_hours).toBe(4);
    expect(settings.cancel_cutoff_hours).toBe(24);
    expect(settings.auto_confirm).toBe(false);
    expect(settings.customized_fields).toEqual([]);
  });

  it("marks a hand-edited preset-controlled field as customized, and switching presets does not overwrite it", async () => {
    const edited = await Settings.setSettings(shop, platform, { cancel_cutoff_hours: 72 });
    expect(edited.customized_fields).toContain("cancel_cutoff_hours");

    const switched = await Settings.applyPreset(shop, platform, "salon");
    expect(switched.preset).toBe("salon");
    // Vocabulary always updates, even for customized shops.
    expect(switched.terms.customer_single).toBe("Client");
    // salon's own default (1) is skipped in favor of the merchant's edit.
    expect(switched.cancel_cutoff_hours).toBe(72);
    // Fields the merchant never touched still pick up the new preset's values.
    expect(switched.min_notice_hours).toBe(1);
    expect(switched.customized_fields).toContain("cancel_cutoff_hours");
  });

  it("force-reset overwrites every field and clears that preset's customizations", async () => {
    const reset = await Settings.applyPreset(shop, platform, "salon", { force: true });
    expect(reset.cancel_cutoff_hours).toBe(24);
    expect(reset.customized_fields).not.toContain("cancel_cutoff_hours");
  });

  it("a plain (non-form) setSettings call passed via applyPreset's internal path does not mark fields customized", async () => {
    // Sanity check on the fromPreset escape hatch itself: re-applying the
    // same preset right after a force-reset should not re-introduce any
    // customization, since nothing was hand-edited in between.
    const reapplied = await Settings.applyPreset(shop, platform, "salon");
    expect(reapplied.customized_fields).toEqual([]);
  });

  it("resubmitting a whole settings section with only one field actually changed does not mark the untouched fields customized", async () => {
    // Regression: shopify-openslot's General tab submits its entire section
    // (slot_interval, min_notice_hours, auto_confirm, ...) on every save,
    // even when a merchant only meant to change business_name. A
    // key-presence check would have flagged every one of those as
    // "customized" on the first save of anything.
    await Settings.applyPreset(shop, platform, "fitness", { force: true });
    const before = await Settings.getSettings(shop, platform);
    const after = await Settings.setSettings(shop, platform, {
      business_name: "Riverside Fitness",
      slot_interval: before.slot_interval,
      min_notice_hours: before.min_notice_hours,
      cancel_cutoff_hours: before.cancel_cutoff_hours + 1, // the one deliberate change
      auto_confirm: before.auto_confirm,
      require_phone: before.require_phone,
    });
    expect(after.customized_fields).toEqual(["cancel_cutoff_hours"]);
  });
});
