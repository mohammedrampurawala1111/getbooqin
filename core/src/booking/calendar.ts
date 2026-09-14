/**
 * iCalendar (.ics) generation.
 *
 * Attached to every confirmation email, which is the point: a booking
 * that lands in the customer's own calendar measurably cuts no-shows,
 * and it costs one small function and no integration with anything.
 *
 * Zero imports, so the public booking page's "Add to calendar" button
 * can build the same file client-side from the same code — one
 * generator, not two that drift.
 *
 * ## The bits that are easy to get wrong
 *
 * **Line folding.** RFC 5545 caps a content line at 75 octets and
 * requires longer ones to be folded onto continuation lines starting
 * with a space. Unfolded long lines are the single most common reason
 * an .ics is rejected outright by Outlook.
 *
 * **Escaping.** Commas, semicolons and backslashes are delimiters in a
 * property value; a service called "Cut, colour & finish" breaks the
 * parse unless they are escaped, and newlines have to become a literal
 * `\n`.
 *
 * **CRLF.** The spec says lines end CRLF. Most parsers tolerate LF;
 * some do not, and the ones that don't are the ones people use at work.
 */

export interface CalendarEvent {
  /** Stable per booking — a calendar uses it to update rather than duplicate on a re-send. */
  uid: string;
  start: Date;
  end: Date;
  title: string;
  description?: string;
  location?: string;
  /** Where a customer can change or cancel; appended to the description, since URL support is patchy. */
  url?: string;
}

// No ORGANIZER property. It requires a mailto: address, and there is no
// real one to give — the confirmation email is sent from a no-reply
// platform address, and inventing one puts a dead address in front of
// the customer in every calendar client that displays it. The business
// name is in the summary and description already.

const encoder = new TextEncoder();

/** UTF-8 byte length. Not `Buffer`: this module runs in the browser too. */
function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/** yyyymmddThhmmssZ — the one datetime shape a UTC-anchored DTSTART may take. */
function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Escapes the four characters that are structural inside a property value. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * Folds to 75 **octets**, not characters — a multi-byte name (a Dutch
 * ë, a Devanagari service name) would otherwise slip past a
 * length-in-characters check and produce an over-long line, and folding
 * mid-codepoint would corrupt it.
 */
function fold(line: string): string[] {
  if (byteLength(line) <= 75) return [line];

  const out: string[] = [];
  let current = "";
  let currentBytes = 0;
  // Iterating the string yields whole codepoints, so a fold never lands
  // mid-character. 74 on continuation lines: the leading space counts
  // toward the limit.
  for (const char of line) {
    const size = byteLength(char);
    const cap = out.length === 0 ? 75 : 74;
    if (currentBytes + size > cap) {
      out.push(current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += size;
  }
  if (current) out.push(current);
  return out.map((part, i) => (i === 0 ? part : ` ${part}`));
}

export function buildIcs(event: CalendarEvent, now = new Date()): string {
  const description = [event.description, event.url].filter(Boolean).join("\n\n");

  const properties: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//GetBooqin//Booking//EN",
    "CALSCALE:GREGORIAN",
    // PUBLISH, not REQUEST: REQUEST makes it a meeting invitation and
    // some clients will then send an RSVP to the organiser address,
    // which nothing here is listening on.
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${escapeText(event.uid)}@getbooqin`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(event.start)}`,
    `DTEND:${stamp(event.end)}`,
    `SUMMARY:${escapeText(event.title)}`,
    ...(description ? [`DESCRIPTION:${escapeText(description)}`] : []),
    ...(event.location ? [`LOCATION:${escapeText(event.location)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  return properties.flatMap(fold).join("\r\n");
}

/** For a client-side "Add to calendar" link, where there is no server round trip to spend. */
export function icsDataUrl(event: CalendarEvent, now = new Date()): string {
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(buildIcs(event, now))}`;
}

export function icsFilename(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${slug || "booking"}.ics`;
}
