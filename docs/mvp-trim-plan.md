# MVP trim plan — one booking product, self-serve onboarding

**Goal:** a user signs up, names their business, picks what they call things
("Booking" / "Appointment" / "Consultation" / "Cohort" / anything they type),
adds a service and some hours, and gets a working public booking link — in
under five minutes, with no Shopify store, no WordPress site, and no industry
preset to reason about. They start on a free trial, can upgrade to a paid plan
from inside onboarding, and we can grant any account early access or a discount
from a platform admin console. Everything else becomes an opt-in integration or
comes out of the build.

**Two things this plan adds, not just cuts:** subscription billing (§W7) and a
platform admin console (§W8). Everything else is removal.

Current app code: **37,245 lines** across `core/src`, `cloud/app`,
`shopify-openslot/app`. This plan removes roughly **10,000** of them without
touching anything a first-time user actually needs.

---

## 1. Where the complexity actually is

Five things make the product feel big. None of them are the booking engine —
that part (availability, bookings, schedules, email) is the good code and stays
untouched.

### 1.1 Eleven industry presets, wired into everything

`core/src/booking/presets.ts` ships 11 presets (generic, clinic, dental, salon,
automotive, legal, education, fitness, realestate, restaurant, homeservice).
Each one carries `terms` *plus* `defaults` that overwrite 11 live settings keys
(`PRESET_CONTROLLED_KEYS` — rules, consent text, widget copy, four email
templates).

That single design choice spawned:

- `customized_fields` bookkeeping in `ShopSettings`, plus per-key
  "Preset default / Customized" badges, plus `applyPreset(force)` as the only
  way to undo them ([settings.ts](core/src/booking/settings.ts) ~120 lines of
  comment and logic explaining edge cases).
