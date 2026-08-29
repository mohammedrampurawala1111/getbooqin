# GetBooqin Cloud — build plan & prompts

Scope for this phase: **Shopify only**. WordPress/WooCommerce and any other
platform are deferred to a later phase — see "Next steps" at the bottom. The
schema and interfaces below are kept platform-neutral on purpose so that
later phase is an addition, not a rewrite.

## Vision

GetBooqin is one booking engine — appointments, resources, payments,
reminders — that adapts to any service business (salon, clinic, fitness
studio, consultant, home-service trade, restaurant) through industry
presets, not custom builds. GetBooqin Cloud is the management layer on top:
a merchant logs in once, connects their store, and manages the whole
booking workflow and sees their metrics from one dashboard — while the
store's own catalog (products, price, description) stays owned by the
store, not duplicated into GetBooqin.

## Design decisions this plan assumes

These were worked out before this doc and are treated as settled, not
re-litigated per prompt:

- **Single backend, thin platform interface.** One Node/Prisma backend is
  the system of record for the booking workflow. A platform integration
  (Shopify app today, others later) is a front door — auth, embedding,
  storefront rendering — not a second implementation of booking logic.
- **GetBooqin owns the booking workflow only**: `Booking`, `Resource`,
  `Schedule`, `TimeOff`, `Customer`, `Payment`, `Addon`,
  `ChatConversation`. It never owns catalog data.
- **Catalog and booking-config both live on the platform, not in
  GetBooqin.** Product name/price/description come from the Shopify
  product. Booking parameters (duration, buffers, capacity, resource
  assignment, add-on assignment, payment/deposit settings) are stored as
  **Shopify product metafields** — editable from GetBooqin's dashboard or
  natively in Shopify admin, kept in sync both directions. GetBooqin keeps
  a read-through cache of both for the booking engine's own speed, never
  treats that cache as authoritative.
- **Platform field kept generic now.** Tables that need it carry a
  `platform` value (`"shopify"` for everything in this phase) so a second
  platform is additive later, not a migration.

## Prompt 1 — Tenant & session model generalization

```
Generalize this repo's tenant and admin-session model so it isn't
Shopify-exclusive at the schema level, while only Shopify is wired up
behind it for now.

Context: every table in prisma/schema.prisma keys on a `shop` string (a
*.myshopify.com domain). Admin routes under app/routes/app.*.tsx gate
entirely on authenticate.admin() from @shopify/shopify-app-react-router,
which only understands Shopify OAuth sessions.

Do:
1. Add a `platform` column (default "shopify") alongside `shop` on tables
   that will eventually need to distinguish tenants across platforms —
   at minimum ShopSettings, Service-related tables, Resource, Booking,
   Customer. Write the migration; backfill existing rows to "shopify".
2. Introduce a standalone `User` model (email/password or OAuth login,
   independent of the Shopify OAuth session) and a `Connection` model
   `{ userId, platform, shop, credentials (encrypted), status,
   connectedAt }` representing one linked store.
3. Add a session/auth layer for a new standalone app surface (see Prompt
   2) that resolves to a tenant-scoped session the same shape the
   existing embedded admin routes already expect, so admin route
   components can eventually be shared between the embedded Shopify UI
   and the standalone dashboard without a rewrite.
4. Do not change how the existing embedded /app/* routes authenticate —
   they keep using authenticate.admin() as-is. This prompt only adds the
   generalized layer alongside it.

Acceptance: existing embedded app continues to work unchanged; new
User/Connection tables and platform columns exist and are migrated;
a design note in docs/plan/ records how a Connection's credentials map to
a tenant session.
```

## Prompt 2 — Standalone central app: auth + Shopify connect flow

```
Build the standalone GetBooqin Cloud web app's entry points: user
signup/login, and "Connect Shopify store."

Do:
1. Email/password (or OAuth) signup/login creating a `User` row (from
   Prompt 1).
2. A "Connect Shopify" flow: reuse this app's existing Shopify OAuth
   (app/shopify.server.ts) to install/authorize, but associate the
   resulting offline access token with a `Connection` row tied to the
   logged-in `User` instead of only a bare Shopify session. A user can
   connect more than one Shopify store.
3. A store switcher in the standalone dashboard shell once more than one
   Connection exists.
4. Keep the existing embedded-in-Shopify-admin app entirely intact and
   working side by side — this is an additional front door, not a
   replacement.

Acceptance: a new user can sign up, connect a Shopify store via OAuth,
and land on an (initially empty/placeholder) dashboard scoped to that
Connection. Reconnecting the same shop from a different User should be
rejected or require an explicit transfer, not silently duplicate.
```

## Prompt 3 — Service catalog refactor: metafields + cache + Admin UI Extension

