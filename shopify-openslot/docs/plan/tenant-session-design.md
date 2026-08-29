# Tenant & session model — design note (Prompt 1)

Records where the generalized tenant/session layer lives and how it maps
onto the existing embedded app, per `getbooqin-cloud-plan.md`'s Prompt 1.

## Where things live

`core/` is a new, standalone Node/Prisma project — not a workspace package
imported by `shopify-openslot`, and not a modification of
`shopify-openslot`'s own schema. It is the first piece of the "single
backend" from the vision doc: the eventual system of record for the
booking workflow, reachable by every platform front door (Shopify today,
others later).

`shopify-openslot` is untouched by this prompt. Its `prisma/schema.prisma`,
`authenticate.admin()`, and every `app/routes/app.*.tsx` route keep working
exactly as before — this prompt only stands up the generalized layer
alongside it, ready for Prompt 2 to build the standalone app on top of.

- `core/prisma/schema.prisma` — the booking-workflow models (`Service`,
  `Resource`, `Schedule`, `TimeOff`, `Customer`, `Booking`, `BookingAddon`,
  `Payment`, `Addon`, `Faq`, `ChatConversation`) carried over from
  `shopify-openslot`'s schema, each now keyed on `(platform, shop)` instead
  of `shop` alone. Plus two new models: `User` and `Connection`.
- `core/src/auth/` — password hashing, credential encryption, and the
  tenant-session module described below.

## `Connection` → tenant session

A `Connection` is one store a `User` has linked:

```
Connection { id, userId, platform, shop, credentials, status, connectedAt }
```

`credentials` holds whatever the platform's auth flow returns — a Shopify
offline access token, for now — encrypted at rest with AES-256-GCM
(`src/auth/encryption.ts`, key from `CONNECTION_ENCRYPTION_KEY`). `(platform,
shop)` is unique: a store can only ever be linked to one `User` at a time,
enforced at the DB level. Prompt 2's connect flow is responsible for
turning "shop already connected elsewhere" into an explicit
reject-or-transfer decision — this prompt only guarantees the constraint
exists to make that possible.

A `TenantSession` is the runtime shape derived from a `Connection`:

```
TenantSession { shop, platform, userId, connectionId }
```

This is deliberately the same shape existing embedded routes already
destructure — `const { session } = await authenticate.admin(request); const
shop = session.shop;` — so once Prompt 4 shares admin route components
between the embedded Shopify UI and the standalone dashboard, a component
reading `session.shop` doesn't care which auth path produced it.

### Token, not a session table

`createSessionToken(session)` (`src/auth/session.ts`) issues a stateless,
HMAC-signed token (`SESSION_SIGNING_SECRET`) carrying the `TenantSession`
fields plus an expiry — no server-side session table to join on every
request, unlike Shopify's `Session` model (which stores are per-OAuth-session
rows because Shopify's own token lifecycle requires it).

Revocation still works without a session table: `verifySessionToken()`
checks the signature and expiry, then re-reads the `Connection` row and
rejects if it's missing or `status !== "active"`. Revoking a `Connection`
(disconnect, credential rotation, admin action) invalidates every token
derived from it on the next request, even though the token itself doesn't
expire until the full 30-day TTL.

`resolveTenantSession(cookieHeader)` reads the `gb_session` cookie and
returns a `TenantSession | null`. It takes a raw `Cookie` header string
rather than a framework-specific `Request` type, so it can be wired into
whichever HTTP layer Prompt 2 picks (Express, Fastify, React Router)
without a rewrite.

## Prompt 2: the standalone app

Built in `cloud/` — a new React Router v7 app, sibling to `core/` and
`shopify-openslot/`, wired to `core` via an npm workspace
(`getbooqin/package.json`) so it imports the session/connection helpers
above directly instead of duplicating them.

- `gb_user` cookie (`UserSession { userId }`, `core/src/auth/session.ts`) —
  minted at signup/login, before any store is connected. This is new since
  Prompt 1: `TenantSession` alone can't represent "logged in, no store
  picked yet" because it requires a `connectionId`.
- `/connect/shopify` (`cloud/app/routes/connect.shopify.tsx`) signs
  `{ userId, shop }` as the OAuth `state` param (`core/src/platforms/
  shopify.ts`, reusing the generic `signPayload` from session.ts — no
  server-side state store) and redirects to Shopify's authorize URL, using
  the same `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET`/`SCOPES` as
  shopify-openslot's embedded app. Only the redirect URI differs — the
  Partner Dashboard needs `${APP_URL}/connect/shopify/callback` allow-listed
  as a second, non-embedded redirect URL on that same app.
