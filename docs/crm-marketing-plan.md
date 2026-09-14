# From booking tool to WhatsApp CRM

**Turning GetBooqin into a CRM and digital-marketing tool an SME runs from
WhatsApp, with a dashboard that only pulls metrics.**

Status: plan. Nothing here is built. Continues the phase numbering of
[mvp-trim-plan.md](mvp-trim-plan.md), whose Phases 0–4 are shipped.

---

## 1. The thesis, in one paragraph

A salon owner, a dentist, a tutor, a photographer — none of them open a
dashboard. They open WhatsApp, forty times a day, and the business already
happens there: enquiries, reschedules, "are you open Sunday", payment
screenshots, the whole thing. GetBooqin today is a booking engine with an
email spine and a web dashboard. The move is not to bolt WhatsApp on as a
fifth reminder channel. It is to make **WhatsApp the primary interface on
both sides** — the customer books, pays, reschedules and hears from the
business there, and the *owner* runs the business there too — and to demote
the dashboard to what it is actually good for: configuration you do once, and
numbers you look at on Sunday night.

That is a different product from "booking software with WhatsApp reminders",
and it is worth roughly five times the money, because it replaces a CRM
subscription, a broadcast tool and a reminder tool rather than competing with
Calendly.

---

## 2. What already exists (verified, not assumed)

Worth stating precisely, because most of the CRM work is smaller than it
looks — the hard parts (multi-tenancy, billing, entitlements, an event bus,
templated notifications) are done.

