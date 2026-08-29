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
- Scopes are minimal (`read_products,write_products`) — nothing that needs
  a use-case justification.
- TLS via fly.dev by default.
- App icon (1200×1200 PNG) exists in `img/` — confirmed 1200×1200 RGBA.
- Terms of Service page at `app/routes/terms.tsx`, cross-linked with
  `/privacy`. Not a hard App Store requirement, but standard practice; moved
  here from "nice to have" now that it exists.

## v1 scope — payments and chat are off

`ENABLE_PAYMENTS` and `ENABLE_CHAT` both default to `false`
(`core/src/booking/featureFlags.ts`), and nothing in this repo flips them for
production. This isn't called out elsewhere in this doc, but it constrains
every listing-content item below:
- Screenshots and the demo screencast must not show online payment
  collection or the chat widget — neither exists in what a reviewer or
  merchant will actually see in v1.
- The privacy policy's payment-gateway and the GDPR webhooks' chat-table
  wording (`ChatConversation`/`ChatMessage` in the `shop/redact` handler) are
  intentionally future-proofed for when these ship, not descriptions of
  current behavior — don't let listing copy imply they're live today.

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
      bookable service already configured, so a reviewer can complete an
      end-to-end booking without setup help.
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