- `/connect/shopify/callback` verifies the callback HMAC and the signed
  state, exchanges the code for an offline token, then calls
  `connectShopifyStore` (`core/src/connections.ts`): upserts a `Connection`
  if unclaimed or already owned by this user, and throws
  `ShopAlreadyConnectedError` — surfaced as a 409, not a silent duplicate —
  if the `(platform, shop)` is owned by a different `User`. An explicit
  transfer flow is not built; rejection satisfies the acceptance criterion
  as-is.
- Picking a connected store mints the `TenantSession` cookie
  (`dashboard.$connectionId.tsx`), landing on a placeholder dashboard scoped
  to that `Connection` — the booking-workflow UI itself is a later prompt.

## Prompt 3: the catalog refactor

Built entirely inside `shopify-openslot` (not `core`/`cloud`, which Prompt 3
doesn't touch) — this replaces what `Service` used to own.

- `prisma/schema.prisma`: `Service` evolved in place into `ServiceConfig`
  (`@@map("Service")`, same physical table/ids — `Booking`/`ServiceResource`/
  `ServiceAddon` FKs needed no remapping) holding only booking config
  (duration/buffers/capacity/location/payment/deposit/status) plus a 1:1
  `productId`/`productHandle`. New `ProductCache` model caches the product's
  name/price/category/description/image, read-only, refreshed by
  `webhooks.products.tsx`. `ServiceProduct` (many-products-to-one-service) is
  gone — a Service linked to multiple products backfills into one
  `ServiceConfig` row per product (see `scripts/backfill-service-config.ts`),
  each carrying over the original values, rather than collapsing to one and
  dropping the rest's "Book now" button.
- `app/lib/data.server.ts`: `catalogService`/`catalogServices` join
  `ServiceConfig`+`ProductCache` back into the old `Service`-shaped
  (`CatalogService`) object, so the ~15 read-only consumers (availability
  engine, bookings, payments, gateways, meetings, chat, mailer, proxy) only
  needed their call site renamed, not their logic touched.
- `app/lib/serviceMetafields.server.ts`: the `getbooqin`-namespace metafield
  read/write/diff shared by `app.services_.$id.tsx` (GetBooqin's own
  write-through) and the `getbooqin-service-config` Admin UI Extension (which
  talks to Shopify directly via its own `query()`, never through the app
  backend — duplicates the namespace/key constants since an extension bundle
  can't import server-only app code).
- `webhooks.products.tsx` only ever reads from Shopify and writes to the
  local cache — it never calls `metafieldsSet` itself, so a write-triggers-
  write cycle is structurally impossible; the value-equality check in
  `diffServiceConfigFields` just avoids a redundant DB write on the echo
  webhook Shopify sends back after GetBooqin's (or the extension's) own
  metafield write.
- `shopify.app.toml`/`shopify.app.production.toml`: `access_scopes` gained
  `write_products` (was `read_products` only) — required for
  `metafieldsSet`; already-installed merchants see a re-consent screen on
  next login as a result.
- Storefront-facing `color` (the services-grid swatch) stayed a plain
  `ServiceConfig` column, not metafield-synced — it's a GetBooqin-only
  display preference with no Shopify product equivalent, outside what this
  refactor migrates.

## Prompt 4: the standalone dashboard, and pulling the single-backend plan forward

Prompt 4 asks the standalone `cloud` dashboard to reach feature parity with
the embedded admin's booking screens, reusing `app/lib/*.server.ts` rather
than forking the logic. That instruction ran into a real gap: `core`/`cloud`
and `shopify-openslot` are two separate npm projects with two separate
Postgres databases, `core`'s schema was never updated for Prompt 3's
`ServiceConfig`/`ProductCache` split, and `core/src` only exported
auth/session/connection primitives — none of the booking-workflow logic
lived there yet. Literal function-level reuse across that process boundary
wasn't possible as the code stood.

Asked how to resolve it, the direction was explicit: host the backend in one
place, and every front door — the embedded Shopify app, the standalone
dashboard, future platforms — calls that same backend. That's the "single
system of record" framing from Prompt 1's own design note (`core` as
*"the eventual system of record for the booking workflow, reachable by every
platform front door"*), pulled forward now instead of left implicit.

**Phased scope, confirmed explicitly**: reaching full parity would mean
migrating `shopify-openslot`'s live production data into `core` and
rewiring its routes to call out instead of querying locally — real risk on
a live app. So this prompt built the foundation and the standalone
dashboard only; `shopify-openslot`'s own cutover (data migration + rewiring
its routes to call `core`) is deliberately deferred to its own,
separately-confirmed step. Concretely: until that cutover ships, a merchant
who connects an *existing* shopify-openslot store via the standalone
dashboard won't see their existing bookings/customers there — `core`'s
database starts empty for booking data. The dashboard works correctly
against whatever flows into `core` from here on (bookings created via the
dashboard itself, products synced from Shopify directly using the
connection's stored token) — it just isn't yet a mirror of the live
embedded-admin data. `shopify-openslot/app/` itself is untouched by this
prompt.

- `core/prisma/schema.prisma` caught up to Prompt 3: the old denormalized
  `Service`/`ServiceProduct` models were replaced with `ServiceConfig` +
  `ProductCache`, field-for-field matching `shopify-openslot`'s schema,
  keeping the `platform`/`shop` composite keys already present on every
  model there (unlike `shopify-openslot`, which only ever serves one
  platform and doesn't need them on most tables).
- `core/src/booking/*.ts` (new): `shopify-openslot/app/lib/*.server.ts`'s
  generic modules ported near-verbatim — `data.ts`, `bookings.ts`,
  `availability.ts`, `paymentManager.ts` + `gateways/*`, `meetingManager.ts`
  + `meetings/*`, `mailer.ts`, `chatFlow.ts`, `settings.ts`,
  `serviceMetafields.ts`, plus the small infra files (`ids`, `errors`,
  `events`, `bookingsShared`, `settingsShared`, `presets`, `boot`,
  `featureFlags`). The only systematic change versus the source: every
  function gained an explicit `platform` parameter alongside `shop`, since
  `core` serves more than one platform's tenants from one database where
  `shopify-openslot` only ever served Shopify.
- `core/src/booking/metrics.ts` (new): bookings-over-time, revenue,
  top services, resource utilization, no-show rate, payment status
  breakdown — none of this existed anywhere to port; the embedded admin's
  own Dashboard only ever computed four ad-hoc counters. Revenue is
  aggregated from `Payment` rows grouped by currency, not by summing
  `Booking.amountDue` for `paymentStatus === "paid"` the way the embedded
  admin's stat does, since that shortcut silently mixes currencies and
  reflects what was owed rather than what a gateway actually settled.
- `core/src/platforms/shopifyAdmin.ts` (new): a raw-access-token Shopify
  Admin GraphQL client — the standalone-app complement to
  `shopify-openslot`'s embedded `admin.graphql()`, using the connection's
  stored offline token (decrypted via `auth/encryption.ts`) instead of a
  live Shopify-authenticated request. Does two jobs: `syncProductsFromShopify`
  (the only way `core`'s `ProductCache` gets populated before
  `shopify-openslot`'s webhooks are repointed here) and
  `pushServiceConfigMetafields`/`readServiceConfigMetafields` (mirroring
  `serviceMetafields.server.ts`'s write-through, so editing booking config
  from the standalone dashboard stays in sync with the same
  `getbooqin`-namespace metafields the embedded admin and its Admin UI
  Extension use).
- `core/src/index.ts` gained namespace re-exports (`Data`, `Bookings`,
  `Availability`, `PaymentManager`, `MeetingManager`, `Mailer`, `ChatFlow`,
  `Settings`, `Metrics`, `ServiceMetafields`, `ShopifyAdmin`, …) matching the
  `import * as Data from "..."` convention `shopify-openslot`'s own routes
  already use, so `cloud`'s routes read the same way. No HTTP API layer was
  added — `cloud` keeps consuming `core` as a direct in-process workspace
  import (today's existing pattern); an HTTP layer is real future work for
  whenever `shopify-openslot`'s cutover gives `core` a second, out-of-process
  caller, not something worth building speculatively now.
- `cloud/app/routes/dashboard.$connectionId.tsx` became a layout (nav +
  `<Outlet/>`) with nested screens for Overview (metrics), Bookings,
  Resources (+ weekly schedules), Time off, Services (config-only editing —
  name/price/description stay read-only from `ProductCache`, with a
  "Sync products" action calling `ShopifyAdmin.syncProductsFromShopify`),
  Customers, and Settings — each screen's loader/action derives
  `{shop, platform}` via the new `cloud/app/tenant.server.ts` helper and
  calls `core`'s newly-ported functions directly, so there is exactly one
  implementation of each piece of business logic.