| Asset | Where | Why it matters here |
|---|---|---|
| Tenant model — `Connection` = a business, with members/roles/invites | [schema.prisma:82](../core/prisma/schema.prisma#L82), [team.ts](../core/src/team.ts) | A CRM workspace already exists. Nothing new to invent. |
| `Customer` with name/email/phone/timezone/notes/DOB | [schema.prisma:419](../core/prisma/schema.prisma#L419) | The contact record exists but is thin — see §4.1. |
| `Booking` with status, price, `amountDue`, `paymentStatus`, `source` | [schema.prisma:446](../core/prisma/schema.prisma#L446) | Every CRM metric worth having derives from this table. `source` is already `form\|chat\|waitlist` — one enum widening from being an attribution column. |
| Typed in-process event bus | [events.ts](../core/src/booking/events.ts) | `booking_created`, `booking_status_changed`, `booking_cancelled`, `booking_rescheduled`, `booking_slot_freed`, `waitlist_*`. This is the trigger surface a journey engine needs, already emitted from the right places. |
| Templated notifications with a token system | [mailer.ts:38](../core/src/booking/mailer.ts#L38), [notificationTokens.ts](../core/src/booking/notificationTokens.ts) | `TEMPLATE_DEFS` + `{{tokens}}` + per-key enable flags. A WhatsApp template registry is the same shape with an approval status bolted on. |
| Job bookkeeping with an atomic claim-and-lease | [jobs.ts](../core/src/jobs.ts), `JobRun` | The outbox worker and every scheduled journey step reuse `record()` verbatim. Do not build a second scheduler. |
| Entitlements — per-account feature grants, no deploy | [plans.ts](../core/src/billing/plans.ts), [entitlements.ts](../core/src/billing/entitlements.ts) | Every phase below ships dark and is granted from `/admin` to one design partner first. This is the single most valuable thing already in the codebase for a build this speculative. |
| Payment links — UPI deep links, paypal.me, QR, `Payment` rows | [paymentLinks.ts](../core/src/booking/paymentLinks.ts), [payments.ts](../core/src/booking/payments.ts) | "Collect ₹500 from Ravi" is already one function call away from being a WhatsApp command. |
| Billing, invoices, dunning, tax, admin console, audit log | `core/src/billing/`, `core/src/admin/` | We can charge for this the day it works. |

And two things that exist but are **dead**:

- `ChatConversation` / `ChatMessage` ([schema.prisma:712](../core/prisma/schema.prisma#L712)) — nothing in `core/src` or `cloud/app` references either table any more; they survived Phase 1's removal of the chat widget. They are the wrong shape for WhatsApp (no channel, no direction, no provider message id, no delivery state) — **drop them in Phase 5** rather than growing into them.
- The WhatsApp stubs Phase 1 left behind: `WhatsAppTestCard` in [settings.tsx:1057](../cloud/app/routes/dashboard.$connectionId.settings.tsx#L1057) and the `whatsapp` "Coming soon" tile in [presets.ts:162](../cloud/app/lib/presets.ts#L162). Both are UI with no server behind them. Delete or implement; do not leave a third state.

---

## 3. The economic decision that unblocks all of this

[mvp-trim-plan.md §4.5](mvp-trim-plan.md) says no to WhatsApp for one reason:
*"per-message cost destroys $5/mo unit economics."* That reasoning is correct
**and only applies if GetBooqin buys the messages.**

**Decision: bring-your-own WABA.** The merchant connects *their own* WhatsApp
Business Account through Meta's Embedded Signup, with their own payment
method attached. Meta bills them directly for template messages. GetBooqin is
the software on top, not the reseller of the messages.

What that buys:

- **Unit economics stop mattering.** A merchant sending 4,000 utility
  messages a month pays Meta for 4,000 messages; our margin on a ₹399 plan is
  untouched. The pricing ladder in `plans.ts` ("climbs on team and capacity,
  not on features") survives intact.
- **The merchant's own number and verified business name** on every message —
  which is the thing they actually want, and which a shared GetBooqin number
  could never give them.
- **Their quality rating is their problem.** One merchant blasting an
  unconsented list cannot get *every* tenant's throughput throttled, which is
  exactly what happens on a pooled number.
- **No credit risk, no float, no messaging-cost support tickets.**

What it costs:

- **Onboarding friction is real**: Meta Business verification, a phone number
  not already on WhatsApp, a display-name review. That is a 20-minute wizard
  and, for some merchants, a two-day wait. Budget for a proper guided flow and
  for the product to be fully useful on email alone until the number is live.
- GetBooqin must register as a **Meta Tech Provider** and get the app
  reviewed (`whatsapp_business_messaging`, `whatsapp_business_management`).
  Weeks, not days. **Start this before Phase 6 is written** — see gate G5.

Reselling messages at a markup is a real business, and it is where the BSPs
make their money — but it is a credit-and-support business, not a software
one. Revisit after 100 paying tenants, never before.

---

## 4. The four gaps

### 4.1 `Customer` is a booking party, not a contact

The gap that makes "is this a CRM?" answerable as *no* today.

- **Identity is keyed on email** — `@@unique([platform, shop, email])`. For a
  WhatsApp-first product, phone is the identity. Today
  [`findOrCreateCustomer`](../core/src/booking/data.ts#L883) works around a
  missing email by synthesising `phone-<digits>@getbooqin.invalid`, which is a
  good hack and also a **latent identity split**: the same person who books
  once by phone and once with an email becomes two contacts, with two
  histories, and will receive the same broadcast twice.
- **No consent state.** Not a nice-to-have — WhatsApp Business Policy requires
  demonstrable opt-in before a marketing template, and India's DPDP Act and
  GDPR both require a record of it. Without a consent ledger the marketing
  half of this plan is not shippable at all.
- **No tags, no source, no owner, no lifecycle stage, no custom fields.**
- **No activity timeline.** There is no table anywhere that answers "what has
  happened with this person" — the single most CRM-defining artifact there is.
- **No merge.** Duplicates are inevitable (phone typo, married name, second
  number); there is no way to fix one.

### 4.2 There is exactly one channel, and it sends inline

[mailer.ts](../core/src/booking/mailer.ts) sends nodemailer mail synchronously
inside an event listener. That is fine for email. It is not fine for a
metered, rate-limited, per-tenant-throttled API with delivery receipts,
24-hour session windows and templates that need pre-approval. WhatsApp needs a
**durable outbox** with idempotency, retry, per-tenant rate limiting and a
dead-letter state, and it needs delivery/read/failure state flowing back in.

### 4.3 Nothing markets

No segments, no broadcasts, no campaigns, no link tracking, no attribution, no
journeys, no review requests, no win-back. The event bus is the right trigger
surface and nothing consumes it except mail and waitlist.

### 4.4 The dashboard shows two numbers

[metrics.ts](../core/src/booking/metrics.ts) has `bookingsOverTime` and
`topServices`. Its header comment says the revenue aggregates were removed
because "nothing in the product can settle a payment any more" — **that
comment is now stale**: booking payments and invoices landed in `9ef00eb` /
`a14d179`. Restoring revenue metrics is a one-day job that should happen
immediately, independent of everything else here.

---

## 5. Architecture decisions

Six decisions that determine whether this stays one coherent product or
becomes two half-products sharing a database.

**D1 — Contact identity moves to a normalised phone, with a merge path.**
Add `phoneE164` to `Customer`, normalised on write (libphonenumber, defaulting
to `settings.default_country_code`, which already exists). Add a partial
unique index on `(platform, shop, phoneE164) WHERE phoneE164 IS NOT NULL`.
Resolution order in `findOrCreateCustomer` becomes **phone → email →
create**. Keep the email unique index; keep the `.invalid` placeholder
synthesis (it is what stops `mailer.ts` mailing a fake address). Ship a
backfill that normalises existing phones and a `mergeContacts()` that
re-points bookings, messages and activities and tombstones the loser. *Do not*
introduce a separate `Contact` table — a second identity model alongside
`Customer` is how products end up with two customer lists that disagree.

**D2 — One `Channel` interface, email included.** `send()` moves behind
`core/src/messaging/channels/provider.ts` with `email.ts` and `whatsapp.ts`
implementations, exactly the way [`BillingProvider`](../core/src/billing/providers/provider.ts)
already has Razorpay and PayPal behind one interface. Notification routing
becomes a per-key, per-tenant preference (WhatsApp first, email fallback, both
for invoices). The alternative — a `whatsapp.ts` that parallels `mailer.ts` —
means every new notification gets written twice and drifts, which is precisely
the bug Phase 1 was cleaning up.

**D3 — The outbox is a table, not a promise.** `MessageOutbox` rows with an
idempotency key, attempt count, next-attempt time and terminal state, drained
by a worker built on `Jobs.record()`'s existing claim-and-lease. This is what
makes "we sent 900 reminders and Meta rate-limited us at 400" a recoverable
event instead of 500 silent no-shows. It also gives the conversations inbox
and the metrics screen a single source of truth for what was sent.

**D4 — Consent is a ledger, not a boolean.** `ContactConsent` rows: channel,
purpose (`transactional` / `marketing`), state, source (where the opt-in came
from — booking form checkbox, WhatsApp reply, imported with proof), timestamp,
and the exact consent text shown. Broadcast sending checks the ledger, not a
flag. `STOP` / "unsubscribe" inbound writes an opt-out row within seconds and
before anything else the message might mean. The existing
`settings.consent_text` becomes the captured string.

**D5 — The operator surface is a command router over existing modules, not a
second product.** "Show me tomorrow", "cancel 4821", "block Friday 3–5",
"collect ₹500 from Ravi" resolve to calls into `Bookings`, `Availability`,
`Data` and `Payments` — the same functions the dashboard routes call, with the
same entitlement and role checks. If a WhatsApp command can do something the
dashboard cannot, it belongs in `core/`, not in the router.

**D6 — Authorisation for operator commands is the existing membership, keyed
by verified phone.** `User.phone` and the `dashboard.profile-phone` route
already exist. A WhatsApp sender is authorised only when their `wa_id` matches
a verified `User.phone` that has a `ConnectionMember` row on that tenant, and
the role check is `Team`'s, unchanged. An unrecognised number talking to the
business number is a **customer**, and falls through to the customer flow.
This distinction is the whole security model — write it down once and test it
hard.

---

## 6. Phases

Each phase ends somewhere you could genuinely stop, and each ships behind an
entitlement key so it can go to one design partner before it goes to everyone.

| Phase | What | Est. | You can... |
|---|---|---|---|
| **5** | CRM spine — contact identity, consent, activity timeline, tags, merge | 2 wks | ...answer "who is this person and what happened" |
| **6** | WhatsApp channel, BYO-WABA, transactional only | 3–4 wks | ...send confirmations and reminders on WhatsApp |
| **7** | Inbound + conversations inbox | 2–3 wks | ...have a two-way conversation that is on the record |
| **8** | Run the business from the thread + daily digest | 2–3 wks | ...stop opening the dashboard |
| **9** | Marketing — segments, broadcasts, links, attribution | 3 wks | ...fill next Tuesday |
| **10** | Automations — journeys off the event bus | 2 wks | ...stop doing it manually |
| **11** | The metrics dashboard | 1–2 wks | ...see what any of it did |
| **12** | Reputation and referral (optional) | 1–2 wks | ...compound |

Roughly 16–20 weeks of solo work. Phases 5, 6 and 7 are the ones without
which nothing else is true; 9 and 10 are what gets it called a marketing tool;
11 is what the user asked for and should not be built before there is
something to measure.

---

### Phase 5 — The CRM spine

*No WhatsApp in this phase. Deliberately: the contact model is wrong today,
and building a messaging channel on top of a broken identity means every
broadcast double-sends to the same human.*

Schema:

```
Customer
  + phoneE164        String?   // normalised, partial-unique per tenant
  + tags             String[]  // plain array; a join table earns itself later
  + source           String    @default("")   // booking_form|whatsapp|import|manual|broadcast
  + ownerUserId      String?   // the "who looks after this account" column
  + stage            String    @default("new") // new|active|lapsed|vip — derived nightly, stored for filtering
  + customFields     Json?
  + lastSeenAt       DateTime?
  + mergedIntoId     Int?      // tombstone; never delete a contact with history

ContactConsent  (id, contactId, channel, purpose, state, source, consentText, createdAt)
  @@index([contactId, channel, purpose])

Activity  (id, shop, platform, contactId, kind, at, actorUserId?, refType?, refId?, summary, meta Json)
  @@index([platform, shop, contactId, at])
  // kind: booking_created|booking_cancelled|booking_completed|no_show|
  //       message_sent|message_received|payment_received|note_added|
  //       consent_changed|tag_added|campaign_sent|link_clicked

ContactNote  (id, contactId, authorUserId, body, createdAt)

- drop ChatConversation, ChatMessage
```

Work:

1. `core/src/crm/identity.ts` — phone normalisation, the new resolution order in `findOrCreateCustomer`, backfill script (there is already a `scripts_backfill_*` convention to follow), and `mergeContacts()`.
2. `core/src/crm/activity.ts` — one `record()` function, subscribed to every event the bus already emits. This is a ~100-line file that changes how the product feels more than anything else in the plan.
3. `core/src/crm/consent.ts` — the ledger and a `canSend(contact, channel, purpose)` predicate that *everything* outbound calls, email included.
4. Cloud: rebuild `dashboard.$connectionId.customers.$customerId` as a real contact screen — timeline, tags, notes, consent state, bookings, payments, lifetime value. Add tag/stage/owner filters to the list, and a merge action.
5. **Side quest (1 day):** restore the revenue aggregates in `metrics.ts` and fix its stale header comment. Payments are real again.

Exit: a contact screen that shows everything that ever happened with a person,
and two duplicate records can be merged into one.

---

### Phase 6 — WhatsApp, outbound and transactional

Gate G5 (Tech Provider app review) must be cleared or in flight before this
starts. Entitlement key: `whatsapp`.

Schema:

```
WhatsAppAccount  (connectionId unique, wabaId, phoneNumberId, displayPhone,
                  verifiedName, qualityRating, messagingTier, accessToken enc,
                  status, connectedAt)
  // token encrypted with the existing auth/encryption.ts, same as Connection.credentials

MessageTemplate  (id, connectionId, key, category, language, providerName,
                  status, bodyText, variableMap Json, rejectionReason?)
  // key maps 1:1 onto mailer.ts's TEMPLATE_DEFS keys

MessageOutbox  (id, connectionId, contactId, channel, templateKey?, payload Json,
                idempotencyKey unique, state, attempts, nextAttemptAt,
                providerMessageId?, error?, createdAt, sentAt?)
  @@index([state, nextAttemptAt])
```

Work:

1. `messaging/channels/provider.ts` — the `Channel` interface; `email.ts` wraps the existing mailer so nothing about email behaviour changes.
2. `messaging/channels/whatsapp.ts` — Cloud API send, Embedded Signup OAuth exchange, template CRUD and approval-status sync.
3. `messaging/outbox.ts` + a worker registered in `JOBS`, draining on the same interval as reminders, with per-tenant rate limiting derived from the account's messaging tier.
4. `messaging/router.ts` — for a notification key and a contact, pick channels by tenant preference and consent, and enqueue. Every existing `mailer.ts` send site moves behind this, unchanged in behaviour when WhatsApp is off.
5. Onboarding: a Settings → WhatsApp screen that replaces the stub card — connect, pick a number, see template approval status, send a test.
6. Ship the first six templates: confirmation, pending-confirmation, reminder, cancellation, reschedule, payment request (the payment request carries the UPI/paypal.me link `paymentLinks.ts` already builds).

Exit: a merchant connects their own number, and a customer booking on the
public page gets a WhatsApp confirmation from the business's verified name,
with the ICS and the manage link.

---

### Phase 7 — Inbound, and a conversations inbox

Schema:

```
Conversation  (id, connectionId, contactId, channel, status, assignedUserId?,
               lastInboundAt, lastOutboundAt, windowExpiresAt, unreadCount)
Message       (id, conversationId, direction, channel, providerMessageId?,
               type, body, mediaUrl?, templateKey?, state, error?, at)
```

Work:

1. One webhook endpoint for all tenants — every merchant WABA delivers to our
   app and is keyed by `phone_number_id`. Verify the signature, write the raw
   payload, ack in under a second, process asynchronously. This is the first
   genuinely hot inbound path in the product; do not do work inline.
2. Delivery/read/failed receipts flow back onto `Message` and `MessageOutbox`.
3. **The 24-hour customer-service window** — `windowExpiresAt` on the
   conversation decides whether a free-form reply is legal or a template is
   required. Get this wrong and the inbox silently fails to send; make it
   visible in the UI ("free replies for 6h 12m").
4. `STOP` / `UNSUBSCRIBE` / "band karo" handling writes an opt-out before any
   other interpretation of the message.
5. Cloud: `dashboard.$connectionId.inbox` — threads, assignment, canned
   replies, and the contact's timeline in the right-hand rail. Inbound messages
   write `Activity` rows, so the Phase 5 timeline gets richer for free.
6. Media: photo and document inbound (payment screenshots, prescriptions,
   reference images) stored and attached to the contact.

Exit: a customer replies "can we move to Thursday?" and it lands in an inbox,
attributed to the right contact, with their booking history beside it.

---

### Phase 8 — Running the business from the thread

This is the phase that makes the product's claim true, and it is the one most
likely to be underestimated. Entitlement key: `whatsapp_operator`.

1. **Operator recognition** (D6): verified `User.phone` → `ConnectionMember` →
   role. Everything else is a customer.
2. **Command router** over interactive messages first, free text second.
   Buttons and list replies are unambiguous, work in every language, and need
   no model call. Reserve natural language for the long tail and always
   confirm before a write.

   | Command | Calls |
   |---|---|
   | `today` / `tomorrow` / `week` | `Data.bookingsInRange` |
   | `book Ravi 4pm haircut` | `Availability` + `Bookings.create` |
   | `cancel 4821` / `move 4821 to Thu 5pm` | `Bookings.setStatus` / `reschedule` |
   | `block Fri 3-5` | `TimeOff` |
   | `collect 500 from Ravi` | `Payments` + `paymentLinks` |
   | `note Ravi prefers morning` | `ContactNote` |
   | `remind everyone tomorrow` | outbox enqueue |
   | `pause bookings` | `settings` |

3. **The daily digest** — one message at a configurable hour: today's
   schedule, gaps, unpaid amounts, who hasn't confirmed, yesterday's takings,
   anything needing a decision, with buttons to act. For most merchants this
   *is* the dashboard, and it is the highest-retention artifact in the entire
   plan.
4. **Approval flows** — a booking request arrives as a message with
   Approve/Decline buttons when `auto_confirm` is off. No one has to open
   anything.

Exit: a week of running a real business without opening the dashboard once.

---

### Phase 9 — The marketing half

Entitlement key: `broadcasts`. New limit key: `broadcastsPerMonth`.

Schema:

```
Segment   (id, connectionId, name, definition Json, isDynamic, cachedCount, refreshedAt)
Campaign  (id, connectionId, name, channel, templateKey, segmentId, status,
           scheduledFor, sentCount, deliveredCount, readCount, replyCount,
           clickCount, optOutCount, attributedBookings, attributedRevenue)
ShortLink (id, connectionId, slug unique, targetUrl, campaignId?, contactId?, clicks)
LinkClick (id, shortLinkId, contactId?, at, userAgent, ip)
```

Work:

1. **Segments** as saved filters over contact + booking facts: last booked
   before X, never booked, booked service Y, spent over Z, tagged, birthday
   this month (`Customer.dateOfBirth` already exists), no-showed, lapsed.
   Dynamic by default — a static list is stale the day after it is made.
2. **Broadcasts**: pick a segment, pick an approved marketing template,
   preview with real substitutions, see the estimated Meta cost before
   sending, schedule, send through the outbox with rate limiting.
3. **Guard rails, enforced in code and not in a help doc**: marketing consent
   required; a per-contact frequency cap; an opt-out footer; a hard block on
   sending to anyone who opted out. A merchant who gets their number's quality
   rating downgraded blames the software, and they are not entirely wrong.
4. **Attribution**: short links carry campaign and contact; the public booking
   page captures the click and writes `Booking.source` plus a campaign
   reference — so a campaign reports bookings and revenue, not opens. Widen
   `Booking.source` to include `whatsapp|broadcast|link|qr`.
5. **Two things to ship on day one** because they are what SMEs actually ask
   for: *fill this slot* (a broadcast to a segment about a specific gap
   tomorrow) and *win back* (everyone who hasn't come in 90 days, with an
   offer).

Exit: a merchant fills a quiet Tuesday from their phone and can see that it
worked.

---

### Phase 10 — Automations

Entitlement key: `automations`. This is where the existing event bus pays off.

```
Automation     (id, connectionId, name, trigger, conditions Json, actions Json,
                enabled, runCount)
AutomationRun  (id, automationId, contactId, state, scheduledFor, ranAt, error?)
```

Triggers are the bus events plus a time-relative scheduler (`N hours after
booking_completed`, `N days since last booking`, `on birthday`). Actions:
send a template, add a tag, change a stage, create a task, notify the owner,
wait.

Ship six working recipes rather than a builder — a blank canvas is the reason
most SME automation tools are unused:

| Recipe | Trigger | Why |
|---|---|---|
| Post-visit thank-you and review ask | 3h after `booking_completed` | Reputation compounds |
| No-show follow-up | on `no_show` | Recovers ~20% of them |
| Win-back | 90 days since last booking | The single highest-ROI message an SME sends |
| Birthday offer | DOB matches | Already have the data |
| Rebook nudge | service-specific interval (6 weeks for a haircut) | Turns a customer into a subscription |
| Unpaid balance chase | 24h after an unpaid completed booking | Money |

Exit: a merchant switches on three recipes and the product works while they
sleep.

---

### Phase 11 — The dashboard that only pulls metrics

Now, and not before, because now there is something to measure. Rebuild
`dashboard.$connectionId._index` as a metrics surface, and stop the dashboard
pretending to be an operating console.

**Money** — revenue by period (restored in Phase 5), collected vs
outstanding, average booking value, revenue by service and by staff.
**Demand** — bookings over time, new vs returning, lead time, cancellation and
no-show rate, utilisation per resource, busiest hours (which is a pricing
input, not a curiosity).
**Contacts** — total, new this period, active/lapsed/VIP mix, repeat rate,
lifetime value distribution, churn signal (lapse rate).
**Channel** — messages sent by category, delivery/read/reply rates, opt-out
rate, quality rating and messaging tier, and an estimated Meta spend.
**Marketing** — per-campaign bookings and revenue attributed, not opens; short
link click-through; top-performing segment.
**Funnel** — link click → booking page → slot selected → booked → attended →
paid, with drop-off at each step. This is the one screen that tells a merchant
what to fix.

Everything is aggregated in `core/src/crm/metrics.ts` alongside the existing
`metrics.ts`, date-ranged, exportable as CSV under the existing `export`
feature key — and mirrored into the Phase 8 digest, because the merchants who
need these numbers most are exactly the ones who will not open a browser.

---

### Phase 12 — Reputation and referral (optional)

Review requests routed to Google/Justdial with a rating gate; referral codes
as short links attributed to the referring contact; a simple NPS pulse. Cheap
once Phases 9–10 exist, and the compounding growth loop for a local business.

---

## 7. Packaging

Respect `plans.ts`'s stated principle — *the ladder climbs on team and
capacity, not features* — with one deliberate exception: marketing is a
different job to be done from booking, and is worth a tier.

New feature keys: `whatsapp`, `whatsapp_operator`, `broadcasts`,
`automations`, `crm_pipeline`, `reviews`.
New limit keys: `contacts`, `broadcastsPerMonth`, `automations`.

| Plan | Change |
|---|---|
| Free | Unchanged. 200 contacts. No WhatsApp. |
| Starter | `whatsapp` (transactional only), 2,000 contacts. The reason to upgrade becomes "my confirmations come from my own WhatsApp", which sells itself. |
| Growth | `whatsapp_operator`, `broadcasts` (4/month), `automations` (3 active), 10,000 contacts. |
| Business | Unlimited everything, `reviews`, priority support. **Make it visible** — this plan gives the hidden fourth tier something to contain. |

Price accordingly. A tool that replaces a CRM subscription, a broadcast tool
and a reminder tool is not a ₹399 product at the top of the ladder; Growth and
Business should roughly double. Grandfather existing accounts — the machinery
for that is already in the billing workstream's open items.

---

## 8. Decision gates

Answer these before the phase they block.

| Gate | Question | Blocks | Why it can't wait |
|---|---|---|---|
| **G5** | Register GetBooqin as a **Meta Tech Provider** and submit the app for `whatsapp_business_messaging` / `whatsapp_business_management` review? | Phase 6 | Review is weeks and involves business verification. Start it during Phase 5; it is pure calendar time and blocks everything downstream. |
| **G6** | **BYO-WABA or resell?** | Phase 6 | §3 recommends BYO. Choosing resell changes pricing, adds credit risk, adds a wallet/top-up surface, and makes one tenant's spam everyone's throughput problem. |
| **G7** | **Does the operator message the business's own number, or a separate GetBooqin assistant number?** | Phase 8 | Same number is zero extra setup but means operator and customer traffic share one thread space and one quality rating. A separate number is cleaner and is one more thing to provision. Recommendation: same number, disambiguated by verified sender (D6). |
| **G8** | **Which market first — India or international?** | Phase 9 | India: UPI links already work, WhatsApp is universal, message costs are low, DPDP applies. International: higher ARPU, WhatsApp adoption varies wildly by country, GDPR consent is stricter. The product is measurably better in India; the revenue is better elsewhere. Pick one for the first 50 customers. |
| **G9** | **Is an AI reply assistant in scope?** | Phase 7 | Drafting replies and answering FAQ from the (already existing but unused) `Faq` table is a strong feature and a per-message cost plus a hallucination-in-front-of-a-customer risk. Recommendation: suggest-only, never auto-send, and not before Phase 7 has real conversation volume to learn the shape of. |

---

## 9. Risks

- **Meta onboarding is the funnel.** Every merchant who cannot get a number
  verified is a churned signup. The product must be completely usable on email
  while WhatsApp is pending, and the wizard must be better than the one their
  competitor's BSP gives them. This is a product problem, not a support one.
- **Template approval latency and rejection.** Marketing templates get
  rejected for wording. Ship pre-approved templates that merchants customise
  within a known-good structure rather than a free text box.
- **Quality rating downgrades.** One bad broadcast throttles a merchant's
  number. The consent ledger, frequency caps and opt-out handling in D4/§9.3
  are not compliance theatre; they are what stops the product visibly breaking.
- **The inbound webhook is the first real availability requirement.**
  `fly.toml` runs one machine and every scheduled job is an in-process
  interval. A missed customer message is worse than a missed cron tick. Phase 7
  needs at least: signature verification, fast ack, durable raw-payload
  storage, and replay.
- **Scope.** Phases 5–7 are a product. Phases 8–12 are a second one. If
  something has to be cut, cut 12, then 10, then the builder half of 9 — never
  5, 6 or 7.
- **Two products in one dashboard.** Bookings and CRM can drift into separate
  navigation trees with separate customer lists. D1 (one identity model) and
  D5 (commands call core) are the two rules that prevent it. Hold them.

## 10. Explicitly not doing

- **A deal pipeline with stages and drag-and-drop.** A salon does not have
  deals. `Customer.stage` plus tasks covers the real need; kanban is
  cargo-culted from B2B SaaS CRMs and would be the most-built, least-used
  screen in the product.
- **A generic automation canvas** before the six recipes prove which triggers
  anyone uses.
- **Instagram and Facebook Messenger inboxes.** Same Meta plumbing, genuinely
  tempting, and a straight doubling of the surface area. After Phase 11, on
  demand.
- **Email marketing campaigns.** WhatsApp is the wedge. Adding a second
  broadcast channel before the first one works is how this loses focus.
- **Owning message billing** (§3). Revisit past 100 paying tenants.
