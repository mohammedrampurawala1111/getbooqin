/**
 * .ics generation. Pure, no database.
 *
 * Worth real tests because the failure mode is silent and remote: a
 * malformed file is rejected by the customer's calendar client, not by
 * us, so nobody here ever sees it fail. The three things that actually
 * break real .ics files are escaping, line folding and CRLF — all
 * covered below.
 */
import { describe, expect, it } from "vitest";
import { buildIcs, icsDataUrl, icsFilename } from "../calendar.js";

const base = {
  uid: "bk_123",
  start: new Date("2026-10-01T09:00:00.000Z"),
  end: new Date("2026-10-01T09:30:00.000Z"),
  title: "Haircut",
};
const NOW = new Date("2026-09-13T12:00:00.000Z");

function lines(ics: string): string[] {
  return ics.split("\r\n");
}
function prop(ics: string, name: string): string | undefined {
  return lines(ics).find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));
}

describe("structure", () => {
  it("is a well-formed single-event calendar", () => {
    const ics = buildIcs(base, NOW);
    const l = lines(ics);
    expect(l[0]).toBe("BEGIN:VCALENDAR");
    expect(l.at(-1)).toBe("END:VCALENDAR");
    expect(l.filter((x) => x === "BEGIN:VEVENT")).toHaveLength(1);
    expect(prop(ics, "VERSION")).toBe("VERSION:2.0");
  });

  it("uses CRLF, which is what the strict parsers insist on", () => {
    const ics = buildIcs(base, NOW);
    expect(ics).toContain("\r\n");
    // No bare LF anywhere.
    expect(/[^\r]\n/.test(ics)).toBe(false);
  });

  it("publishes rather than invites", () => {
    // METHOD:REQUEST would make this a meeting invitation, and some
    // clients then RSVP to the organiser — an address nothing is
    // listening on.
    expect(prop(buildIcs(base, NOW), "METHOD")).toBe("METHOD:PUBLISH");
  });

  it("stamps times as UTC in the one format the spec allows", () => {
    const ics = buildIcs(base, NOW);
    expect(prop(ics, "DTSTART")).toBe("DTSTART:20261001T090000Z");
    expect(prop(ics, "DTEND")).toBe("DTEND:20261001T093000Z");
    expect(prop(ics, "DTSTAMP")).toBe("DTSTAMP:20260913T120000Z");
  });

  it("carries a stable UID so a re-send updates rather than duplicates", () => {
    expect(prop(buildIcs(base, NOW), "UID")).toBe("UID:bk_123@getbooqin");
  });
});

describe("escaping — the delimiters inside a property value", () => {
  it("escapes commas, which a service name routinely contains", () => {
    const ics = buildIcs({ ...base, title: "Cut, colour and finish" }, NOW);
    expect(prop(ics, "SUMMARY")).toBe("SUMMARY:Cut\\, colour and finish");
  });

  it("escapes semicolons", () => {
    // This one shipped broken: "\;" in a JS string literal is just ";",
    // so semicolons passed through unescaped and split the property.
    const ics = buildIcs({ ...base, title: "Cut; colour" }, NOW);
    expect(prop(ics, "SUMMARY")).toBe("SUMMARY:Cut\\; colour");
  });

  it("escapes backslashes before anything else, so escapes aren't double-escaped", () => {
    const ics = buildIcs({ ...base, title: "A\\B" }, NOW);
    expect(prop(ics, "SUMMARY")).toBe("SUMMARY:A\\\\B");
  });

  it("turns newlines into the literal \\n a description needs", () => {
    const ics = buildIcs({ ...base, description: "Line one\nLine two" }, NOW);
    expect(prop(ics, "DESCRIPTION")).toContain("Line one\\nLine two");
  });
});

describe("line folding", () => {
  it("folds a long line and marks continuations with a leading space", () => {
    // Unfolded long lines are the commonest reason Outlook rejects an
    // .ics outright.
    const ics = buildIcs({ ...base, title: "x".repeat(200) }, NOW);
    const folded = lines(ics);
    for (const line of folded) {
      expect(Buffer.byteLength(line, "utf8"), `too long: ${line.slice(0, 20)}…`).toBeLessThanOrEqual(75);
    }
    expect(folded.some((l) => l.startsWith(" "))).toBe(true);
  });

  it("folds on octets, not characters, and never mid-codepoint", () => {
    // A multi-byte name would slip past a length-in-characters check and
    // produce an over-long line; folding mid-codepoint would corrupt it.
    const ics = buildIcs({ ...base, title: "é".repeat(80) }, NOW);
    for (const line of lines(ics)) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    }
    // Unfolding restores exactly what went in.
    const unfolded = ics.replace(/\r\n /g, "");
    expect(unfolded).toContain(`SUMMARY:${"é".repeat(80)}`);
  });

  it("leaves a short line alone", () => {
    expect(prop(buildIcs(base, NOW), "SUMMARY")).toBe("SUMMARY:Haircut");
  });
});

describe("helpers", () => {
  it("builds a data URL a browser can download without a round trip", () => {
    const url = icsDataUrl(base, NOW);
    expect(url.startsWith("data:text/calendar;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.split(",").slice(1).join(","))).toContain("BEGIN:VCALENDAR");
  });

  it("makes a filename safe for any filesystem", () => {
    expect(icsFilename("Cut, colour & finish")).toBe("cut-colour-finish.ics");
    expect(icsFilename("")).toBe("booking.ics");
    expect(icsFilename("!!!")).toBe("booking.ics");
  });
});
