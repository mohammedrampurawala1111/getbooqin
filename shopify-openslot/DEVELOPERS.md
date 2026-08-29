# GetBooqin for Shopify — developer notes

This is a port of the GetBooqin WordPress plugin to a Shopify app. The domain
model, business rules and REST surface are carried over line-for-line where
Shopify's architecture allows it; only the platform integration changed.

## What changed vs. the WordPress plugin, and why

| WordPress | Shopify | Why |
|---|---|---|
| PHP files dropped into `wp-content/plugins` | A standalone Node/React Router app, installed via OAuth from the Partner Dashboard | Shopify apps are external web apps, not files copied into the platform |
| `wpdb` + `os_*` MySQL tables, one site | Prisma + `ShopSettings`/`Service`/`Booking`/… tables, every row carries a `shop` column | One app instance now serves many stores, not one site |
| `getbooqin_settings` WP option | `ShopSettings` row, one per shop, same JSON-blob shape | Same idea, just keyed by shop |
| WP Admin menu pages (`Admin.php`) | Embedded admin UI under `/app/*`, React Router + Polaris | Shopify apps render inside the Shopify Admin iframe via App Bridge |
| Shortcodes (`[getbooqin_booking]`, …) | Theme App Extension blocks (`extensions/getbooqin-widgets`) | Shortcodes don't exist on Shopify; app blocks are the equivalent, added via the theme editor |
| `wp-json/getbooqin/v1/*` REST API, secured by a WP nonce | `/apps/getbooqin/*` routes behind Shopify's **App Proxy**, secured by Shopify's HMAC signature | The proxy signature *is* the auth — no nonce needed, and it proves the request really came from that shop's storefront |
| `do_action()` / `add_action()` hooks | `app/lib/events.server.ts`, a tiny typed `EventEmitter` | Same fan-out pattern (PaymentManager, MeetingManager and Mailer each subscribe from their own `init()`), just not WordPress-specific |
| WP-Cron (`wp_schedule_event`) | `/cron/reminders`, hit by an external scheduler | Node processes here don't have a cron scheduler baked in; see **Reminders & cleanup** below |
| `wp_mail()` | Nodemailer over SMTP (`SMTP_*` env vars) | No platform mailer to call into |
| WP roles/capabilities (`getbooqin_manage`) | Shopify OAuth session (`authenticate.admin`) | Anyone who can open the embedded app for a shop can manage that shop's data — Shopify's own admin access controls gate who gets that far |

Everything else — the slot engine, the booking state machine, the payment
gateway registry, the video provider registry, the scripted chat flow — is
the same code, translated from PHP/MySQL to TypeScript/Prisma.

## Data model

```
customers ──┐
services ───┼──> bookings <── resources ──> schedules   (weekly hours)
            │       │                    └─> timeoff     (blackouts; resourceId 0 = whole business)
            │       └──> payments         (one row per attempt)
            └──> serviceLinks (ServiceResource: who can deliver what, optional price/duration override)

chatConversations ──> chatMessages
faqs                                    (the scripted bot's knowledge)
```

Every table above additionally carries a `shop` column (the shop's
`*.myshopify.com` domain) — see `prisma/schema.prisma`. `ShopSettings` holds
the one JSON settings blob per shop, mirroring the WordPress option.

Money is stored as `Float` because the bundled dev datasource is SQLite,
which Prisma's `Decimal` type doesn't support. **Before going to
production**, point `datasource db` in `prisma/schema.prisma` at Postgres or
MySQL and change the money fields (`price`, `amountDue`, `amount`, …) to
`Decimal @db.Decimal(12, 2)`, the same as the original `DECIMAL(12,2)`
columns.

## Module map (`app/lib`)

| Module | Job | Ported from |
|---|---|---|
| `settings.server.ts` / `settingsShared.ts` | Per-shop settings, terminology helpers | `Settings.php` |
| `presets.ts` | Industry presets | `Presets.php` |
| `data.server.ts` | CRUD for services, resources, schedules, timeoff, customers, FAQs | `Data.php` |
| `availability.server.ts` | Slot generation, conflict checks | `Availability.php` |
| `bookings.server.ts` / `bookingsShared.ts` | Create/cancel/reschedule, status transitions, queries | `Bookings.php` |
| `paymentManager.server.ts` + `gateways/*` | Gateway registry, payment rows, paid/failed transitions | `PaymentManager.php`, `Gateways/*` |
| `meetingManager.server.ts` + `meetings/*` | Video provider registry, provisioning, join window | `MeetingManager.php`, `Meetings/*` |
| `chatFlow.server.ts` | Server-side scripted conversation state machine | `ChatFlow.php` |
| `mailer.server.ts` | Notifications, token replacement, reminders | `Mailer.php` |
| `events.server.ts` | Cross-module pub/sub | WordPress action hooks |
| `proxy.server.ts` | Shared helpers for the public `/apps/getbooqin/*` routes | `Rest.php` |

