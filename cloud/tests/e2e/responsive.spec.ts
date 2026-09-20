import { test, expect, devices } from "@playwright/test";

/**
 * Does anything overflow its viewport?
 *
 * One measurable question, asked of every public page at every width
 * worth caring about. Horizontal overflow is the failure that actually
 * costs bookings: the page scrolls sideways, a control ends up off
 * screen, and the customer cannot reach the button. It is also the one
 * responsive bug that is objectively detectable rather than a matter of
 * taste, which is why this suite tests for it and not for "looks right".
 *
 * The booking page matters most. A merchant reads the dashboard on a
 * laptop; their customer books on a phone, one-handed, having followed
 * a link from a text message.
 */
const VIEWPORTS = [
  { name: "iPhone SE", width: 375, height: 667 },
  { name: "iPhone 14 Pro", width: 393, height: 852 },
  { name: "Pixel 7", width: 412, height: 915 },
  { name: "iPad mini", width: 768, height: 1024 },
  { name: "Desktop", width: 1280, height: 800 },
];

const SLUG = process.env.E2E_BOOKING_SLUG;

const PAGES: { path: string; name: string; skip?: boolean }[] = [
  { path: "/", name: "landing" },
  { path: "/login", name: "login" },
  { path: "/signup", name: "signup" },
  { path: "/legal/terms", name: "terms" },
  { path: "/legal/privacy", name: "privacy" },
  { path: SLUG ? `/book/${SLUG}` : "/", name: "booking page", skip: !SLUG },
  { path: SLUG ? `/book/${SLUG}?embed=1` : "/", name: "booking page (embedded)", skip: !SLUG },
];

/** Every element sticking out past the viewport, named well enough to find. */
async function overflowing(page: import("@playwright/test").Page, width: number) {
  return page.evaluate((viewportWidth) => {
    const out: { tag: string; cls: string; text: string; right: number }[] = [];
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      // 1px of slack: sub-pixel rounding is not a bug.
      if (box.right <= viewportWidth + 1) continue;
      // Only the outermost offender — a wide parent makes every child
      // look wide, and the parent is what has to be fixed.
      if (out.some((o) => el.closest(`.${CSS.escape(o.cls.split(" ")[0] ?? "")}`))) continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className?.toString() ?? "").slice(0, 80),
        text: (el.textContent ?? "").trim().slice(0, 50),
        right: Math.round(box.right),
      });
      if (out.length >= 6) break;
    }
    return out;
  }, width);
}

for (const vp of VIEWPORTS) {
  for (const p of PAGES) {
    test(`${p.name} @ ${vp.name} (${vp.width}px) does not scroll sideways`, async ({ page }) => {
      test.skip(!!p.skip, "Set E2E_BOOKING_SLUG for the booking page cases.");
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(p.path);
      await page.waitForLoadState("networkidle");

      const scroll = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));

      if (scroll.doc > scroll.client + 1) {
        const culprits = await overflowing(page, vp.width);
        console.log(`\n${p.name} @ ${vp.width}: doc ${scroll.doc} > viewport ${scroll.client}`);
        for (const c of culprits) {
          console.log(`   <${c.tag} class="${c.cls}"> right=${c.right} — "${c.text}"`);
        }
      }

      expect(scroll.doc, `${p.name} overflows at ${vp.width}px`).toBeLessThanOrEqual(scroll.client + 1);
    });
  }
}

test.describe("the marketing header on a narrow phone", () => {
  /**
   * Not overflow — the header fitted, by wrapping. "Log in" broke into
   * "Log" / "in" above a two-line "Sign up free", which is the kind of
   * thing a visitor reads as "this is broken" a second before they
   * leave. The logged-in branch had solved it at 400px already; the
   * logged-out one never got the same treatment.
   */
  for (const width of [320, 360, 375]) {
    test(`nothing in the header wraps at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 700 });
      await page.goto("/");

      const wrapped = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of Array.from(document.querySelectorAll("header a, header button"))) {
          const box = el.getBoundingClientRect();
          const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
          const text = (el.textContent || el.getAttribute("aria-label") || "").trim();
          // Comfortably more than one line's worth of height, allowing
          // for the padding a button legitimately has.
          if (text && box.height > lineHeight * 1.7) out.push(`${text} (${Math.round(box.height)}px)`);
        }
        return out;
      });

      expect(wrapped, `header items wrapping at ${width}px`).toEqual([]);
    });
  }

  test("Log in is still reachable once it leaves the header", async ({ page }) => {
    // Hidden below 400px, not deleted — it moves into the menu panel.
    await page.setViewportSize({ width: 375, height: 700 });
    await page.goto("/");
    await page.getByRole("button", { name: "Toggle menu" }).click();

    await expect(page.locator("#mkt-mobile-nav").getByRole("link", { name: "Log in" })).toBeVisible();
  });
});
