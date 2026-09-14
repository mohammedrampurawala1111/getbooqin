/**
 * Two things this guards.
 *
 * 1. Regression on the Defect Dossier's BQ-17 finding: several starter
 *    templates' Terms carried defects that only showed up once
 *    concatenated into UI copy — Generic's "Staff Member" produced
 *    "Staff Member utilisation" (a stray mid-phrase capital from a
 *    two-word resource noun spliced into a sentence), and
 *    Education/Fitness shared an identical vocabulary map, making the
 *    two industries indistinguishable once applied.
 *
 * 2. The Phase 1 vocabulary contract: nothing derives a shop's words
 *    from its `preset` id any more, so `withDefaultTerms()` is the one
 *    place a missing or half-saved noun gets filled in, and it must
 *    never hand back a blank.
 */
import { describe, expect, it } from "vitest";
import { STARTER_TEMPLATES, defaultTerms, withDefaultTerms, starterTemplate, termSuggestions, termSuggestionPairs, guessPlural, type Terms } from "../presets.js";

const KEYS = [
  "resource_single", "resource_plural",
  "service_single", "service_plural",
  "booking_single", "booking_plural",
  "customer_single", "customer_plural",
] as const;

describe("starter-template vocabulary", () => {
  it("every template defines all eight Terms fields as non-empty strings", () => {
    for (const template of STARTER_TEMPLATES) {
      for (const key of KEYS) {
        expect(template.terms[key], `${template.id}.${key}`).toEqual(expect.any(String));
        expect(template.terms[key].trim().length, `${template.id}.${key} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it("resource_single is a single word, so it can't leak a stray mid-phrase capital into '{resource} utilisation'-style headings", () => {
    for (const template of STARTER_TEMPLATES) {
      expect(template.terms.resource_single, template.id).not.toMatch(/\s/);
    }
  });

  it("no two templates share an identical singular-vocabulary tuple", () => {
    const seen = new Map<string, string>();
    for (const template of STARTER_TEMPLATES) {
      const tuple = [
        template.terms.resource_single,
        template.terms.service_single,
        template.terms.booking_single,
        template.terms.customer_single,
      ].join("|");
      const clash = seen.get(tuple);
      expect(clash, `${template.id} shares its vocabulary with ${clash}`).toBeUndefined();
      seen.set(tuple, template.id);
    }
  });

  it("Education and Fitness are distinguishable from each other", () => {
    const education = starterTemplate("education").terms;
    const fitness = starterTemplate("fitness").terms;
    expect(education.booking_single).not.toBe(fitness.booking_single);
    expect(education.service_single).not.toBe(fitness.service_single);
  });

  it("every template seeds three or more services and a usable slot interval", () => {
    for (const template of STARTER_TEMPLATES) {
      expect(template.services.length, template.id).toBeGreaterThanOrEqual(3);
      expect(template.slotInterval, template.id).toBeGreaterThanOrEqual(5);
      for (const service of template.services) {
        expect(service.name.trim().length, `${template.id} service name`).toBeGreaterThan(0);
        expect(service.minutes, `${template.id}/${service.name} duration`).toBeGreaterThanOrEqual(5);
      }
    }
  });

  it("an unknown template id falls back to the neutral one rather than throwing", () => {
    expect(starterTemplate("no-such-template").id).toBe("generic");
    expect(starterTemplate(null).terms).toEqual(defaultTerms());
  });
});

describe("withDefaultTerms()", () => {
  it("fills a missing vocabulary entirely", () => {
    expect(withDefaultTerms(null)).toEqual(defaultTerms());
    expect(withDefaultTerms({})).toEqual(defaultTerms());
  });

  it("keeps what a merchant typed and only fills the gaps", () => {
    const filled = withDefaultTerms({ booking_single: "Cohort", booking_plural: "Cohorts" });
    expect(filled.booking_single).toBe("Cohort");
    expect(filled.booking_plural).toBe("Cohorts");
    expect(filled.customer_single).toBe(defaultTerms().customer_single);
  });

  it("treats a blank or whitespace-only word as missing, so a half-cleared form never renders an empty noun", () => {
    const filled = withDefaultTerms({ booking_single: "   ", service_single: "" } as Partial<Terms>);
    expect(filled.booking_single).toBe("Booking");
    expect(filled.service_single).toBe("Service");
  });

  it("trims surrounding whitespace off what it keeps", () => {
    expect(withDefaultTerms({ booking_single: "  Viewing " }).booking_single).toBe("Viewing");
  });
});

describe("termSuggestions()", () => {
  it("offers every distinct word the templates use for a slot, with no duplicates", () => {
    const suggestions = termSuggestions("booking_single");
    expect(suggestions).toContain("Booking");
    expect(suggestions).toContain("Appointment");
    expect(suggestions).toContain("Reservation");
    expect(new Set(suggestions).size).toBe(suggestions.length);
  });
});

/**
 * Plural derivation — only ever used to prefill the plural field while
 * it still agrees with the singular, never to overwrite a word the
 * merchant typed. It has to be right for the ordinary cases and it is
 * allowed to be wrong for the rest, which is exactly why the field
 * stays editable.
 */
describe("guessPlural", () => {
  it("adds an s to an ordinary word", () => {
    expect(guessPlural("Booking")).toBe("Bookings");
    expect(guessPlural("Patient")).toBe("Patients");
    expect(guessPlural("Doctor")).toBe("Doctors");
  });

  it("adds es after a sibilant, where a bare s is unpronounceable", () => {
    expect(guessPlural("Class")).toBe("Classes");
    expect(guessPlural("Box")).toBe("Boxes");
    expect(guessPlural("Pitch")).toBe("Pitches");
    expect(guessPlural("Wash")).toBe("Washes");
  });

  it("turns a consonant + y into ies", () => {
    expect(guessPlural("Therapy")).toBe("Therapies");
    expect(guessPlural("Facility")).toBe("Facilities");
  });

  it("leaves a vowel + y alone", () => {
    expect(guessPlural("Day")).toBe("Days");
    expect(guessPlural("Journey")).toBe("Journeys");
  });

  it("returns nothing for an empty singular, rather than a bare s", () => {
    // The merchant clearing the field must not leave "s" behind in the
    // one beside it.
    expect(guessPlural("")).toBe("");
    expect(guessPlural("   ")).toBe("");
  });
});

describe("termSuggestionPairs", () => {
  it("carries the plural that belongs with each singular", () => {
    const pairs = termSuggestionPairs("customer_single", "customer_plural");

    expect(pairs.length).toBeGreaterThan(1);
    for (const pair of pairs) {
      expect(pair.single).toBeTruthy();
      expect(pair.plural).toBeTruthy();
    }
  });

  it("offers each singular once", () => {
    const pairs = termSuggestionPairs("booking_single", "booking_plural");
    const singles = pairs.map((p) => p.single);

    expect(new Set(singles).size).toBe(singles.length);
  });
});
