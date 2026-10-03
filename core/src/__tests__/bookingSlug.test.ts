/**
 * Booking slug rules (10-01-2026 review, item 11).
 *
 * customSlugProblem() is the pure half and is what these cover. The
 * database half — uniqueness, and the id-shadowing refusal — is asserted
 * in setCustomSlug() against a live row and is not reachable from a unit
 * test, so the comment there carries the reasoning.
 */
import { describe, expect, it } from "vitest";
import { customSlugProblem } from "../connections.js";

const ok = (slug: string) => expect(customSlugProblem(slug)).toBe("");
const rejected = (slug: string) => expect(customSlugProblem(slug)).not.toBe("");

describe("customSlugProblem", () => {
  it("accepts what a merchant would actually ask for", () => {
    ok("trevorhayes");
    ok("trevor-hayes");
    ok("trevor-hayes-dental");
    ok("clinic2");
    // The generated shape has to pass its own validator, or a merchant
    // could not re-save the General form without changing their slug.
    ok("tco71cw7");
  });

  it("rejects anything that would not survive a URL", () => {
    rejected("Trevor Hayes");       // space
    rejected("trevor_hayes");       // underscore
    rejected("trevor.hayes");       // dot
    rejected("trevor/hayes");       // path separator
    rejected("trevor?hayes");       // query separator
    rejected("trevor%20hayes");     // pre-encoded
    rejected("trevorhayes#1");
  });

  it("rejects leading/trailing and doubled hyphens", () => {
    rejected("-trevor");
    rejected("trevor-");
    rejected("trevor--hayes");
  });

  it("enforces a length a human can read and type", () => {
    rejected("ab");
    ok("abc");
    ok("a".repeat(40));
    rejected("a".repeat(41));
  });

  it("refuses the one path segment that would actually collide", () => {
    // /book/:connectionId/slots — a slug of "slots" makes that route
    // ambiguous in a way nothing else here does.
    rejected("slots");
  });

  it("refuses words that would make a support conversation confusing", () => {
    rejected("admin");
    rejected("api");
    rejected("null");
    rejected("undefined");
  });

  it("is case-insensitive about what it accepts, since it lowercases", () => {
    ok("TrevorHayes");
  });

  it("rejects an empty or whitespace-only slug", () => {
    rejected("");
    rejected("   ");
  });
});