- A whole **second, parallel vocabulary system**:
  [cloud/app/lib/presets.ts](cloud/app/lib/presets.ts) (523 lines) with
  `PREVIEW`, `rulesFor`, `ruleChips`, `featureNotesFor`, `startingRulesDiff`,
  `RULE_LABELS`, `summarizeHours`. The cloud dashboard reads
  `vocabFor(presetId)` — a *derived* map — while the Shopify admin and the
  mailer read the *stored* `settings.terms`. Two sources of truth for the same
  nouns, already drifted once (that file's own header comment says so).
- A Settings → Template page whose whole job is explaining what switching a
  preset will and won't overwrite.
- Feature gating by preset: `CLINIC_FEATURE_PRESETS` / `isClinicFeaturePreset`
  exists because Visit Summaries was gated on `preset === "clinic"` at ten call
  sites across six files.

**The user-visible value of all of that is: different words, and different
starting numbers.** That is worth about 80 lines, not 977.

### 1.2 Two complete admin UIs

| Screen | Cloud dashboard | Shopify embedded admin |
|---|---|---|
| Bookings list + detail | ✅ 1,069 lines | ✅ 857 lines (Polaris) |
| Calendar | ✅ 264 + 460 | ✅ 674 |
| Services | ✅ 3 routes | ✅ 2 routes |
| Resources | ✅ 2 routes | ✅ 2 routes |
| Time off | ✅ | ✅ |
| Waitlist | ✅ | ✅ |
| Customers | ✅ | ✅ |
| Settings | ✅ 1,375 | ✅ 879 |

`shopify-openslot/app/routes/app.*` is **4,898 lines** of Polaris that
re-implements screens the cloud dashboard already has, against the same
database. Every feature change has to be made twice, and every bug found in QA
has to be fixed twice.

### 1.3 Feature surfaces that are built but dark in production

`fly.toml` sets none of the `ENABLE_*` flags, so in production today these are
all **off** — the code ships, the UI is hidden, and nobody can use any of it:

| Surface | Flag | Lines |
|---|---|---|
| Payments (Stripe, Razorpay, PayPal) | `ENABLE_PAYMENTS` | 799 |
| Chat widget + FAQ | `ENABLE_CHAT` | 843 |
| WhatsApp Business + Zoom meetings | `ENABLE_WHATSAPP` | 593 |
| Visit summaries + AI patient summary + recording POC + Deepgram | `ENABLE_VISIT_SUMMARIES`, `ENABLE_RECORDING_POC` | 2,720 |
| Add-ons | (none — Shopify admin only) | 260 |

That's **5,215 lines of maintenance cost with zero current users.** They also
account for a large share of the settings surface (`chat_*` alone is 11 keys),
the schema (`Payment`, `Faq`, `ChatConversation`, `ChatMessage`,
`ConsultationSummary`, `Addon`, `ServiceAddon`, `BookingAddon`), and the
`core/src/index.ts` export list.

### 1.4 Onboarding is shaped around Shopify

The 4-step wizard ([onboarding.tsx](cloud/app/routes/onboarding.tsx), 758
lines) has two possible exits: connect a real Shopify store (step 3/4, answers
ride through the OAuth `state` because there's no Connection row yet), or "Go
live without Shopify". The non-Shopify path — which is the path essentially
every new user should take — is framed as the fallback, and needed its own
`channel_setup_skipped` settings key so the Overview checklist would stop
nagging about a decision the user already made.

### 1.5 Settings has nine pages

`general, template, rules, notifications, payments, whatsapp, visit_summaries,
integrations, team` — four of which are dark features.

---

## 2. What the MVP is

**Keep, untouched or lightly trimmed:**

- Services (with duration, price, colour, location)
- Resources (staff / rooms) + weekly schedules + time off
- Availability engine, booking rules, overlap/duration logic
- Bookings: list, detail, calendar, status changes, reschedule, cancel
- Customers
- Public booking page `/book/:slug` + customer manage/cancel/reschedule
- Email: confirmations, reminders, templates
- Waitlist
- Team (owner/admin/write/read + invites)
- Settings: Business, Vocabulary, Booking rules, Notifications, Integrations

**Add for MVP:**

- **Billing** — Free plan, 30-day trial, paid tiers at $5 / $10 / $15,
  self-serve upgrade, downgrade and cancel (§W7)
- **Platform admin console** — per-account plan changes, feature grants,
  discounts, audit log (§W8)

**That is a complete, sellable booking product.** Nothing in §1.3 is needed for
a first customer to succeed.

---

## 3. Workstreams

Each workstream is one or two PRs, independently shippable, in the order given.
Rule for every removal: **delete application code, leave the database tables in
place.** No destructive migrations, so every cut is a `git revert` away from
coming back, and no user data is ever at risk.

---

### W1 — Replace presets with editable vocabulary  *(the big one)*

**What the user gets:** on Settings → Business, a "What do you call things?"
card with four singular/plural pairs — free-text inputs with suggestion chips.

```
Bookings are called    [ Consultation ] [ Consultations ]
                       suggestions: Booking · Appointment · Session · Class · Job · Reservation
Services are called    [ Treatment    ] [ Treatments    ]
Who/what gets booked   [ Practitioner ] [ Practitioners ]
Customers are called   [ Patient      ] [ Patients      ]
```

That's it. Cohort, sitting, viewing, consult — whatever they type is what the
whole dashboard, booking page and emails say.

**Changes:**

1. `core/src/booking/presets.ts` — collapse to a single `defaultTerms()` plus a
   small `STARTER_TEMPLATES` array used **only as onboarding seed data**
   (label, suggested terms, 3–4 sample services, default slot interval). No
   `defaults` writing 11 settings keys, no ongoing coupling to a shop after
   onboarding. ~977 lines → ~120 across both preset files.
2. Delete `PRESET_CONTROLLED_KEYS`, `applyPreset()`, `settings.customized_fields`
   and the `fromPreset` branch of `setSettings()`
   ([settings.ts](core/src/booking/settings.ts)).
3. `cloud/app/lib/presets.ts` — delete `PREVIEW`, `rulesFor`, `ruleChips`,
   `featureNotesFor`, `startingRulesDiff`, `RULE_LABELS`, `getPreset`,
   `isClinicFeaturePreset`, `CLINIC_FEATURE_PRESETS`, `INTEGRATION_ORDER_OVERRIDE`.
4. **One source of truth for nouns:** change `vocabFor(presetId)` →
   `vocabFor(settings.terms)` and keep `useVocabulary()` exactly as is. The
   dashboard layout already loads settings per request, so this is a signature
   change, not new plumbing. Every consumer keeps working.
5. Add the vocabulary card + `_section=vocabulary` action to
   [dashboard.$connectionId.settings.tsx](cloud/app/routes/dashboard.$connectionId.settings.tsx);
   delete the `page === "template"` block entirely.
6. Keep `settings.preset` as a plain string label ("what kind of business")
   for analytics only — nothing reads it for behaviour any more.

**Migration for existing shops:** none needed at write time — `settings.terms`
is already populated for every shop from its preset. A one-off backfill script
fills `terms` for any row where it's null, and `customized_fields` is simply
ignored and dropped from the type.

---

### W2 — Onboarding: 3 steps, no Shopify branch

**New flow:**

1. **Your business** — name, timezone, currency, contact email/phone, plus a
   "What kind of business?" tile row that *only* seeds sample services and
   vocabulary (clearly labelled "you can change all of this later").
2. **What you offer** — the seeded services, editable; one resource with
   weekly hours.
3. **You're live** — the public booking link, with Copy, "Open booking page",
   a QR code, and an "Embed on your website" `<iframe>`/script snippet. Then
   → Dashboard.

**Changes:**

- Delete `StepIntegrations` and `StepGoLive`'s Shopify half, and
  `ShopifyConnectForm` from [onboarding.tsx](cloud/app/routes/onboarding.tsx).
  `/connect/shopify` stays a real route, reachable only from Settings →
  Integrations.
- Delete `settings.channel_setup_skipped` — with no channel step there is
  nothing to skip.
- `setupTasks()` in cloud/app/lib/presets.ts → 5 items:
  name business, add a service, add bookable hours, share your booking link,
  turn on reminders. Drop "Choose your industry preset" and "Connect a channel".
- Onboarding is 758 → ~400 lines.

---

### W3 — Shopify becomes an integration, not a second product

**Rule:** the cloud dashboard is the only admin UI. The Shopify app keeps
exactly what only it can do.

**Keep in `shopify-openslot`:** OAuth/install (`auth.*`, `shopify.server.ts`),
the storefront app proxy (`apps.getbooqin.*` — slots, bookings, days, services,
resources, waitlist, manage/cancel/reschedule), theme extensions
(`extensions/`, the booking widget), webhooks, `cron.reminders`,
`cron.waitlist`, `privacy`/`terms`.

**Replace:** all 15 `app.*` embedded admin routes with **one** screen — install
status, embed-detection state, and "Manage bookings in GetBooqin →" deep links
into the cloud dashboard. `app.tsx` shell stays; everything under it goes.

**Removes:** 4,898 + 65 lines, and permanently ends double-maintenance.

⚠️ **Verify before merging:** confirm this still satisfies Shopify App Store
embedded-app review (`shopify-openslot/docs/plan/app-store-submission.md`).
A thin embedded app that links out is normally fine, but if App Store listing
is in the near-term plan, budget a review pass. If listing is *not* in MVP
scope, this PR can go further and drop `shopify.app.toml` distribution config
too.

---

### W4 — Remove the dark surfaces

One commit each, application code only, tables left alone.

| # | Cut | Files | Settings keys dropped |
|---|---|---|---|
| 4a | **Visit summaries / AI / recording POC** — summary route, recording-poc route, recording-capture component, deepgram.server, `ConsultationSummary`, `ai/patientSummary` | 2,720 lines, 6 files | `visit_summaries_enabled`, `visit_summary_default_language`, `visit_summary_consent_line` |
| 4b | **Payments** — `paymentManager`, `gateways/{stripe,razorpay,paypal}`, the two proxy payment routes, Settings → Payments | 799 lines | `enabled_gateways`, `gateways`, `default_deposit` |
| 4c | **Chat + FAQ** — `chatFlow`, `app.chat`, 3 proxy chat routes, `chat-widget.liquid` | 843 lines | 11 `chat_*` keys |
| 4d | **WhatsApp + video meetings** — `whatsapp.ts`, `meetingManager`, `meetings/zoom`, Settings → WhatsApp | 593 lines | `whatsapp_enabled`, `whatsapp`, `video_provider`, `video`, `video_join_window` |
| 4e | **Add-ons** — `app.addons*`, `apps.getbooqin.addons`, `api.resources-addons` | 260 lines | — |

Also delete `core/src/booking/featureFlags.ts` and its five `ENABLE_*` env
vars — with the features gone there is nothing left to flag — and trim the
matching exports from `core/src/index.ts`.

**`Settings` interface: 60+ keys → ~30.** That alone makes the settings page
comprehensible.

⚠️ **"Payments" means two different things in this codebase — don't conflate
them.**

| | Who pays whom | Status in this plan |
|---|---|---|
| **Merchant deposits** (4b above) | A *customer* pays the *merchant* a deposit for a booking, through the merchant's own Stripe/Razorpay/PayPal keys | **Cut.** Dark today, no users, re-add post-MVP as an integration |
| **Platform billing** (§W7) | The *merchant* pays *us* $5/mo for GetBooqin | **Built for MVP** — new code against PayPal Subscriptions and Razorpay Subscriptions, not a revival of `gateways/` |

Cutting 4b does **not** block W7, even though both name PayPal and Razorpay.
4b is *one-off charge intents using each merchant's own API keys*; W7 is *one
platform account running recurring subscriptions*. Different APIs, different
credentials, different lifecycle — the only shared thing is the vendor's name.
If merchant deposits turn out to be a month-two requirement, the revival is
cheap precisely because W7 will already have both vendors' SDKs and webhook
plumbing in the tree.

---

### W5 — Settings: 9 pages → 5

`Business` (identity + vocabulary + booking page) · `Booking rules` ·
`Notifications` · `Integrations` · `Team`.

Integrations page becomes the single home for anything optional: Shopify
("Connect a store"), and a "Coming soon" list for WordPress/WhatsApp/Calendar
that is honest about not existing yet rather than rendering a tile that goes
nowhere. `INTEGRATIONS` in cloud/app/lib/presets.ts moves to its own
`cloud/app/lib/integrations.ts` and loses the per-preset ordering table.

Settings route: 1,375 → ~700 lines.

---

### W6 — Release readiness

1. `docs/README` / `.env.example`: one list of *required* env vars
   (`DATABASE_URL`, `CONNECTION_ENCRYPTION_KEY`, `SESSION_SIGNING_SECRET`,
   `CLERK_*`, `SMTP_*`, `APP_URL`) — Shopify vars become optional.
2. Boot check: fail fast with a readable message if a required var is missing;
   warn-and-continue if Shopify vars are absent (that's now the normal case).
3. Embed snippet: a real, documented `<iframe>` / script tag for
   `/book/:slug`, since "put it on your own website" replaces the Shopify
   theme block as the default distribution path.
4. Smoke test (Playwright, extends `cloud/tests/a11y`): sign up → onboard →
   book from the public page → see it in the dashboard → cancel. Plus a
   billing pass, run twice (once per provider): trial → upgrade in sandbox →
   webhook lands → entitlement changes → cancel → drops to Free. These are the
   release gate.
5. Billing env vars (added by W7): `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`,
   `PAYPAL_WEBHOOK_ID`, `PAYPAL_ENV`, `PAYPAL_PLAN_{STARTER,GROWTH,BUSINESS}_{MONTHLY,YEARLY}`;
   `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`,
   `RAZORPAY_PLAN_*` (same six); plus `BILLING_DEFAULT_PROVIDER`,
   `BILLING_REQUIRE_CARD`, `PLATFORM_ADMIN_EMAILS`. Twelve plan/price ids in
   total — keep them in one `plans.ts` map, not scattered through the code.
6. Run `npm run typecheck -w getbooqin-cloud`, `-w shopify-getbooqin`, and the
   core vitest suite after every workstream.

---

### W7 — Billing: Free, trial, and paid plans at $5 / $10 / $15

**What the user sees**

1. **Signup** — no card. The account starts on a **30-day trial of Growth**
   (the $10 middle tier), with the trial end date shown in the sidebar from day
   one. Trialling the middle tier, not the cheapest, is deliberate: people
   downgrade to what they actually need, they rarely upgrade into something
   they've never used.
2. **Onboarding step 3** ("You're live") — alongside the booking link, a
   compact plan strip: *"You're on Growth free until 12 Oct. Stay free, or pick
   a plan from $5/mo."* The button opens PayPal's approval flow or Razorpay
   Checkout depending on the account's country; skipping it is the default and
   costs nothing.
3. **Settings → Billing** — current plan, usage against limits, upgrade,
   downgrade, cancel, and payment history. ⚠️ **We build all of this
   ourselves.** Neither PayPal nor Razorpay offers a hosted customer portal
   equivalent to Stripe's, so this is a real screen with real actions, not a
   link out — see §"What choosing PayPal + Razorpay costs" below.
4. **At trial end** — the account drops to Free automatically. Nothing is
   deleted; it goes **read-only above the Free limits** (see enforcement
   below). An upgrade restores everything instantly.

#### Recommended plan ladder

Four rows, three of them paid. The ladder climbs on **team and capacity** —
that's how a booking business actually grows, and it's the only axis a customer
can self-assess against without reading a feature matrix.

| | **Free** $0 | **Starter** $5/mo | **Growth** $10/mo | **Business** $15/mo |
|---|---|---|---|---|
| Annual (2 months free) | — | $50/yr | $100/yr | $150/yr |
| Resources (staff/rooms) | 1 | 3 | 10 | Unlimited |
| Team members | 1 (owner) | 2 | 6 | Unlimited |
| Services | 3 | Unlimited | Unlimited | Unlimited |
| Bookings / month | 50 | Unlimited | Unlimited | Unlimited |
| Businesses / locations | 1 | 1 | 1 | 5 |
| Public booking page | ✅ | ✅ | ✅ | ✅ |
| Custom vocabulary | ✅ | ✅ | ✅ | ✅ |
| Email confirmations + reminders | ✅ | ✅ | ✅ | ✅ |
| Calendar + customer records | ✅ | ✅ | ✅ | ✅ |
| "Powered by GetBooqin" badge | shown | **removed** | removed | removed |
| Embed on your own website | — | ✅ | ✅ | ✅ |
| Waitlist | — | ✅ | ✅ | ✅ |
| Team roles (admin / write / read) | — | — | ✅ | ✅ |
| Editable email templates | — | — | ✅ | ✅ |
| Shopify connection | — | — | ✅ | ✅ |
| CSV export | — | — | ✅ | ✅ |
| Priority support | — | — | — | ✅ |
| Early access to new features | — | — | — | ✅ |

Each step buys something a customer can name in one breath: **$5 takes the
badge off and lets you embed it** · **$10 gives you a team with roles and your
own email wording** · **$15 is unlimited, plus multiple locations.**

**Gate on limits, not on core features.** A free tier where the booking page,
reminders, calendar and vocabulary all work — just capped at one staff member
and 50 bookings — feels like a real product and converts when the business
grows. A free tier where reminders are switched off feels broken, gets bad
reviews, and teaches users the product doesn't work. The only *feature* gates
above are things a one-person operation genuinely doesn't need and a real team
immediately does.

#### Launch with three rows visible, not four

`plans.ts` is a plain data table, so defining all four costs nothing. But
**showing** four costs conversion: at $5/$10/$15 the gaps are small enough that
a visitor spends more time comparing than deciding, and every extra column is
another chance to bounce.

Recommendation: **ship Free / Starter $5 / Growth $10 on the pricing page, and
keep Business $15 defined but hidden** until someone asks for unlimited or
multi-location — at which point you enable it from the admin console (§W8) and
add the column. You'll also learn what "Business" should actually contain from
the person asking for it, rather than guessing now.

#### Processors: PayPal + Razorpay, no Stripe

Two providers, split by where the customer is:

| | **Razorpay Subscriptions** | **PayPal Subscriptions** |
|---|---|---|
| Serves | India (INR) | Everywhere else (USD/EUR) |
| Mandate rail | **UPI AutoPay**, card e-mandate, NACH | PayPal balance / card, via PayPal account |
| Fee on a $5 charge | ~2% domestic (~₹8 on ₹400) | ~3.49% + $0.49 ≈ **$0.66 (13%)** |
| Fee on $15 | ~2% | ~5.8% |
| Trial support | `start_at` defers first charge | trial billing cycle at price 0 |
| Discounts | `offer_id` (native coupons) | no native coupon — handle as a plan swap |
| Hosted billing portal | ❌ none | ❌ none (PayPal's own "automatic payments" page only) |
| Tax / VAT handling | ❌ merchant's responsibility | ❌ merchant's responsibility |
| Webhook auth | HMAC-SHA256 with webhook secret | signature verification API call |
| Requires | **Indian registered entity + KYC** | PayPal Business account |

**Routing rule:** the account's country decides. India → Razorpay. Everything
else → PayPal. Store the choice on `Subscription.billingProvider` at first
upgrade, and never change it for an existing subscription — migrating a live
mandate between providers means cancel-and-re-authorise, which loses people.

#### What choosing PayPal + Razorpay costs — three things to plan for

This is a defensible choice, especially if India is your primary market. But it
is not a like-for-like swap, and three items move from "free" to "you build it":

1. **You build the billing portal yourself (~1 week).** Stripe's hosted portal
   would have given you plan changes, cancellation, card updates, invoices and
   receipts for one link. Neither PayPal nor Razorpay has an equivalent. So
   Settings → Billing becomes a real screen: current plan and renewal date,
   upgrade/downgrade, cancel with confirmation, and a payment-history table you
   render from your own `BillingEvent` rows. **This is added to Phase 2's
   estimate**, it isn't absorbed.
2. **PayPal's fees are punishing at $5.** ~3.49% + $0.49 is **13% of a $5
   charge** versus ~9% for Stripe and ~2% for Razorpay/UPI. The fixed $0.49 is
   what does the damage. Three consequences: push the **annual plan** far
   harder than you otherwise would (one $0.49 instead of twelve), treat $5 as
   genuinely the floor, and expect non-India revenue to net roughly 87%.
3. **No Stripe Tax equivalent.** EU VAT on a digital subscription — charging
   the customer's local rate and being able to prove it — is now entirely on
   you. Options, in order of how much I'd recommend them for an MVP:
   - **Sell B2B-only outside India** and collect VAT numbers, applying reverse
     charge. Every customer here is a business, so this is honest and by far
     the cheapest path. Requires VAT-number capture + validation at checkout.
   - **A merchant-of-record** (Paddle, Lemon Squeezy) — they become the seller,
     handle all VAT globally, *and* give you the hosted portal and dunning you
     just lost. Costs ~5% + 50¢, which at $5 is worse than PayPal, but it
     deletes items 1 and 3 entirely. Worth a serious look if EU consumer sales
     matter.
   - **Register and remit yourself** (EU OSS). Correct, and the most work.

⚠️ **Blocking question before Phase 2: do you have an Indian registered
entity?** Razorpay requires one — Indian company/LLP/proprietorship with KYC
and a domestic bank account. It is not available to an EU-only merchant. Given
this repo is hosted in `ams` and the docs folder suggests a Netherlands base,
this genuinely might not be available to you. If it isn't, you're on PayPal
alone, and the fee and portal costs above apply to 100% of revenue rather than
a slice. **Answer this before any billing code is written** — it changes the
plan.

#### What $5–$15 means for the economics

- **Volume required.** At this ladder, a realistic paying mix averages ~$8/mo
  gross — call it **~$7 net after PayPal**. **$1,000 MRR needs ~140 paying
  accounts**; at typical free-to-paid conversion (3–5%), that's roughly 3,500
  signups. That's a marketing plan, not a pricing plan — worth knowing before
  it's a surprise. The upside is real: $5 makes the decision small enough to be
  impulsive, and cheap tiers reach markets $29 simply doesn't.
- **Annual is not a nice-to-have here.** With a fixed $0.49 per PayPal charge,
  annual billing is the difference between 13% and 1.1% in fees. Make it the
  default-selected option at checkout, not a toggle people have to find.
- **Where the money actually is:** the ladder's job isn't the $5 — it's moving
  people to $10 and $15. Team-member and resource caps do that automatically as
  a business grows, with no sales conversation. That's why the limits, not the
  features, carry the pricing.
- **Currency.** The codebase already carries ₹ pricing and a Razorpay gateway,
  which suggests an India-heavy market — where this ladder makes far more sense
  than $29 would, and where **UPI AutoPay at ~2% is the best unit economics
  available anywhere in this plan**. If India really is primary, Razorpay-first
  is the right call and PayPal is the secondary rail, not the other way round.

#### The one concept that makes this tractable: entitlements

Everything — plan limits, trial state, admin grants, discounts — resolves
through a **single function**:

```ts
// core/src/billing/entitlements.ts
entitlementsFor(connectionId) => {
  plan: "free" | "starter" | "growth" | "business",
  status: "trialing" | "active" | "past_due" | "free",
  trialEndsAt: Date | null,
  limits: { resources: 10, services: Infinity, teamMembers: 6, bookingsPerMonth: Infinity, businesses: 1 },
  features: Set<"no_badge" | "embed" | "waitlist" | "team_roles" | "email_templates" | "shopify" | "export" | "priority_support" | "early_access">,
}

// resolved as:  plan defaults  ∪  admin grants  −  admin revokes
can(connectionId, "waitlist")          // feature check
withinLimit(connectionId, "resources") // limit check, returns { allowed, used, cap }
```

**This replaces `core/src/booking/featureFlags.ts`.** W4 deletes those five
env-var booleans; this is what takes their place, and it is strictly better —
per-account instead of per-deploy, changeable from the admin console without a
redeploy, and it's the same mechanism that backs early access in §W8. The W4
risk about "re-adding a feature means a rebuild, not an env var" is resolved by
this section.

#### Schema

```prisma
model Subscription {
  id                   String    @id @default(cuid())
  connectionId         String    @unique
  plan                 String    @default("free")      // free|starter|growth|business
  status               String    @default("trialing")  // trialing|active|past_due|canceled|free
  trialEndsAt          DateTime?
  billingProvider      String    @default("manual")    // paypal|razorpay|manual
  providerCustomerId   String?
  providerSubscriptionId String?  @unique
  currentPeriodEnd     DateTime?
  cancelAtPeriodEnd    Boolean   @default(false)
  createdAt            DateTime  @default(now())
  updatedAt            DateTime  @updatedAt
  connection           Connection @relation(fields: [connectionId], references: [id], onDelete: Cascade)
}

// Admin overrides — the early-access / comp / beta mechanism (§W8).
model Entitlement {
  id              String    @id @default(cuid())
  connectionId    String
  key             String    // a feature key ("waitlist") or a limit key ("limit.resources")
  value           String    // "on" | "off" | a numeric cap
  grantedByUserId String
  reason          String                              // required — shows in the admin UI and the audit log
  expiresAt       DateTime?                           // null = permanent
  createdAt       DateTime  @default(now())
  connection      Connection @relation(fields: [connectionId], references: [id], onDelete: Cascade)
  @@unique([connectionId, key])
  @@index([connectionId])
}
```

Plus `BillingEvent` (raw provider webhook payloads, for replay and for
debugging "they say they paid"), and `Subscription` is written by **exactly
one** code path — the webhook handler. Checkout success pages never write
subscription state; they redirect and let the webhook be the truth. This is the
single most common way billing integrations go wrong.

#### Enforcement — where the limits actually bite

Server-side, in core, never in the UI:

| Limit | Enforced in |
|---|---|
| `resources` | `Data.createResource()` |
| `services` | `Data.createService()` |
| `teamMembers` | `Team.inviteMember()` |
| `bookingsPerMonth` | `Bookings.create()` — counts the calling month, and **only counts customer-made bookings**, never staff-entered ones |
| `businesses` | `createManualConnection()` / Shopify connect |
| `waitlist`, `embed`, `shopify`, `export`, `team_roles`, `email_templates` | Route loaders — the nav item renders locked, the route 402s |

**Downgrade is never destructive.** A Growth account with 6 resources that
drops to Starter (cap 3) keeps all 6 — they stay visible and their existing bookings keep
working; what's blocked is *creating the 7th*. Deleting a user's data because
their card expired is how you earn a chargeback and a public complaint. Show a
persistent "You're over your plan limit" banner with an upgrade link instead.

#### Files

- `core/src/billing/{plans,entitlements,subscriptions}.ts` — plan table,
  resolution, lifecycle. `plans.ts` is a plain data table so changing a limit
  is a one-line edit.
- `core/src/billing/providers/{paypal,razorpay}.ts` behind one
  `BillingProvider` interface: `createSubscription()`, `changePlan()`,
  `cancel()`, `verifyWebhook()`, `parseEvent()`. Two implementations of the
  same five methods; `providerFor(country)` picks between them. Note there is
  no `createPortalSession()` any more — that capability doesn't exist at either
  vendor, which is why the Billing screen is real UI.
- `cloud/app/routes/dashboard.$connectionId.settings.tsx` — a `billing` page.
- `cloud/app/routes/billing.checkout.tsx`, `billing.return.tsx`,
  `webhooks.paypal.tsx`, `webhooks.razorpay.tsx`.
- `cloud/app/components/upgrade.tsx` — the `<UpgradePrompt feature="waitlist">`
  used at every gate, so locked states look the same everywhere.

⚠️ **The landing page contradicts this pricing today.**
[cloud/app/routes/_index.tsx:27-43](cloud/app/routes/_index.tsx#L27-L43) sells
Starter $0 / Growth $29 / Scale $79 — roughly 3–6× this ladder — and lists
"Deposits & payments" and "WhatsApp reminders (soon)" as Growth features, both
of which W4 removes. The `PlanCard` component itself is fine and gets reused;
it's the `PLANS` array and the feature bullets that must be rewritten, in the
same PR as billing, or a visitor sees $29 on the pricing section and $5 at
checkout.

#### Should the card be required at onboarding?

You asked for payment at onboarding, and step 3 above puts a real Checkout
button there. I'd argue against making it **mandatory**, and the plan
implements optional-by-default:

- It directly contradicts this plan's own goal — "easy for a user to
  immediately start using it." A card wall in step 3 is the single biggest
  drop-off point a self-serve funnel can have.
- At $5, a card-required signup typically converts 5–10× worse than
  trial-first. You'd need the conversion rate on the *paid* funnel to be
  extraordinary to beat trial-first on absolute revenue.
- You cannot show value before the ask. The user hasn't seen a booking come in
  yet — there's nothing to be convinced by.

It's implemented as one config value (`BILLING_REQUIRE_CARD`, default off), so
if you want to test card-required you flip it and measure, rather than
rebuilding the flow. Your call — I've built the superset either way.

---

### W8 — Platform admin console

A separate, internal-only surface at `/admin`. Not a role inside a business —
this is *us*, above all accounts.

#### Screens

1. **Accounts** — searchable table: business name, owner email, plan, status,
   trial ends, bookings this month, created. Filters for trialing / past-due /
   over-limit. This is also the closest thing to an analytics dashboard the MVP
   will have, so it earns its keep on day one.
2. **Account detail** — the one screen that does the work:
   - **Change plan** — set free/starter/growth/business directly, no card.
     This is how you comp someone, and how you enable the hidden $15 tier for
     the first customer who asks for it.
   - **Extend trial** — a date picker. The single most-used support action in
     any early-stage SaaS.
   - **Feature grants** — toggle any entitlement key on or off for this account,
     with a **required reason** and an optional expiry. *This is early access:*
     ship a feature dark, grant it to five accounts, watch, then move it into a
     plan. Same mechanism, no deploys.
   - **Discounts** — two distinct mechanisms, and the difference matters:
     - *Plan override* — "Growth, free, until 31 Dec." Never touches the
       payment provider at all. Use this for beta users, friends and design
       partners. Zero payment risk, works identically on both rails, and it is
       the mechanism you'll reach for 95% of the time.
     - *Provider discount* — a real discount on a real subscription. Razorpay
       has native `offers`; **PayPal has no coupon concept**, so a PayPal
       discount has to be implemented as a swap onto a discounted plan id
       (i.e. pre-create "Growth 50% off" as its own PayPal plan). Given that
       asymmetry, prefer plan overrides and keep provider discounts for the
       rare case where the money genuinely has to move.
   - **Danger zone** — suspend account, force-cancel subscription. Both
     confirm-by-typing-the-business-name.
3. **Feature catalogue** — every entitlement key, what it does, which plan
   grants it, how many accounts have an override. Prevents the admin UI from
   becoming a pile of magic strings nobody remembers the meaning of.
4. **Audit log** — every admin action, filterable by actor and by account.

#### Non-negotiables

- **Audit everything.** `AdminAuditLog { actorUserId, action, targetType,
  targetId, before, after, reason, ip, createdAt }`, written in the same
  transaction as the change. Handing out discounts and free plans without an
  immutable record of who did what is how a small team ends up unable to answer
  "why is this account free?" six months later.
- **`reason` is required** on every grant, plan override and discount. One
  free-text field, enforced at the schema level. It costs five seconds and
  saves the entire audit trail's usefulness.
- **Auth is layered, not clever.** `User.isPlatformAdmin` (a boolean column) is
  the authority, **and** the email must appear in a `PLATFORM_ADMIN_EMAILS`
  env allowlist. Both required. A leaked session or a bad write to one column
  is then not enough on its own, and the env var is what bootstraps the very
  first admin.
- **Never renders tenant booking data.** The admin console shows accounts,
  plans, counts and entitlements — not customer names, not booking details, not
  a clinic's patient list. If support genuinely needs to see a merchant's
  screen, that's a separate, explicitly-consented, separately-audited
  impersonation feature, and it is **out of scope for MVP**. Building it
  casually into an admin panel is a privacy incident waiting to happen,
  especially with clinic data in these tables.
- `/admin` is excluded from the tenant middleware entirely — its own layout,
  its own `requirePlatformAdmin()`, its own 404 for everyone else (a 404, not a
  403: don't confirm the route exists).

#### Files

- `core/src/admin/{accounts,actions,audit}.ts`
- `cloud/app/routes/admin.tsx` (layout + guard), `admin._index.tsx`,
  `admin.accounts.$id.tsx`, `admin.features.tsx`, `admin.audit.tsx`
- `server/combined.js` — add `/admin` to `CLOUD_PREFIXES`
- Migration adding `User.isPlatformAdmin`, `AdminAuditLog`

---

## 4. What's missing — gaps that block paying users

The trim plan and the billing plan both assume the product underneath works.
Auditing that assumption turned up five things that are broken or absent today
and would each, on their own, lose a paying customer. **These outrank every
feature idea below.**

### 4.1 Blockers — fix before charging anyone

| # | Gap | Why it's fatal |
|---|---|---|
| **B1** | **Nothing schedules the reminder cron.** [cron.reminders.tsx](shopify-openslot/app/routes/cron.reminders.tsx) expects an external scheduler hitting it hourly with a bearer token. `fly.toml` has no schedule, `.github/workflows/ci.yml` is test-only, and there is no cron-job.org config in the repo. **Reminders do not fire in production today.** | "Email reminders" is a feature on *every* tier of the pricing table, free included. Selling a reminder that never sends is the fastest possible route to a refund request and a bad review. |
| **B2** | **Double-booking race.** `Bookings.create()` checks availability, then calls `prisma.booking.create()` as a separate unguarded statement — no transaction, no row lock, and no DB-level exclusion constraint on `(resourceId, time range)`. Two customers clicking the last 10:00 slot at the same moment both pass the check and both get booked. | For a booking product this is *the* unforgivable bug. It surfaces as a furious merchant with two people in the waiting room. Low traffic hides it; the day it doesn't, you lose the customer and the review. |
| **B3** | **Email deliverability.** [mailer.ts:229](core/src/booking/mailer.ts#L229) sends as `"Business Name" <business_email>` — the merchant's *own* address — over your SMTP. Without SPF/DKIM alignment for a domain you don't control, that's a textbook spoof signal: Gmail and Outlook spam-folder it or reject outright. There's also no `Reply-To`. | Every customer-facing email the product sends — confirmations, reminders, cancellations — is the product. If they land in spam, nothing else matters. |
| **B4** | **No error monitoring and no product analytics.** No Sentry, no PostHog, nothing. | You will not know a booking flow broke until someone emails you. And with a funnel you're about to charge for, you can't see where people drop out of onboarding. |
| **B5** | **No billing terms, no refund policy, no account deletion.** [terms.tsx](cloud/app/routes/terms.tsx) has one sentence about pricing changes and nothing on subscriptions, renewals or refunds. Nothing anywhere deletes an account. | You cannot legally take recurring payments without stating renewal and cancellation terms. Hosting in `ams` with EU customers, right-to-erasure isn't optional either. |

**Fixes, concretely:**

- **B1** — a Fly Machines schedule (or a GitHub Actions `schedule:` workflow,
  which the existing CI file makes trivial) hitting `/cron/reminders` hourly
  with `CRON_SECRET`. Add a "last run" timestamp surfaced in the admin console
  (§W8) so silent failure is visible. `sendReminders()` itself is already
  platform-agnostic, so it covers manual (non-Shopify) accounts correctly.
- **B2** — a Postgres exclusion constraint on overlapping ranges per resource
  (`btree_gist` + `EXCLUDE USING gist`) for `capacity = 1` services, wrap
  check-and-insert in a transaction, and translate the constraint violation
  into the `getbooqin_slot_taken` 409 the code *already* has a message for.
  Capacity > 1 services need a counted check inside the same transaction.
- **B3** — send from one domain you control with SPF/DKIM/DMARC set up:
  `From: "Business Name via GetBooqin" <notify@getbooqin.com>`,
  `Reply-To: <merchant's address>`. Use a transactional provider (Postmark,
  Resend, SES) rather than raw SMTP — the nodemailer transport stays, only the
  credentials and the `from` line change. Budget a day for DNS and a warm-up.
- **B4** — Sentry in both apps, one uptime check on `/` and on `/cron/reminders`.
- **B5** — subscription + refund terms in `terms.tsx`, a Delete Account flow,
  and the VAT decision (see §4.3).

### 4.2 Cheap additions with real conversion impact

Ranked by value per day of work. These are the ones I'd actually add to MVP.

1. **`.ics` calendar attachment on every confirmation email** — half a day.
   The single highest value-per-hour item on this list. It puts the booking in
   the customer's own calendar, which measurably cuts no-shows, and it costs
   one small function. No dependency on any integration.
2. **Lifecycle emails** — ~1 day. Welcome, "your first booking came in" (a
   genuine delight moment), "trial ends in 3 days", "trial ended", "payment
   failed". Without the trial emails your trial→paid conversion falls off a
   cliff, because most people simply forget. This is billing infrastructure,
   not marketing.
3. **"Add to calendar" + share buttons on the booking-confirmed page** — half a
   day, same generator as #1.
4. **Booking page polish: logo upload + accent colour** — ~1 day. Merchants
   judge the product by whether the page they send customers looks like
   *theirs*. It also makes the $5 "remove the badge" tier feel like a real
   purchase rather than a tax.
5. **A real embed snippet with a copy button** — already in W6, but promote it:
   for a non-Shopify merchant this *is* the distribution channel.
6. **Onboarding "send yourself a test booking"** — half a day. Lets a merchant
   see the whole loop (form → email → dashboard) in 30 seconds, which is the
   moment someone decides the product works.

### 4.3 Needed specifically because you're taking money

- **VAT handling** — no Stripe Tax to lean on. Pick one of the three options
  in §W7's processor section *before* Phase 2. My recommendation for an MVP:
  **B2B-only outside India with VAT-number capture and reverse charge** —
  every customer is a business, so it's honest, and it's the cheapest correct
  answer.
- **Invoices and receipts — you build them.** No hosted portal at either
  vendor. Render a payment-history table from your own `BillingEvent` rows and
  generate a simple PDF/HTML receipt. Budget it; don't discover it.
- **Dunning — you build it.** Razorpay retries and emits `subscription.pending`
  / `subscription.halted`; PayPal emits `BILLING.SUBSCRIPTION.PAYMENT.FAILED`
  and eventually suspends. Neither chases the customer for you the way Stripe
  does, so you need: an in-app "payment failed, update your payment method"
  banner, an email at failure, a second email before suspension, and a grace
  period (7 days) before entitlements drop. **This is the single most
  underestimated item in the whole billing workstream.**
- **Grandfathering decision** for accounts created before billing lands
  (already in §6 Risks).

### 4.4 Strengths you already have and aren't selling

Worth knowing before building anything: these exist, work, and are absent from
the marketing page.

- **Group / class / cohort bookings.** `ServiceConfig.capacity` is honoured by
  the slot engine ([availability.ts:640](core/src/booking/availability.ts#L640))
  — a service can seat many people per slot. That's exactly the "cohort"
  vocabulary you wanted, and it's *built*.
- **Buffers before and after** each booking, per service.
- **Rooms as a second bookable resource** — a service can require a free room
  *and* a free practitioner. Genuinely rare at this price point.
- **Waitlist with automatic offer cascade** when a slot frees up.
- **Team roles** — owner/admin/write/read with invites.
- **Time off** per resource.

None of these need building. They need a line each on the pricing page.

### 4.5 Deliberately NOT in MVP

Say no to these now so they don't creep in:

- **Google Calendar two-way sync** — the most-requested booking integration and
  the right *first* thing after launch, but OAuth + sync + conflict resolution
  is 2–3 weeks on its own. Ship without it; let demand confirm it.
- **SMS/WhatsApp reminders** — real no-show reduction, but per-message cost
  destroys $5/mo unit economics. Revisit as a paid add-on.
- **Native mobile apps** — the dashboard being responsive is enough.
- **Multi-language booking pages**, **recurring bookings**, **packages /
  memberships**, **merchant deposits** (see §W4).

---

## 5. Phases

Six phases, ~8–10 weeks. Each ends at a state you could genuinely stop at —
nothing is left half-migrated between phases, and every phase has a testable
exit criterion rather than "it's done when it feels done."

| Phase | What | Weeks | Cumulative | You can... |
|---|---|---|---|---|
| **0** | Make what exists actually work | 1 | 1 | ...trust the product you already have |
| **1** | Trim | 1 | 2 | ...rename anything; 6k fewer lines |
| **2** | Money | 3–4 | 5–6 | **...take payment** |
| **3** | Self-serve onboarding | 1–2 | 6–8 | ...let strangers sign up unattended |
| **4** | One admin | 1 | 7–9 | ...build every feature once |
| **5** | Launch readiness | 1 | 8–10 | ...launch |

### Decision gates — answer these before the phase they block

| Gate | Question | Blocks | Why it can't wait |
|---|---|---|---|
| **G1** | **Do you have an Indian registered entity?** | Phase 2 | Razorpay requires one. Without it you're PayPal-only at ~13% fees on $5, which changes the pricing conversation. Decides which provider gets built first. |
| **G2** | **How do you handle EU VAT?** B2B-only + reverse charge / merchant-of-record / OSS registration | Phase 2 | Changes checkout (VAT-number capture), changes who the seller of record is, and an MoR would replace the portal work entirely. |
| **G3** | **Is a Shopify App Store listing in scope?** | Phase 4 | If yes, the thin embedded app needs a review pass. If no, Phase 4 can cut deeper. |
| **G4** | Show 3 tiers or 4 at launch? | Phase 2 (pricing page) | Minor, but the recommendation is 3 — see §W7. |

---

### Phase 0 — Make what exists actually work *(~1 week)*

**Goal:** stop selling things that don't happen. This is the only phase that is
fixing rather than building, and all three user-visible defects live here.

1. **Reminder scheduler (B1)** — Fly Machines schedule or a GitHub Actions
   `schedule:` workflow hitting `/cron/reminders` hourly with `CRON_SECRET`.
   Record a `last_run_at` so silent failure becomes visible (surfaced in the
   admin console in Phase 2).
2. **Double-booking constraint (B2)** — migration enabling `btree_gist`; an
   `EXCLUDE USING gist` constraint on overlapping `(resourceId, tsrange)` for
   `capacity = 1`; wrap the availability check and the insert in one
   `prisma.$transaction`; translate the constraint violation into the existing
   `getbooqin_slot_taken` 409. Add a concurrent-insert test.
3. **Email deliverability (B3)** — transactional provider (Postmark / Resend /
   SES) on a domain you control, SPF + DKIM + DMARC, change
   [mailer.ts:229](core/src/booking/mailer.ts#L229) to
   `From: "Business Name via GetBooqin" <notify@getbooqin.com>` and add
   `Reply-To: <merchant>`. Allow a day for DNS propagation and warm-up.
4. **Monitoring (B4)** — Sentry in both apps; uptime checks on `/` and
   `/cron/reminders`.
5. **Backups** — confirm Fly Postgres snapshots are on, and actually restore
   one to a scratch database. An untested backup is not a backup.

**Exit:** a booking made on the live site sends a confirmation that lands in a
real inbox; a reminder fires the next morning; two simultaneous requests for
one slot produce exactly one booking and one clean 409; an exception pages you.

*These five are independent — parallelise freely.*

---

### Phase 1 — Trim *(~1 week)*

**Goal:** a smaller codebase before you build on it, and the vocabulary promise
delivered.

**PR 1 — remove dark surfaces (−5,215):** W4a–4e, delete `featureFlags.ts`,
prune `core/src/index.ts` exports and the dead `Settings` keys, drop the
matching settings pages. Tables stay; only code goes.

**PR 2 — vocabulary replaces presets (−850):** collapse `presets.ts` to
`defaultTerms()` + `STARTER_TEMPLATES` (onboarding seed data only); delete
`applyPreset`, `PRESET_CONTROLLED_KEYS`, `customized_fields`; change
`vocabFor(presetId)` → `vocabFor(settings.terms)`; add the vocabulary card to
Settings → Business; delete the Template page; backfill `terms` where null.

**Exit:** `Settings` is ~30 keys instead of 60+; a user can rename a booking to
a Consultation or a Cohort and see it everywhere including emails; typecheck
and the core suite are green.

---

### Phase 2 — Money *(~3–4 weeks)* — the highest-risk phase

Split into three sub-phases. **Do not start 2c before G1 and G2 are answered.**

**2a — Billing foundation *(~1 week)*.** Schema: `Subscription`,
`Entitlement`, `BillingEvent`, `AdminAuditLog`, `User.isPlatformAdmin`.
`plans.ts` (all four tiers, twelve provider plan ids). `entitlements.ts` with
`entitlementsFor` / `can` / `withinLimit`. Enforcement at the six call sites
(resources, services, team members, bookings/month, businesses, feature
routes). Settings → Billing, read-only for now. Backfill every existing
account to `trialing`. Lazy trial expiry inside `entitlementsFor()` — no
scheduler to fail.

**2b — Admin console *(~0.5–1 week)*.** `/admin` with `requirePlatformAdmin()`
(column **and** env allowlist). Accounts list and detail; change plan; extend
trial; grant/revoke entitlements with a required reason and optional expiry;
audit log; a tile showing the reminder cron's `last_run_at` from Phase 0.

**2c — Payments *(~1.5–2 weeks)*.** In this order:
1. `BillingProvider` interface — `createSubscription`, `changePlan`, `cancel`,
   `verifyWebhook`, `parseEvent`.
2. **One provider end-to-end** — Razorpay if G1 is yes, PayPal if not. Ship it
   before starting the second; building both at once doubles the debugging
   surface before either works.
3. **Billing portal UI** — current plan, renewal date, upgrade/downgrade
   (effective next cycle, no proration), cancel with confirmation, payment
   history from your own `BillingEvent` rows. Neither vendor gives you this.
4. **Dunning** — failure email, pre-suspension email, 7-day grace, in-app
   banner. Neither vendor chases the customer for you.
5. **Second provider** against the now-proven interface.
6. **Legal (B5)** — subscription and refund terms in `terms.tsx`, account
   deletion flow, VAT per G2.
7. **Pricing page rewrite** — [_index.tsx:27-43](cloud/app/routes/_index.tsx#L27-L43)
   still says $0/$29/$79 with features W4 deleted. Must ship with this phase.

**Exit:** a stranger signs up, trials, pays $5, and appears in your admin
console — and you can comp them, extend their trial, or grant early access
without a deploy. Every lifecycle event has been triggered by hand in both
sandboxes, **including the failure paths**.

*2a and 2b are one person's work; the DNS, entity, VAT and provider-account
setup for 2c can proceed in parallel with them.*

---

### Phase 3 — Self-serve onboarding *(~1–2 weeks)*

**Goal:** nobody needs to talk to you to become a customer.

- **PR 6** — settings trim, 9 pages → 5 (+ the new Billing page).
- **PR 7** — 3-step onboarding, no Shopify branch, with the plan strip on
  step 3.
- **`.ics` attachment** on every confirmation, plus "Add to calendar" on the
  booking-confirmed page. Highest value-per-hour item in the plan.
- **Lifecycle emails** — welcome, first-booking-received, trial T-3, trial
  ended, payment failed. Without the trial nudges, trial→paid conversion falls
  off a cliff.
- **"Send yourself a test booking"** in onboarding — lets a merchant see
  form → email → dashboard in 30 seconds.
- **Embed snippet** with a copy button.

**Exit:** landing page → live booking link in under five minutes, unattended;
the merchant is nudged before their trial ends; their customers get calendar
invites.

---

### Phase 4 — One admin *(~1 week)*

**Requires G3 resolved first.**

**PR 8** — Shopify keeps OAuth, the storefront proxy, theme extensions,
webhooks and cron; its 15 embedded admin routes collapse to one "Manage in
GetBooqin →" screen (−4,900).

**Exit:** one dashboard. Every future feature is built once instead of twice.

---

### Phase 5 — Launch readiness *(~1 week)*

- **PR 9** — required-env list, fail-fast boot check, docs.
- **Booking-page branding** — logo upload + accent colour. Makes the $5
  "remove the badge" tier feel like a purchase.
- **Smoke tests as the release gate** — the booking loop, plus the billing loop
  run once per provider.
- **Pricing page** finally reflects §4.4's real strengths (group/cohort
  bookings, rooms, buffers, waitlist, team roles) — all of which already exist
  and none of which you currently advertise.

**Exit:** shippable.

---

### Then, driven by actual users

Google Calendar sync (the right first thing after launch) · SMS as a paid
add-on · merchant deposits · the hidden $15 tier, enabled for the first person
who asks for it.

---

**Total: roughly 8–10 weeks**, with revenue possible at **~week 6** rather than
at the end.

**Net code:** ~37,200 → ~28,400 lines — 11,965 removed across Phases 1 and 4,
~3,000 added for billing, admin and the Phase 0 fixes.

### If you need to go faster

Compress to **Phase 0 → Phase 2 → Phase 3** and defer Phases 1 and 4. You'd be
charging in roughly five weeks. The cost is carrying the dead code and the
duplicate Shopify admin while you do it — survivable short-term, but more
expensive with every feature you add on top of two UIs.

**What I would not cut:** Phase 0. It's one week, and skipping it means
launching with reminders that never send and a double-booking race — the two
failures most likely to turn your first paying customer into your first refund.

---

## 6. Deliberately not doing

- **No schema migrations that drop tables.** Dead tables cost nothing and keep
  every cut trivially reversible.
- **Not deleting the Shopify app.** It stays installable and its storefront
  widget keeps working — it just stops being a second admin.
- **Not building the WordPress plugin.** It does not exist today (only a tile
  in the integrations list and a historical note that this codebase was *ported
  from* a WordPress plugin). The Integrations page will say "coming soon"
  rather than implying otherwise.
- **Not touching the booking engine** — availability, overlap, duration,
  reschedule, waitlist, mailer and their tests are the parts that work.
- **No admin impersonation / "view as user"** in MVP — see §W8. It's a real
  support need and a real privacy risk; it deserves its own design, consent
  model and audit trail, not a button added in passing.
- **No usage-based or per-booking pricing.** Flat tiers only. Metered billing
  roughly triples the billing surface (usage records, proration, mid-cycle
  reconciliation) for a product that doesn't yet know its own price point.
- **No per-seat pricing.** Team members are a *cap per tier*, not a
  multiplier. Per-seat maths at $5 produces absurd invoices ($5 + $3/seat for a
  three-person salon) and adds proration to every invite and removal.
- **No sophisticated dunning.** One failure email, one pre-suspension email, a
  7-day grace period, an in-app banner. No retry-schedule tuning, no card-expiry
  prediction, no win-back sequences.
- **No mid-cycle proration.** Plan changes take effect at the next billing
  date. Both providers make proration awkward and it's the hardest part of
  either API; "your new plan starts on 14 Nov" is a perfectly acceptable MVP
  answer, and it removes a whole class of refund edge cases.
- **No provider migration.** A subscription stays on the rail it started on.

## 7. Risks

- **Shopify App Store review** (W3) — see the warning in that section. Resolve
  before Phase 4, not during it.
- **Existing shops on non-generic presets** — vocabulary is already stored in
  `settings.terms` for every one of them, so W1 is a no-op for what they see.
  The one thing they lose is the "Customized" badge and preset re-apply, which
  nothing depends on.
- **Merchant deposits deferred** — the one W4 deferral with a real chance of
  being needed soon; see the table under W4. Unrelated to platform billing.
- **~~Dropping `featureFlags.ts`~~** — resolved. W7's entitlements replace it
  with something better: per-account, no redeploy, admin-controllable.
- **Webhook correctness is the billing risk.** Signature verification,
  idempotency (both providers retry; a duplicate delivery must not
  double-apply), and making the webhook the sole writer of subscription state.
  **Doubled by having two providers** — PayPal verifies via an API call,
  Razorpay via HMAC-SHA256, and their event vocabularies don't map one-to-one.
  Normalise both into your own event type at the edge so the rest of the
  codebase never sees a vendor payload.
- **Grandfathering.** Anyone signed up before Phase 2 lands gets a `Subscription`
  row by backfill. Decide deliberately what they get — the honest default is
  Basic free for 12 months with a dated note, set via the admin console so the
  audit log records why.
- **🚩 Razorpay eligibility is a hard blocker, not a preference.** Razorpay
  requires an Indian registered entity with KYC and a domestic bank account.
  If you don't have one, PayPal carries 100% of revenue at ~13% fees on $5 —
  which changes the pricing conversation materially. **Answer this before
  Phase 2 starts.**
- **No hosted portal at either vendor** means ~1 extra week of billing UI and
  the whole dunning flow is yours to build. Already reflected in the Phase 2
  estimate; flagged here because it's the thing most likely to be forgotten
  when scoping.
- **PayPal subscription UX** is a redirect to PayPal and requires the customer
  to have (or create) a PayPal account — measurably worse conversion than an
  inline card field. If non-India conversion disappoints, this is the first
  thing to suspect.
- **Trial-end automation** — accounts must actually drop to Free when the trial
  expires. Either a daily cron (there's already `cron.reminders` /
  `cron.waitlist` to follow) or lazy evaluation inside `entitlementsFor()`.
  Lazy is simpler and has no scheduler to fail; recommend that, with the cron
  only for the "your trial ends in 3 days" email.
