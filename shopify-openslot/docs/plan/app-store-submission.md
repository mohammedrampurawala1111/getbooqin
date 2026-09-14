# GetBooqin — Shopify App Store submission checklist

Source: https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements

## Decision this plan assumes

**Ship v1 as a free listing. Billing (Shopify Billing API, paid plans) is
v2** — not built now, not blocking this submission. When it lands later,
existing installs will see a re-consent/charge-approval screen (Shopify
requirement 1.2.2); that's a v2 concern, noted here so it isn't a surprise.

## Already done (verified against the codebase)

- Mandatory GDPR webhooks — `customers/redact`, `customers/data_request`,
  `shop/redact` — implemented and registered in
  `shopify.app.production.toml`, with real deletion logic in
  `app/routes/webhooks.shop.redact.tsx` (and siblings).
- `app/uninstalled` and `app/scopes_update` webhooks registered.
- Privacy policy page at `app/routes/privacy.tsx`, publicly reachable,
  contact address sourced from `SUPPORT_EMAIL` — this is the URL for the
  Partner Dashboard "Privacy policy" field.
- GraphQL-only Admin API usage (no REST admin API calls anywhere) — meets
  the post-April-2025 GraphQL requirement.
- Embedded app + App Bridge wired correctly via
  `@shopify/shopify-app-react-router`'s `AppProvider`; OAuth handled by the
  framework, immediate on install/reinstall.
- Theme changes ship as a theme app extension
  (`extensions/getbooqin-widgets`), not direct theme edits.
- Admin UI extension (`extensions/getbooqin-service-config`) is
  feature-complete booking config, not a promo surface.
- Scopes are `read_products,write_products,read_themes`. The first two are
  the product→service sync; `read_themes` reads the main theme's
  `config/settings_data.json` to tell the merchant whether the booking
  button's app embed is actually switched on (`app/lib/embedStatus.server.ts`)
  — without it that status is a guess from storefront pings. Narrow and
  read-only, but it is a third scope, so expect it to be the one a reviewer
  asks about.
- TLS via fly.dev by default.
- App icon (1200×1200 PNG) exists in `img/` — confirmed 1200×1200 RGBA.
- Terms of Service page at `app/routes/terms.tsx`, cross-linked with
  `/privacy`. Not a hard App Store requirement, but standard practice; moved
  here from "nice to have" now that it exists.

## The embedded app is deliberately one screen

**Read this before writing listing copy or recording the screencast — it
changes both.**

The app used to carry fifteen embedded admin screens. They were a second
implementation of the GetBooqin dashboard over the same database, and
maintaining two admins for one product is what Phase 4 of the trim plan
removed. What is left under `/app` is a single screen
(`app/routes/app._index.tsx`) that does the three things only this app can:
says whether the store is connected to a GetBooqin account, reports and
links to the theme app embed, and deep-links to the dashboard.

Everything a merchant cannot do inside Shopify admin, they do in the
GetBooqin dashboard, in a new tab.

⚠️ **This is the main review risk in the submission.** Shopify expects an
embedded app to be usable inside the admin rather than a shell whose only
function is to send merchants elsewhere. A thin embedded app that links out
is common and normally passes, but it is a judgement call by a reviewer, not
a checkbox. Two things make the case, and both should be visible in the
screencast:

- The app does substantial work *in the store* — it installs the storefront
  booking widget (theme app extension), adds the booking-config block to the
  product page (admin UI extension), turns service-typed products into
  bookable services, and sends confirmations, reminders and waitlist offers.
  Almost none of that is a screen; all of it is the product.
- The embedded screen is genuinely useful rather than a redirect: app-embed
  status is information a merchant can only get here, and the theme-editor
  link is the fix.

If a reviewer pushes back, the cheapest answer is to bring a read-only
bookings list back into `/app` — not to rebuild the admin.

## v1 scope

- Merchant payment collection and the chat widget were removed from the
  codebase entirely (trim plan Phase 1), along with `featureFlags.ts` and its
  `ENABLE_*` vars. Screenshots and the screencast must not show either — they
  no longer exist, not merely disabled.
- The privacy policy's payment-gateway wording and the `shop/redact`
  handler's chat-table references are historical/future-proofing, not
  descriptions of current behaviour. Don't let listing copy imply otherwise.
- GetBooqin now charges merchants for the *platform* (Razorpay
  subscriptions, `core/src/billing/`), but that is billed outside Shopify and
  is unrelated to the Shopify Billing API item deferred below. A free Shopify
  listing alongside a separately-billed SaaS is allowed, but the listing copy
  must not mention pricing at all, and the reviewer's test account needs a
  plan that doesn't expire mid-review.

## Work still needed

### Partner Dashboard / listing content
- [ ] Set pricing to **Free** in the listing.
- [ ] App Store screenshots — real UI, no reviews/testimonials/stats baked
      into the images.
- [ ] Demo screencast: onboarding + a full booking flow, English or
      subtitled.
- [ ] App card subtitle + full description copy — concise, no keyword
      stuffing, no unsubstantiated claims ("best"/"only"/etc.), no pricing
      mentioned anywhere in copy or images.
- [ ] Accurate listing tags reflecting booking/appointment functionality.
- [ ] Test credentials for reviewers: a demo store with at least one
      bookable service already configured, **plus a GetBooqin account already
      connected to it and on a plan that will not lapse during review** —
      otherwise the one embedded screen shows "finish connecting this store"
      and the reviewer sees nothing work.
- [ ] Emergency developer contact added in Partner Dashboard.
- [ ] Confirm "GetBooqin" doesn't collide with an existing listing name —
      a web search turned up no exact match (closest is the unrelated
      "Booqable" rental app), but Partner Dashboard's own uniqueness check
      at listing-name entry is the authoritative source, not this search.

## Deferred to v2

- Shopify Billing API integration (`AppSubscription` / usage charges).
- Re-consent / charge-approval screen for existing free installs when
  billing ships.
- Plan upgrade/downgrade flow that doesn't require contacting support
  (Shopify requirement 1.2.3 — only applies once there's a paid plan).

## Open questions

- None blocking v1 — pricing model is settled (free for now). Revisit
  plan tiers/pricing amounts when scoping v2 billing.
