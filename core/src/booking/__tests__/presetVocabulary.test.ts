/**
 * Regression test for the Defect Dossier's BQ-17 finding: several presets'
 * Terms carried defects that only showed up once concatenated into UI copy —
 * Generic's "Staff Member" produced "Staff Member utilisation" (a stray
 * mid-phrase capital from a two-word resource noun spliced into a sentence),
 * and Education/Fitness shared an identical vocabulary map, making the two
 * industries indistinguishable once applied. The fix made every preset's
 * resource_single a single word (nothing left to splice a second capital
 * from) and gave every preset a distinct singular-term tuple.
 */
import { describe, expect, it } from "vitest";
import { PRESETS } from "../presets.js";

describe("preset vocabulary", () => {
  const entries = Object.entries(PRESETS);

  it("every preset defines all eight Terms fields as non-empty strings", () => {
    const keys = [
      "resource_single", "resource_plural",
      "service_single", "service_plural",
      "booking_single", "booking_plural",
      "customer_single", "customer_plural",
    ] as const;
    for (const [id, preset] of entries) {
      for (const key of keys) {
        expect(preset.terms[key], `${id}.${key}`).toEqual(expect.any(String));
        expect(preset.terms[key].trim().length, `${id}.${key} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it("resource_single is a single word, so it can't leak a stray mid-phrase capital into '{resource} utilisation'-style headings", () => {
    for (const [id, preset] of entries) {
      expect(preset.terms.resource_single, id).not.toMatch(/\s/);
    }
  });

  it("no two presets share an identical singular-vocabulary tuple", () => {
    const seen = new Map<string, string>();
    for (const [id, preset] of entries) {
      const tuple = [
        preset.terms.resource_single,
        preset.terms.service_single,
        preset.terms.booking_single,
        preset.terms.customer_single,
      ].join("|");
      const clash = seen.get(tuple);
      expect(clash, `${id} shares its vocabulary with ${clash}`).toBeUndefined();
      seen.set(tuple, id);
    }
  });

  it("Education and Fitness are distinguishable from each other", () => {
    const education = PRESETS.education.terms;
    const fitness = PRESETS.fitness.terms;
    expect(education.booking_single).not.toBe(fitness.booking_single);
    expect(education.service_single).not.toBe(fitness.service_single);
  });
});
