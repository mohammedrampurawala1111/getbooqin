/**
 * The booking page, on the merchant's own website.
 *
 * With Shopify shipped dark, a link and a QR code were the entire
 * distribution story — and "put it on my own site" is the first thing a
 * merchant asks once they have looked at the booking page and decided
 * it is theirs. The `embed` feature key was removed from plans.ts
 * precisely because this did not exist yet; it comes back with it.
 *
 * ## Half of this was already built
 *
 * The public booking page has taken `?embed=1` for some time: it drops
 * the page chrome, and posts its own height to whatever framed it. What
 * was missing was the other half — the thing a merchant actually pastes
 * — so the capability existed and nobody could reach it.
 *
 * That is also why the wire format lives **here** rather than in the
 * page. There are now two ends of one protocol written in two
 * repositories' worth of distance from each other (a React hook, and a
 * string we hand to a stranger to paste into Wix). They cannot be
 * changed together unless one file defines the message both use, so
 * this file does, and the page imports it.
 *
 * ## An iframe, and nothing to install
 *
 * One `<iframe>` plus a `<script>` short enough to read before pasting.
 * Deliberately not a loader script that injects markup: a merchant
 * pastes this into Wix, Squarespace, WordPress or a raw HTML file,
 * often into a field that strips what it does not recognise, and an
 * iframe is the one element all of those accept. Nothing of ours runs
 * on the merchant's page, so we cannot break their site and their site
 * cannot break booking.
 *
 * ## Height
 *
 * The one thing an iframe cannot do for itself. A fixed height is wrong
 * in both directions — too short and the confirm button sits behind a
 * nested scrollbar, too tall and there is a lake of whitespace under a
 * three-line form.
 *
 * The listener is written to be safe on a page it does not control: it
 * checks the message's origin against ours, checks the source is *this*
 * iframe rather than any other frame on the page, and takes only a
 * finite number within credible bounds. A merchant may embed several
 * (a page per location), so nothing assumes there is one.
 *
 * ## No JavaScript
 *
 * The iframe still renders and still books — the flow is server-rendered
 * form posts. It stays at `height` and scrolls internally, which is the
 * degradation worth having.
 */

/**
 * The message the framed booking page posts, and the only one the
 * snippet below believes. Changing this string breaks every snippet
 * already pasted into a merchant's website, which is a thing that
 * cannot be rolled back from here — treat it as a wire format.
 */
export const EMBED_MESSAGE_TYPE = "getbooqin:height";

/** What puts the booking page into framed mode: `/book/slug?embed=1`. */
export const EMBED_QUERY_PARAM = "embed";

/** Where the frame starts before the page has reported its real height. */
export const EMBED_DEFAULT_HEIGHT = 720;

/** Below this, a reported height is a measurement taken mid-render, not a page. */
export const EMBED_MIN_HEIGHT = 200;

/**
 * Bound on a height we will honour. Not defensive programming for its
 * own sake: a page mid-layout can briefly report a nested scroll
 * container's full extent, and a merchant's site must not be left with
 * a 90,000-pixel gap in it.
 */
export const EMBED_MAX_HEIGHT = 5000;

export interface EmbedSnippetArgs {
  /** The public booking URL — https://app.example.com/book/slug */
  bookingUrl: string;
  /** The iframe's accessible name, so a screen reader says more than "frame". */
  title: string;
  /** Starting height in CSS pixels. */
  height?: number;
}

/** The booking URL in framed mode — the page drops its own chrome and reports its height. */
export function embedUrl(bookingUrl: string): string {
  const separator = bookingUrl.includes("?") ? "&" : "?";
  return `${bookingUrl}${separator}${EMBED_QUERY_PARAM}=1`;
}

/** The origin a booking URL lives on, for the listener's message check. */
export function originOf(bookingUrl: string): string {
  try {
    return new URL(bookingUrl).origin;
  } catch {
    return "";
  }
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A unique-enough id for one embed on a page that may carry several.
 *
 * Derived from the URL rather than random, so the snippet a merchant
 * copies today is byte-identical to the one they copy tomorrow. A
 * snippet that changes every render looks broken in a diff and makes
 * "did I already paste this?" unanswerable.
 */
export function embedFrameId(bookingUrl: string): string {
  let hash = 0;
  for (let i = 0; i < bookingUrl.length; i++) {
    hash = (hash * 31 + bookingUrl.charCodeAt(i)) | 0;
  }
  return `getbooqin-${(hash >>> 0).toString(36)}`;
}

/**
 * The paste-this-into-your-website snippet.
 *
 * One string rather than a template, so the copy button, the block a
 * merchant reads on screen and anything that ever emails it are all
 * showing the same characters.
 */
export function embedSnippet({ bookingUrl, title, height = EMBED_DEFAULT_HEIGHT }: EmbedSnippetArgs): string {
  const id = embedFrameId(bookingUrl);
  const src = escapeAttribute(embedUrl(bookingUrl));
  const name = escapeAttribute(title);
  const origin = escapeAttribute(originOf(bookingUrl));

  return `<iframe id="${id}" src="${src}" title="${name}" width="100%" height="${height}" style="border:0;width:100%;min-height:${height}px" loading="lazy"></iframe>
<script>
(function () {
  var frame = document.getElementById("${id}");
  window.addEventListener("message", function (e) {
    if (e.origin !== "${origin}") return;
    if (!frame || e.source !== frame.contentWindow) return;
    if (!e.data || e.data.type !== "${EMBED_MESSAGE_TYPE}") return;
    var h = e.data.height;
    if (typeof h !== "number" || !isFinite(h) || h < ${EMBED_MIN_HEIGHT} || h > ${EMBED_MAX_HEIGHT}) return;
    frame.style.height = h + "px";
  });
})();
</script>`;
}

