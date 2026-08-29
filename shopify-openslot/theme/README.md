# Bloom — Nail Studio theme

A complete Online Store 2.0 theme for a nail studio that sells products
(polish, care kits, gift cards) and takes appointments through the GetBooqin
app. Soft blush/cream palette, serif headings, all colors and fonts
editable from the theme editor (Theme settings → Colors / Typography).

## Install

```sh
cd theme
npx shopify theme push --store <your-store>.myshopify.com
```

Or drag the `theme` folder as a `.zip` into Shopify admin → Online Store →
Themes → Add theme → Upload zip.

## Structure

- `layout/theme.liquid` — the shell every page renders inside; also where
  each theme setting (colors, fonts, page width) is turned into CSS
  variables for `assets/theme.css` to use.
- `sections/` — one file per reusable block (header, hero, product grid,
  product page, cart, etc.), each with its own theme-editor schema.
- `templates/*.json` — assigns sections to each page type (JSON templates,
  so merchants can reorder/add sections in the theme editor without code).
- `assets/theme.css` / `assets/theme.js` — all styling and interactivity
  (mobile nav, variant picker, AJAX add-to-cart, cart quantity updates).
  No build step, no framework.

## GetBooqin integration

This theme doesn't bundle GetBooqin's code — that lives in the separate
`getbooqin-widgets` theme app extension, installed automatically once the
GetBooqin app is added to the store. What this theme provides is the
*slots* for that app's blocks to plug into, in the two places a nail
studio actually needs booking:

**1. A "Book now" button on individual products** — `sections/main-product.liquid`
declares `{ "type": "@app" }` in its block list, so once GetBooqin is
installed, a merchant opens a product in the theme editor, clicks *Add
block*, and adds **GetBooqin Button** anywhere in that list (e.g. right below
Buy buttons). It only shows up on products actually linked to a service in
the GetBooqin admin — unlinked products render nothing there, on purpose.

**2. A full booking page** — `sections/booking-page.liquid` (used by the
`page.booking` alternate template) is built specifically to hold the
**GetBooqin Booking** app block: create a page in Shopify admin, assign it the
"booking" template, then add that block. Until a block is added, the
section shows a dashed placeholder in the editor so it's obvious what's
missing. The header's "Book now" button (Theme settings → Header) should
point at this page.

**3. Brand color handoff** — `layout/theme.liquid` sets a
`--getbooqin-accent` CSS variable from the theme's own accent color setting.
GetBooqin's product-page button reads that variable (falling back to its own
default blue if it's absent), so the button matches the studio's palette
automatically instead of clashing with it — no manual color sync needed
between the app and the theme.

## What's intentionally not built out

Customer account pages (login, register, order history, addresses) use
Shopify's default unstyled fallback rather than custom templates — out of
scope for a first pass focused on the storefront, catalog, and booking
handoff. Everything else (home, product, collection, cart, search, blog,
article, page, 404, password) is fully themed.
