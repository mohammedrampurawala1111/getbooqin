/**
 * The snippet a merchant pastes into a website we have never seen.
 *
 * Two properties carry everything here. It has to be *stable* — a
 * snippet that differs between two renders of the same page makes "did
 * I already paste this?" unanswerable. And its listener runs on someone
 * else's page, so it has to refuse every message that is not our own
 * frame reporting a credible height.
 */
import { describe, expect, it } from "vitest";
import {
  EMBED_DEFAULT_HEIGHT,
  EMBED_MESSAGE_TYPE,
  embedFrameId,
  embedSnippet,
  embedUrl,
  originOf,
} from "../embed.js";

const URL_ = "https://app.getbooqin.com/book/salon-elysee";

function snippet(over: Partial<Parameters<typeof embedSnippet>[0]> = {}) {
  return embedSnippet({ bookingUrl: URL_, title: "Book with Salon Élysée", ...over });
}

describe("the snippet", () => {
  it("is one iframe and one script, and nothing to install", () => {
    const html = snippet();

    expect(html.match(/<iframe/g)).toHaveLength(1);
    expect(html.match(/<script>/g)).toHaveLength(1);
  });

  it("frames the page in embed mode, which is what makes it drop its chrome", () => {
    // Without ?embed=1 the page renders its own header and logo inside
    // the merchant's page, which looks like a mistake rather than a
    // booking form.
    expect(snippet()).toContain(`src="${URL_}?embed=1"`);
  });

  it("is byte-identical between renders of the same page", () => {
    expect(snippet()).toBe(snippet());
  });

  it("gives two different booking pages two different frame ids", () => {
    // A merchant with a page per location pastes both into one site.
    expect(embedFrameId(URL_)).not.toBe(embedFrameId("https://app.getbooqin.com/book/other"));
  });

  it("carries an accessible name, so a screen reader says more than 'frame'", () => {
    expect(snippet()).toContain('title="Book with Salon Élysée"');
  });

  it("starts at a height that shows a form rather than a sliver", () => {
    expect(snippet()).toContain(`height="${EMBED_DEFAULT_HEIGHT}"`);
    expect(EMBED_DEFAULT_HEIGHT).toBeGreaterThan(400);
  });

  it("honours a caller's height in both the attribute and the min-height", () => {
    const html = snippet({ height: 900 });

    expect(html).toContain('height="900"');
    expect(html).toContain("min-height:900px");
  });
});

describe("what the listener refuses", () => {
  const html = snippet();

  it("pins the message check to our own origin, not to any sender", () => {
    expect(html).toContain('e.origin !== "https://app.getbooqin.com"');
  });

  it("checks the message came from this frame, not merely from our origin", () => {
    // A merchant's page can hold several of these, plus anything else
    // on the same origin. Origin alone would let one resize another.
    expect(html).toContain("e.source !== frame.contentWindow");
  });

  it("believes only our own message type", () => {
    // A merchant's page may carry analytics, chat widgets and a CMS
    // preview bridge, all of them posting messages.
    expect(html).toContain(`e.data.type !== "${EMBED_MESSAGE_TYPE}"`);
  });

  it("takes only a finite number inside credible bounds", () => {
    expect(html).toContain('typeof h !== "number"');
    expect(html).toContain("!isFinite(h)");
    expect(html).toMatch(/h < \d+ \|\| h > \d+/);
  });
});

describe("escaping", () => {
  it("cannot be broken out of by a business name", () => {
    const html = snippet({ title: 'Bob"s "><script>alert(1)</script>' });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&quot;");
  });

  it("cannot be broken out of by a booking URL", () => {
    const html = embedSnippet({
      bookingUrl: 'https://app.getbooqin.com/book/x"><img onerror=alert(1)>',
      title: "Book",
    });

    expect(html).not.toContain("<img onerror");
  });
});

describe("originOf", () => {
  it("reduces a booking URL to the origin the listener compares against", () => {
    expect(originOf(URL_)).toBe("https://app.getbooqin.com");
  });

  it("returns empty for something that isn't a URL, which matches nothing", () => {
    // Better than throwing: a snippet whose check can never pass shows
    // a fixed-height frame, which still books.
    expect(originOf("not a url")).toBe("");
  });
});

describe("embedUrl", () => {
  it("adds the flag the booking page reads", () => {
    expect(embedUrl("https://x.example/book/a")).toBe("https://x.example/book/a?embed=1");
  });

  it("appends rather than replacing an existing query string", () => {
    // Merchants paste links with campaign tags on them.
    expect(embedUrl("https://x.example/book/a?utm_source=site")).toBe(
      "https://x.example/book/a?utm_source=site&embed=1"
    );
  });
});