Files ending in `settingsShared.ts` / `bookingsShared.ts` hold the DB-free
subset of their `*.server.ts` counterpart (types, pure formatting functions,
constants). React Router strips `*.server.ts` imports out of the client
bundle entirely — fine for a loader, but it means a component can't call
`term()` or read `TRANSITIONS` from `bookings.server.ts` directly. Add new
pure helpers to the `*Shared.ts` file, not the `*.server.ts` one, if a route
component needs them.

## Events

The same fan-out `Bookings.php` used to do with `do_action()` now goes
through `app/lib/events.server.ts`:

| Event | Args | When |
|---|---|---|
| `booking_created` | `booking` | After a booking row is written |
| `booking_status_changed` | `booking, oldStatus, newStatus, reason` | Any status change |
| `booking_cancelled` | `booking, reason` | Status became `cancelled` |
| `booking_rescheduled` | `booking, previous` | Time or resource changed |
| `booking_deleted` | `booking` | Hard delete |
| `payment_completed` | `booking, paymentId` | A payment was verified server-side |
| `paid_booking_cancelled` | `booking, reason` | Hook here to automate refunds |
| `meeting_created` | `booking, meeting` | A join link was attached |
| `meeting_failed` | `booking, error` | Provider could not create a meeting |

`MeetingManager.provision` and `Mailer`'s `onCreated` both listen to
`booking_created`; `MeetingManager` runs first (registered first in
`app/lib/boot.server.ts`) and `Mailer` re-reads the booking before sending,
so confirmation emails contain the join link — same ordering guarantee the
WordPress version got from hook priorities 20/30.

## Public API — `/apps/getbooqin/*` (Shopify App Proxy)

Configured in `shopify.app.toml`'s `[app_proxy]` block. A storefront request
to `https://{shop}/apps/getbooqin/<path>` is verified and forwarded by
Shopify to this app's `/apps/getbooqin/<path>` route, with the shop's domain
and an HMAC signature attached — `proxyShop()` in `app/lib/proxy.server.ts`
validates that signature before any handler runs. No nonce, no cookie: the
proxy signature is the entire trust boundary, same job the WordPress
version's `wp_rest` nonce plus IP throttling did.

| Method | Route | Notes |
|---|---|---|
| GET | `/config` | Widget config + terminology |
| GET | `/services` | Active services |
| GET | `/resources?service_id=` | Who can deliver a service |
| GET | `/days?service_id=&resource_id=&limit=` | Next days that have free slots |
| GET | `/slots?service_id=&resource_id=&date=` | Slots for one day |
| POST | `/bookings` | Create. Honeypot field `os_hp_a1b2`, throttled 8 per 10 min per IP |
| GET | `/bookings/{uid}` | Public read by unguessable token |
| POST | `/bookings/{uid}/cancel` | Honours the cancellation cutoff |
| POST | `/chat/start` | Opens a conversation |
| POST | `/chat/message` | One conversation turn |
| GET | `/chat/{uid}` | Resume a conversation after a page reload |
| POST | `/payments/start` | Begin a payment for a booking UID |
| POST | `/payments/verify` | In-page confirmation (signature checked server-side) |
| GET | `/payments/return/{gateway}` | Gateway redirect target; verifies, then sends the customer to their booking page |

The rate limiter in `app/lib/http.server.ts` is an in-memory `Map` — fine for
a single long-running Node process, but it resets on deploy and doesn't
share state across horizontally-scaled instances. Swap it for Redis if you
run more than one app instance.

## Admin UI — `/app/*`

Embedded routes under `app/routes/app.*`, authenticated via
`authenticate.admin(request)` (Shopify OAuth session), rendered with classic
Polaris React (`@shopify/polaris`) inside the App Bridge shell
(`@shopify/shopify-app-react-router/react`). Screens: Dashboard, Bookings,
Services, Staff (Resources), Time Off, Customers, Chat (FAQs +
conversations), Settings (General / Payments / Video calls / Notifications /
Chat widget).

## Storefront — Theme App Extension (`extensions/getbooqin-widgets`)

Shortcodes became app blocks:

| WordPress shortcode | Shopify block | Type |
|---|---|---|
| `[getbooqin_booking]` | `booking-widget.liquid` | app block (drag into a section) |
| `[getbooqin_services]` | `services-grid.liquid` | app block |
| `[getbooqin_staff]` | `staff-grid.liquid` | app block |
| footer-injected chat widget | `chat-widget.liquid` | **app embed block** (toggled site-wide under Theme Editor → App embeds, not placed manually) |

`assets/booking.js` and `assets/chat.js` are close ports of the original
`assets/js/booking.js` / `chat.js`. The one structural difference: Liquid
can't `wp_localize_script()` a config blob at render time, so these files
call `/apps/getbooqin/config` themselves on load — that path is relative to
the current storefront page, so the App Proxy picks it up automatically,
signed, with no extra work on the client.

`?getbooqin_booking=UID` on the page holding the booking block switches it to
the "manage an existing booking" view, same convention as the WordPress
version — except it's rendered client-side (`renderManageCard()` in
`booking.js`) since Liquid has no way to call the app's API while rendering
the page.