```
Replace the current Service model's ownership of catalog and
booking-config data with a metafield-backed cache, per the design
decisions above.

Context: today app/lib/data.server.ts's Service model owns name,
description, category, price, duration, buffers, capacity, etc., and
app/routes/webhooks.products.tsx auto-creates a Service snapshot from a
Shopify product typed "Service" (see Data.createServicesFromProducts).
ServiceProduct (prisma/schema.prisma) already links a Service to a
Shopify product by handle.

Do:
1. Add a `ServiceConfig` model: { id, shop, platform, productId,
   productHandle, durationMin, bufferBeforeMin, bufferAfterMin, capacity,
   locationType, paymentRequired, depositPercent, status, resourceLinks,
   addonLinks, platformUpdatedAt }. No name/description/price/category —
   those are read from the product, never stored here as editable state.
2. Add a `ProductCache` model: { shop, platform, productId, title, image,
   price, handle, updatedAt } — read-only reference cache, refreshed by
   webhook, never edited directly.
3. Define Shopify product metafields for the ServiceConfig fields
   (namespace e.g. "getbooqin"). Resource/add-on assignment metafields
   store lists of GetBooqin resource/addon IDs — the Resource/Addon
   registries themselves stay GetBooqin-only, only the assignment
   round-trips.
4. Write-through: editing ServiceConfig from GetBooqin's dashboard calls
   Shopify's metafieldsSet, then updates the local cache optimistically.
5. Read-back: repoint webhooks.products.tsx's handler so products/update
   (metafield changes included) refreshes ProductCache and ServiceConfig
   from the live product + metafields instead of auto-creating a
   snapshot Service row.
6. Loop prevention: before writing a metafield, compare against the
   cached value/platformUpdatedAt; skip the write if it would be a no-op,
   so a webhook-triggered refresh never re-triggers its own write.
7. Add a Shopify Admin UI Extension on the product details page rendering
   a form for the ServiceConfig fields (duration, buffers, capacity,
   resource/add-on pickers, payment/deposit), backed by the same
   metafields, so a merchant can configure booking from Shopify admin
   directly, not only from GetBooqin.
8. Migration: for existing Service + ServiceProduct rows, backfill
   ServiceConfig + write the corresponding metafields once; decide
   whether a Service with no linked product is even valid going forward
   (default: no — every bookable thing must map to a product) and handle
   any existing orphans accordingly.
9. Update everywhere that currently reads Service (availability engine,
   admin Services screen, storefront widget's serviceByProductHandle) to
   read ProductCache + ServiceConfig instead.

Acceptance: creating/editing booking config from GetBooqin dashboard is
reflected in the Shopify product's metafields and in Shopify admin's
extension panel; editing from the Shopify admin extension is reflected
back in GetBooqin within one webhook cycle; no infinite sync loop under
repeated edits from either side.
```

## Prompt 4 — Central dashboard: booking management + metrics

```
Build the standalone GetBooqin Cloud dashboard (from Prompt 2's shell)
to reach feature parity with the embedded admin's booking-workflow
screens, scoped to the active Connection.

Context: embedded admin screens live under app/routes/app.*.tsx —
Dashboard, Bookings, Services, Staff (Resources), Time Off, Customers,
Settings. Business logic for all of them already exists in app/lib/*
.server.ts and should be reused, not reimplemented.

Do:
1. Bookings: list/filter/status-transition/cancel/reschedule, same
   capabilities as app.bookings.tsx / app.bookings_.$id.tsx.
2. Resources (staff/rooms/etc.): CRUD + weekly schedules + time off,
   same as app.resources.tsx / app.timeoff.tsx.
3. Services: list of bookable products (from ProductCache) with
   "configure booking" editing ServiceConfig (Prompt 3) — no
   name/price/description editing here.
4. Customers: same as app.customers.tsx.
5. Settings: general/payments/notifications, same as app.settings.tsx.
6. Metrics dashboard: bookings over time, revenue, top services,
   resource utilization, no-show rate, payment status breakdown —
   computed from the same Prisma tables the embedded admin already
   queries, scoped to shop + platform.
7. Every write action goes through the same app/lib/*.server.ts
   functions the embedded admin uses — do not fork the business logic.

Acceptance: a merchant can do everything in the standalone dashboard that
they can do in the embedded Shopify admin app, for a connected store,
with metrics visible on first login.
```

## Prompt 5 (optional, recommended) — small-business adoption features

```
These are independent of the multi-platform work and valuable even with
Shopify as the only connector. Pick from:

- Guided setup wizard replacing the flat Settings screen: industry
  preset -> business hours -> first service/staff -> done, under 5
  minutes, reusing app/lib/presets.ts.
- SMS reminders (Twilio) alongside the existing email reminders in
  app/lib/mailer.server.ts and /cron/reminders.
- Waitlist and recurring bookings — both are explicit known gaps in
  DEVELOPERS.md's "Known limitations" section.
- Migration import (CSV or API) from Calendly/Square
  Appointments/Acuity into Customer/Booking/Service records.
- Post-booking review-request automation.

Each is independently shippable; do not bundle them into one PR.
```

## Next steps (not in scope for this phase)

- **WordPress/WooCommerce connector.** Rebuild the existing WordPress
  plugin as a thin interface only: a pairing/connect screen, a storefront
  widget calling GetBooqin's public API, and a WooCommerce product-data
  tab mirroring the Shopify Admin UI Extension from Prompt 3, storing the
  same booking-config fields as post meta instead of metafields. No local
  `os_*` tables, no local booking logic — same principle as Shopify, applied
  to WooCommerce.
- **Generalized public API auth.** Shopify's App Proxy HMAC
  (`app/lib/proxy.server.ts`) only exists on Shopify; WooCommerce needs an
  equivalent signed-request scheme (API key issued at pairing + HMAC, or a
  short-lived JWT) before its storefront widget can be trusted.
- **Additional platforms** (Wix, Squarespace, standalone sites) — each
  slots in as one more thin connector once the Shopify-only core above is
  built, following the same pairing + thin-plugin pattern as WooCommerce.
- **Hosted, platform-free booking page** — worth pulling forward
  independent of the phase above; it's the highest-leverage adoption item
  since it doesn't require the merchant to have any e-commerce platform at
  all.
