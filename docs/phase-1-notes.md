# Phase 1 — Trim

Two changes, both application-code only. **No destructive migrations:**
every table the removed features used is still there, so each cut is a
`git revert` away from coming back and no user data was ever at risk.

**37,245 → 31,236 lines** across `core/src`, `cloud/app`,
`shopify-openslot/app` — 6,009 removed. `Settings` went from **61 keys to
37**.

---

## PR 1 — remove the dark surfaces

Five feature areas that shipped code, hid their UI behind an `ENABLE_*`
env var, and had that var set nowhere in production. Nobody could use any
of them, and they accounted for a large share of the settings surface and
the `core/src/index.ts` export list.

| Cut | What went |
|---|---|
| **Visit summaries / AI** | `ai/patientSummary.ts`, `consultationSummary.ts`, the summary route, the recording-POC harness, `deepgram.server.ts`, `recording-capture.tsx`, the patient-facing summary view on the public booking page |
| **Merchant deposits** | `paymentManager.ts`, all four `gateways/*`, the three storefront payment routes, Settings → Payments, the Payment column and Revenue card, the storefront widget's whole pay flow |
| **Chat + FAQ** | `chatFlow.ts`, `app.chat`, three storefront chat routes, the orphaned `chat.js` widget asset |
| **WhatsApp + video meetings** | `whatsapp.ts`, `meetingManager.ts`, all three `meetings/*` providers, Settings → WhatsApp |
| **Add-ons** | the two admin screens (see the exception below) |

Also gone: `featureFlags.ts` and its five `ENABLE_*` vars, the four
capability-gated email templates (awaiting payment, payment received,
chat lead, visit summary) and `visibleTemplateDefs()` with them, and the
merge tokens that only those features populated.

### Two deliberate deviations from the plan

1. **`api/resources-addons` and `apps/getbooqin/addons` stayed.** The plan
   lists both under the add-ons cut, but neither is an add-ons screen.
   `api/resources-addons` backs the **resource** picker in the
   `getbooqin-service-config` admin block extension; deleting it breaks
   resource assignment from Shopify's own product page. (Its `addons` key
   is gone — the extension already guards on an empty list, so its
   shipped bundle degrades without a rebuild.) `apps/getbooqin/addons`
   backs the storefront widget's add-on step, which auto-advances on an
   empty list but shows the customer an **error screen** if the fetch
   rejects — deleting the route would have broken booking on every store.
2. **The storefront widget's add-on step is still there, inert.** It can
   only ever render an empty list now that nothing creates an add-on.
   Removing it means retargeting the wizard's step machine in ~1,700
   lines of untested vanilla JS; that belongs with Phase 4, which reworks
   that surface anyway. The payment flow *was* removed from the widget
   (−224 lines) because it was self-contained.

Both add-on pickers on the service-detail screens now render only when the
account already has add-ons, so a new account never sees a dead end.

---

## PR 2 — vocabulary replaces presets

Eleven industry presets, each carrying `terms` **plus** a `defaults` block
that overwrote eleven live settings keys whenever a preset was applied.
That single design choice is what `PRESET_CONTROLLED_KEYS`,
`applyPreset()`, `settings.customized_fields`, the "Preset default /
Customized" badges, the whole Settings → Business template page, and a
second parallel vocabulary system in the cloud app all existed to manage.

The user-visible value of all of it was **different words and different
starting numbers.** So that is all it is now:

- **Words** — `settings.terms`, eight free-text fields on Settings →
  General with suggestion chips. Type "Cohort", "Sitting", "Viewing" —
  whatever your business calls it is what the dashboard, the public
  booking page and every email say.
- **Starting numbers** — `STARTER_TEMPLATES`, read **once** during
  onboarding to seed the first services and a slot interval, and never
  read against that account again. There is no "switching" to reason
  about and nothing a merchant edits can be silently overwritten later.

`settings.preset` survives as a plain label for analytics. Nothing keys
behaviour off it.

**One source of truth for nouns.** `vocabFor(presetId)` — a map *derived*
from an id — became `vocabFor(settings.terms)`, the same object the mailer
and the public booking page already read. The two had drifted once before.

The Dashboard-layout picker (which Overview cards show) moved from the
deleted Business template page onto Settings → General, so
`hidden_overview_cards` keeps working.

---

## Deploying this

`core/scripts_backfill_terms.ts` is wired into the Docker `CMD`, next to
the existing resource-assignment backfill. It writes each shop's
vocabulary at rest and drops the dead `customized_fields` key. It is
idempotent — verified by running it twice against a real database, 8
updated then 0 — and `getSettings()` backfills at read time anyway, so the
script is tidiness, not a hard dependency. **It can be dropped from the
`CMD` line after one successful deploy.**

Nothing else is needed. No migration, no secret, no DNS.

---

## Verified

- `core` vitest: 164 passing, 25 files
- `npm run typecheck` clean in `core`, `getbooqin-cloud`, `shopify-getbooqin`
- production builds succeed for all three
- `node --check` on the storefront widget and `server/combined.js`
- the terms backfill, run twice against a live database

Not verified: nothing here has been exercised in a browser. The riskiest
untested surfaces are the new vocabulary form on Settings → General and
the storefront widget after the payment-flow removal.

---

## What Phase 1 deliberately left alone

- **Every table.** `Payment`, `Faq`, `ChatConversation`, `ChatMessage`,
  `ConsultationSummary`, `Addon`, `ServiceAddon`, `BookingAddon` all stay,
  along with `Booking.amountDue` / `paymentStatus` / `meetingUrl`. Dead
  tables cost nothing and keep every cut reversible.
- **The booking engine** — availability, overlap, duration, reschedule,
  waitlist, mailer. Untouched, as the plan requires.
- **The landing page's pricing.** `_index.tsx` still says $0/$29/$79. The
  plan puts that rewrite in Phase 2, with billing. The one bullet that
  advertised a feature this phase deleted ("Deposits & payments") was
  swapped for two that actually exist and aren't sold today (rooms as
  bookable resources, group/class bookings).
- **Settings is 6 pages, not 5.** General, Booking rules, Notifications,
  Integrations, Team — plus Account's two. W5's regrouping is Phase 3.
