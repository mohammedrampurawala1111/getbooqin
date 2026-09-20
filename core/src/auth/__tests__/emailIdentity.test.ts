/**
 * The duplicate-account hole, and the much worse one you open by
 * over-correcting it.
 */
import { describe, expect, it } from "vitest";
import { emailKey, sameMailbox } from "../emailIdentity.js";

describe("Gmail's own rules", () => {
  it("treats dots in a Gmail address as decoration", () => {
    // The case from the review: one person, two accounts, two trials.
    expect(sameMailbox("info.scintillaweb@gmail.com", "info.scintilla.web@gmail.com")).toBe(true);
  });

  it("ignores everything after a plus", () => {
    expect(sameMailbox("owner@gmail.com", "owner+trial2@gmail.com")).toBe(true);
  });

  it("folds googlemail.com onto gmail.com", () => {
    expect(sameMailbox("owner@googlemail.com", "owner@gmail.com")).toBe(true);
  });

  it("combines both rules at once", () => {
    expect(sameMailbox("o.w.n.e.r+a@googlemail.com", "owner@gmail.com")).toBe(true);
  });

  it("is case-insensitive and ignores surrounding space", () => {
    expect(sameMailbox("  Owner@Gmail.com ", "owner@gmail.com")).toBe(true);
  });
});

describe("what it must not merge", () => {
  it("keeps dots significant outside Google", () => {
    // j.smith and jsmith at a company are two colleagues. Merging them
    // locks one out of a product they never signed up to — a worse
    // failure than the duplicate this file exists to prevent.
    expect(sameMailbox("j.smith@company.com", "jsmith@company.com")).toBe(false);
  });

  it("keeps different mailboxes apart on Gmail", () => {
    expect(sameMailbox("alice@gmail.com", "bob@gmail.com")).toBe(false);
  });

  it("keeps the same local part on different domains apart", () => {
    expect(sameMailbox("owner@gmail.com", "owner@outlook.com")).toBe(false);
  });

  it("still applies the plus rule off Gmail, where it is near-universal", () => {
    expect(sameMailbox("owner+x@outlook.com", "owner@outlook.com")).toBe(true);
  });
});

describe("malformed input", () => {
  it.each(["", "   ", "not-an-email", "@gmail.com", "owner@", "owner@localhost"])(
    "returns no key for %p",
    (value) => {
      expect(emailKey(value)).toBe("");
    }
  );

  it("never matches two malformed values against each other", () => {
    // Otherwise every junk value collides with every other one and the
    // first bad signup blocks all the rest.
    expect(sameMailbox("nonsense", "rubbish")).toBe(false);
    expect(sameMailbox("", "")).toBe(false);
  });
});

describe("the key is for comparison, not for sending", () => {
  it("does not claim to be a deliverable address", () => {
    // Mail goes to what the merchant typed. This is only ever a lookup
    // key — the test exists so nobody is tempted to send to it.
    expect(emailKey("First.Last+bookings@googlemail.com")).toBe("firstlast@gmail.com");
  });
});