## Extending

### Add a payment gateway

```ts
// app/lib/gateways/myGateway.ts
import { Gateway, type GatewayContext, type StartResult } from "./gateway";

export class MyGateway extends Gateway {
  id() { return "mygateway"; }
  label() { return "My Gateway"; }
  isConfigured(ctx: GatewayContext) { return !!this.setting(ctx, "api_key"); }
  settingsFields() { return [{ key: "api_key", label: "API key", type: "password" }]; }
  async start(ctx, booking, payment): Promise<StartResult> { /* … */ }
}
```

Register it in `app/lib/paymentManager.server.ts`'s `REGISTRY`. Implement
`start()` and either `handleReturn()` (redirect gateways) or `handleVerify()`
(in-page confirmation, like Razorpay). **Never call `PaymentManager.markPaid()`
from client input** — only after verifying with the provider directly, same
rule as the WordPress version.

### Add a video provider

Same pattern in `app/lib/meetings/`, registered in
`meetingManager.server.ts`'s `REGISTRY`. Return `needsReprovision(): true` if
meetings are tied to a start time (like Zoom), so a reschedule creates a
fresh one.

### Add an industry preset

Add an entry to `PRESETS` in `app/lib/presets.ts`.

### Extend the chat flow

Each step is an entry in the `STEPS` map in `app/lib/chatFlow.server.ts`,
`(shop, settings, conversation, state, data, value) => Promise<Turn>`.
`state.step` names the handler for the *next* turn. The visitor can always
escape with `ChatFlow.MENU`, and an unknown step falls back to the menu
rather than erroring — same as the WordPress version.

## Setup

1. **Create the app** in the [Partner Dashboard](https://partners.shopify.com)
   or via `shopify app config link`, then fill in the real `client_id` and
   URLs in `shopify.app.toml` (the placeholders start with `REPLACE_WITH_`).
2. `npm install`
3. Point `DATABASE_URL` in `.env` at a database (SQLite is fine for local
   dev — see `.env.example`), then `npx prisma migrate dev`.
4. `npm run dev` (wraps `shopify app dev`) — this tunnels your app, updates
   `shopify.app.toml`, and lets you install it on a dev store.
5. In the dev store's theme editor, add the **GetBooqin Booking** block to a
   page, and turn on the **GetBooqin Chat Widget** app embed.
6. Go to the embedded app → **Settings → General** and apply the preset
   closest to your industry, then set the shop timezone.
7. Add services and resources (staff/rooms/bays/tables) and their weekly
   hours.

### Reminders & cleanup

There's no WP-Cron here. Point an external scheduler at `/cron/reminders`,
hourly, with `Authorization: Bearer <CRON_SECRET>` (generate one with
`openssl rand -hex 32` and set it in both your env and the scheduler). A
GitHub Actions workflow works well if you don't already run one elsewhere:

```yaml
# .github/workflows/getbooqin-cron.yml
on:
  schedule:
    - cron: "0 * * * *"
jobs:
  reminders:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -fsS -X POST https://your-app-url/cron/reminders \
            -H "Authorization: Bearer ${{ secrets.GETBOOQIN_CRON_SECRET }}"
```

This single call sends due reminder emails **and** sweeps abandoned chat
conversations older than 30 days (same retention rule as
`ChatFlow::cleanup()`), across every shop that has the app installed.

### Email

`app/lib/mailer.server.ts` uses Nodemailer over plain SMTP
(`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`). Any transactional email
provider's SMTP endpoint works (Postmark, SES, Resend, etc.). With no
`SMTP_HOST` set, emails are logged to the console instead of sent — useful
for local dev, not for anything else.

## Known limitations (honest list, same spirit as the original)

- Buffers are applied from the *candidate* service, not the buffers of
  neighbouring bookings. For most businesses this is indistinguishable; for
  asymmetric buffers it is not exact.
- Refunds are not automated. A cancelled paid booking fires
  `paid_booking_cancelled` and is marked in the admin, but the refund itself
  is a business decision made in the gateway dashboard.
- Jitsi rooms have no password. Secrecy comes from the unguessable room
  name; run your own Jitsi with JWT auth if you need real access control.
- Payment webhooks are not implemented. Verification happens on
  return/confirm, which covers the normal path but not a customer who closes
  the tab mid-payment — those stay Unpaid until they return via the manage
  link.
- No recurring bookings and no waitlist.
- The in-memory rate limiter and OAuth token caches (PayPal, Zoom) live in
  process memory — correct for one instance, reset on deploy, not shared
  across a horizontally-scaled fleet. Swap for Redis if you run more than
  one instance.
- Group capacity (`capacity > 1`) matches on exact start time, so
  overlapping group sessions of the same service are not merged.
- Classic Polaris React (`@shopify/polaris`) is used for the admin UI rather
  than the newer Polaris web components Shopify is migrating toward. It
  still works fine; migrating is a purely cosmetic follow-up, not a
  correctness issue.
