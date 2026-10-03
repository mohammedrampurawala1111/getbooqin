# Review 10-01-2026 — fix plan

> **Status (branch `review-10-01-fixes`).** Waves 1–3 and item 13 are
> implemented across five commits. Wave 0 is not, and cannot be from here:
> items 2, 7 and 15 are unset production secrets and Razorpay/PayPal plan
> creation. Item 12 is deliberately undiagnosed — set `SENTRY_DSN` first.
> Item 3 shipped as a removal, not a fix: MFA needs a paid Clerk plan.
> Findings made while implementing are recorded in the commit messages.

Response to the 15-item client review, plus the Clerk phone-number question.

Every item below was checked against the code before being written up, so
the "what's actually there" line is what the repo does today, not a guess.
Three of the fifteen are **configuration, not code** — they will keep
reproducing on every deploy until the secrets are set, and no amount of
code review finds them.

Ordering is by "what is broken in production for a paying merchant", not
by the review's numbering.

---

## Wave 0 — configuration (do first, no code)

Review items 2, 7 and 15 are why the demo looked worse than the product
is. Nothing in this wave is a code change — it is `fly secrets set` plus
creating the plans at Razorpay/PayPal. Doing it first also stops Wave 1
from chasing ghosts.

Item 3 was in this wave until we ruled out a paid Clerk plan; see C2.

### C1. Email delivery — covers review items 2 and 7

**What's actually there.** `core/src/booking/mailer.ts:149` builds a
nodemailer transport from `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`.
`mail()` at `:239` returns silently when there is no `SMTP_HOST` — so every
booking confirmation and cancellation is dropped with a `console.warn` and
nothing else. That is exactly review item 7: the page says "A confirmation
has been sent to your email" because the send path "succeeded".

The invite is the same root cause surfacing differently.
`core/src/team.ts:128` wraps the send in `trySendInvite()`, which returns
`emailSent: false` on any throw, and the UI prints
`cloud/app/components/settings.tsx:499`. So item 2 is the *only* email in
the product that tells the truth about its own failure.

**Two candidates, and they are distinguishable:**

| Symptom | Cause | Check |
|---|---|---|
| invite says "couldn't be sent", bookings silent | SMTP configured but the relay is rejecting (bad creds, unverified sender, `MAIL_FROM_EMAIL` not authorised on the domain) | `fly logs` for `[getbooqin mailer] sent …` lines with a non-empty `rejected=` |
| invite says "couldn't be sent", bookings silent | `APP_URL` missing — `appUrl()` at `mailer.ts:609` throws *before* `mail()` is reached, and only the invite path calls it | `fly ssh console -C 'printenv APP_URL'` |

`APP_URL` is set in `fly.prod.toml:98`, so the relay-rejection case is the
likelier of the two — but check both, it is two commands.

**Fix:**
1. Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM_EMAIL`,
   `MAIL_FROM_NAME` as Fly secrets on `getbooqin-prod`.
2. `MAIL_FROM_EMAIL` must be on a domain with SPF + DKIM + DMARC aligned for
   that relay. `fromHeaders()` at `mailer.ts:206` already does the correct
   "Business Name via GetBooqin" shape with `Reply-To` back to the merchant —
   it just needs an address it is allowed to send as. The warning at
   `mailer.ts:159` fires at boot if this is missing; grep the boot log for it.
3. Send a test booking end-to-end and read `rejected=` in the log line at
   `mailer.ts:253`, which already prints everything needed.

**Code change worth doing alongside (small):** make the booking path as
honest as the invite path. `mail()` returning silently on an unconfigured
transport is right for local dev and wrong in production — have it throw
when `NODE_ENV === "production"`, so `logMailError` records a real failure
instead of a successful no-op, and add a `/healthz?strict=1` check that the
transport exists. Without this, the next time SMTP breaks it is again
invisible.

### C2. Two-step verification — review item 3 → **moved to Wave 1, and the answer is "no"**

**MFA is not available on Clerk's free (Hobby) plan in production.** It is
listed as a Pro feature: *"Allow users to enable multifactor authentication
with authenticator applications, SMS codes, and backup codes."* It works in
development mode only, which is why this has never looked broken locally.

Since we are staying on the free plan, there is no toggle that fixes this.
See [Item 3, reworked](#3-two-step-verification--the-ui-promises-what-the-plan-cannot-deliver)
in Wave 1 — the fix is to stop advertising it.

### C3. Subscription payment — review item 15

**What's actually there.** The checkout is fully built —
`core/src/billing/checkout.ts`, with Razorpay and PayPal providers under
`core/src/billing/providers/`. The banner the reviewer screenshotted ("We
couldn't start that subscription") is thrown at `checkout.ts:251` when
`provider.createSubscription()` fails.

`providers/razorpay.ts:84` builds its plan index from `PRICES[...].razorpay[mode]`
and **skips any entry whose plan id is empty** — the comment says it
outright: "Empty means the plan hasn't been created at Razorpay yet."
`sellablePrices()` at `checkout.ts:325` exists precisely so the UI does not
offer a button for a price with no plan behind it, and its own comment
describes the exact failure the reviewer saw.

**Fix:** no code. Run `core/scripts_create_paypal_plans.ts` and the Razorpay
equivalent against the live keys, write the returned plan ids into
`core/src/billing/plans.ts` for the `live` mode, and set
`RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` (and
the PayPal trio) as Fly secrets. Then confirm the Billing page stops
offering a plan it cannot sell — if the "Switch to Starter" button is still
there with no plan id, `sellablePrices()` is not being consulted by that
button and that *is* a code fix.

---

## Wave 1 — correctness bugs (code, small, high value)

### 1. Phone validation — review items 1 and 5

**What's actually there.** Validation exists and is shared properly:
`cloud/app/lib/validation.ts:8` (`isValidPhone`), `PHONE_PATTERN` at `:23`
for the native `pattern` attribute, server-side twin at
`core/src/booking/bookingsShared.ts:75` (`isPhone`).

The reviewer's two screenshots are two different gaps:

- **Item 1 (onboarding, `/onboarding`).** `onboarding.tsx:585` renders the
  error correctly — the screenshot even shows "Enter a valid phone number."
  But that is *display only*: `handleStep1`'s submit does not block on it,
  and the server action at `:147` takes `business_phone` as a raw string and
  writes it at `:156` with no `isPhone` check. So the message appears and
  Continue still works. **Fix:** gate the submit on the same check, and add
  the server-side `Bookings.isPhone()` guard before `settingsPatch.business_phone`.
- **Item 5 (public booking form, `/book/:id`).** `contactFieldErrors()` at
  `validation.ts:48` *does* check the phone — so the "asa" in the screenshot
  should have been caught. Reproduce this one before fixing: most likely the
  booking form calls it with `requirePhone: false` and an empty-ish value
  path, or the client-side call site is not awaited before submit. The
  shared function is correct; the call site is where to look
  (`cloud/app/routes/book.$connectionId.tsx`, the `handleBook` action).

**Also do:** reject letters at the keystroke level is tempting and wrong —
`+`, spaces, parens and dashes are all legitimate, and blocking input makes
paste-from-contacts fail. Keep the current "accept, then validate" shape;
just make the validation actually block.

### 12. "Unexpected Server Error" every 4–5 minutes

**What's actually there.** That exact string is nowhere in this repo — it is
React Router v7's default `statusText` for a loader/action that threw a
non-`Response` error server-side. So it is a real 500 reaching the client
sanitised, not a UI bug. `root.tsx:75`'s ErrorBoundary renders "Something
went wrong"; the reviewer saw the raw statusText, which means it surfaced
through a route-level boundary or a fetcher, not the root one.

**This one needs data before a fix.** The instrumentation is already written
and is simply switched off: `server/instrument.js` is completely inert
without `SENTRY_DSN`, and `SENTRY_DSN` is in `.env.example:115` but not set
on prod.

**Step 1:** `fly secrets set SENTRY_DSN=…` on `getbooqin-prod`. Then
reproduce — 4–5 minutes is one or two stack traces away.

**Step 2, candidates ranked by how well they fit a 4–5 minute period:**

1. **Prisma connection dropped.** `core/src/db.ts` constructs `new PrismaClient()`
   with no explicit pool or timeout settings. Fly Postgres / pgbouncer closing
   an idle connection produces a `P1017` on the *next* query, which is exactly
   "fine for a few minutes, then one request 500s, then fine again". Highest
   prior.
2. **Two machines, one in-process scheduler.** `fly.prod.toml:145` sets
   `min_machines_running = 2`, and `core/src/jobs.ts`'s own header comment
   says the duplicate-sweep hazard "hasn't bitten yet" because
   `min_machines_running` is 1 — that comment is now stale. The lease in
   `record()` is designed for this, but a lease *contention* path that throws
   rather than declining would fire on the job interval.
3. **Clerk session handshake.** A failed `authenticateRequest` in
   `session.server.ts:53` throws rather than returning null, and Clerk token
   refresh is periodic.

Do not write a fix for this item until a stack trace exists. Guessing at a
periodic 500 is how you ship three fixes and still have the bug.

### 14. Text overlapping in the Bookings table

**Root cause found.** `cloud/app/components/ui.tsx:376` wraps each cell in
`<div className="min-w-0">`, and the row content at
`dashboard.$connectionId.bookings.tsx:379-383` is `<span className="min-w-0 truncate">`.
**`truncate` does nothing on an inline element** — `overflow: hidden` and
`text-overflow: ellipsis` are ignored on a non-block box, so the span paints
straight over its neighbour. That is precisely the screenshot.

**Fix (one line, fixes every table in the app):** move the truncation onto
the wrapper the Table component already owns —
`<div className="min-w-0 truncate">` at `ui.tsx:376`. Audit the other
`Table` call sites afterwards; any that rely on a cell wrapping (a two-line
cell) will need to opt out.

**Second, separate bug in the same screenshot.** The STAFF column reads
`manual-77cd2e49-85b3-4068-b629-1902edb8bc34` — the internal tenant key.
`core/src/connections.ts:119` sets `shop = \`manual-${randomUUID()}\``, and
`core/src/booking/settings.ts:28` defaults `business_name` to that shop
value. `onboarding.tsx:283` names the first resource
`settings.business_name || "Bookings"`, so when that default has not been
overwritten yet the resource inherits the UUID — and it then shows on the
booking page ("with manual-77cd…"), the confirmation email, and every row
of this table. **Fix:** never let the shop-key default reach a user-visible
string — treat `business_name === shop` as unset wherever it is read for
display, and backfill existing `Resource.name` rows that match
`^manual-[0-9a-f-]{36}$`.

### 3. Two-step verification — the UI promises what the plan cannot deliver

**The reviewer found a real defect, but not the one they described.** The
buttons are not missing: `dashboard.$connectionId.account.tsx:397` renders
**Turn on** and `:419` renders **Manage**, both opening Clerk's Security
page. The reviewer's own screenshot shows both.

What is missing is the capability behind them. **MFA is a paid Clerk
feature** — the free Hobby plan has no multi-factor in production, only in
development mode. So Clerk's Security page opens with no authenticator or
backup-code option on it, which is exactly what "there is no visible option
to actually set up two-step verification" looks like from outside.

This is worse than the review says. We are not missing a button; we are
**advertising a security control the account cannot provide**. The card copy
("This account can see every patient's contact details and notes. A second
sign-in step is the single biggest thing you can do to protect it.") is a
promise to a clinic about patient data that the product does not keep.

**Fix, given we are staying on the free plan — remove both cards.** Delete
the "Turn on two-step verification" banner (`:388-404`) and the "Two-step
verification / Manage" row (`:407-427`). A dead end is worse than an absence:
a merchant who clicks through and finds nothing concludes the product is
broken, and one who reads the copy and clicks nothing concludes they are
protected when they are not.

If something should stand in its place, make it honest and small — a line in
Security saying two-step verification is on the roadmap, or nothing at all.
Do not leave a button.

**What it would cost to actually ship it** — so this is a decision, not a
default:

| Route | Cost | Notes |
|---|---|---|
| Clerk Pro | $25/mo | Unblocks MFA, SMS, custom session length, Clerk branding removal. The free tier's user allowance is generous — the gate here is features, not volume, so this does not get cheaper by staying small. |
| Self-hosted TOTP | ~1 week + ongoing | `otplib` + a secret per user in our own Postgres, enforced in `session.server.ts`. Means owning a security-critical path Clerk currently owns, including backup codes, recovery, and lockout. Not recommended for a $5/month product. |
| Defer | 0 | Recommended. Revisit when a clinic asks for it in writing, or when Pro is being bought for SMS anyway. |

**Tell the client this one plainly.** "Deferred — requires a paid auth tier"
is a fine answer. Leaving the buttons in place and saying it is fixed is not.

### 4. Confirmation prompt on account deletion

**What's actually there.** `dashboard.$connectionId.account.tsx:739` already
requires typing the business name to confirm, and the form shows an itemised
count of what will be destroyed. That is a *stronger* guard than a modal.

The reviewer is still right about something: type-to-confirm with no
interstitial means the final click is instant and irreversible, and the
`required` input only produces a native browser tooltip.

**Fix (small):** add a modal on submit — "Delete *trevorhayes* and 1 booking,
1 customer record, 4 services permanently? This cannot be undone." with
Cancel / Delete. Keep the type-to-confirm; the modal is the second gate, not
a replacement. Reuse the existing dialog pattern from
`dashboard.$connectionId.timeoff.tsx`.

### 6. "Add to calendar" downloads an .ics

**What's actually there.** `book.$connectionId.tsx:1413` renders an
`<a href={icsDataUrl(...)} download>`. That is correct behaviour for Apple
Calendar and Outlook desktop, and useless on Android/Chrome, which is what
the reviewer tested.

**Fix:** replace the single link with a small three-way chooser, which is
what every booking product does:

- **Google Calendar** — `https://calendar.google.com/calendar/render?action=TEMPLATE&text=…&dates=…&details=…&location=…`
- **Outlook Web** — `https://outlook.live.com/calendar/0/deeplink/compose?…`
- **Apple / other** — keep the current `.ics` download.

`core/src/booking/calendar.ts` already has `buildIcs()` with the event shape;
add a `calendarLinks(event)` export beside it returning the three URLs from
the same `CalendarEvent`, so the data is built once.

---

## Wave 2 — missing features the backend already has

These three are the cheapest wins in the whole list: the hard half is
written and tested, and only the customer-facing UI is missing.

### 8. Reschedule a booking

**Backend exists.** `core/src/booking/bookings.ts:741` is a full
`reschedule()` with availability re-checking and an override flag, the
`booking_rescheduled` event is wired to email at `mailer.ts:init`, and the
public API endpoint is already routed:
`cloud/app/routes/v1.public.$slug.bookings.$uid.reschedule.tsx`.

**Missing:** the customer-facing button. `book.$connectionId.tsx:658`
currently says "Need to change the time instead? Contact {business}
directly." — i.e. the UI knowingly points at a human for something the
server can already do.

**Fix:** on the manage-booking view, add **Reschedule** beside *Cancel this
booking*. It reuses the existing slot picker from the booking flow (same
`slots` fetcher, same date bounds), then POSTs the existing intent. Gate it
on the same notice window `cancelUnavailableReason` already computes — the
copy for "too late to reschedule" is already written.

### 10. Join a waitlist for a preferred date

**Backend exists, and it is thorough.** `core/src/booking/waitlist.ts` with
the full offer cascade, `Waitlist` model with `offered`/`claimed`/`expired`
states and an offer token, cron at `shopify-openslot/app/routes/cron.waitlist.tsx`,
and four email templates. The booking page already offers it —
`book.$connectionId.tsx:1104` — but **only on a day with zero slots**.

**Missing:** exactly what the reviewer describes — the prompt after a
*successful* booking on a different day. "You're booked for Tuesday. Prefer
Monday? Join the waitlist for Monday."

**Fix:** on the confirmation panel, when the customer's originally-selected
date differs from the one they booked, render the existing
`JoinWaitlistForm` (already at `:777`) pre-filled with the original date.
This is a UI change only; `handleJoinWaitlist` at `:327` takes it as-is.

**Blocker to fix first — the claim link is broken for cloud merchants.**
`mailer.ts`'s `waitlistTokens()` builds `{{claim_url}}` as
`https://${shop}/apps/getbooqin/waitlist/${offerToken}` — a Shopify
app-proxy path. For a manual connection `shop` is `manual-<uuid>`, so the
claim URL in every waitlist offer email on the cloud product is
`https://manual-77cd2e49-…/apps/getbooqin/waitlist/…`, which resolves to
nothing. This must be `${APP_URL}/book/${connection.id}?claim=<token>` for
`platform === "manual"`. Shipping the waitlist prompt without this fix ships
a feature whose payoff email is a dead link.

### 13. Collect payment before booking confirmation

**Backend largely exists.** `core/src/booking/payments.ts` and
`paymentLinks.ts` do UPI QR + PayPal.me, the `Payment` model has
`status`/`utr`/`reference`/`paidAt`, and `ServiceConfig` already carries
`paymentRequired` / `depositPercent` / `depositAmount`
(`core/prisma/schema.prisma:261`).

**Be honest with the client about the model, though.** `payments.ts`'s own
header is explicit: *"a payment is marked paid by a person, not verified."*
The merchant supplies a UPI ID, the customer pays them directly, no
aggregator is involved — deliberately, to avoid Razorpay Route's turnover
threshold. So "the booking should only be marked confirmed after the payment
is successfully completed" **cannot be automatic** under the current design.

Two options, and this is a product decision, not an engineering one:

| | Ship now | Ship properly |
|---|---|---|
| Flow | Booking lands `pending`, customer is shown a UPI QR, merchant confirms the UTR, booking → `confirmed` | Razorpay Route / PayPal Commerce, webhook-driven auto-confirm |
| Status | Works with `STATUSES` as they are — `pending → confirmed` is already a legal transition (`bookingsShared.ts:25`) | Needs a new `awaiting_payment` status and transitions |
| Cost | Days | Weeks, plus the aggregator onboarding `payments.ts` was designed to avoid |

Recommend shipping the first and labelling it accurately in the merchant UI
("Payment recorded by you" not "Payment verified"). Put the second behind
the decision about whether GetBooqin wants to be in the money flow at all.

### 9. Custom thank-you page URL

**Does not exist.** No `thank_you_url` or equivalent in
`core/src/booking/settingsShared.ts`'s 79 settings keys.

**Fix (genuinely small):**
1. Add `thank_you_url: string` to the `Settings` interface and defaults.
2. Surface it in Settings → Booking rules, beside the existing
   `privacy_notice_url` field, with the same URL validation.
3. Expose it through `publicSettings()` in `book.$connectionId.tsx:40`.
4. On a successful booking, redirect instead of rendering the confirmation
   panel — carrying `?ref=<booking.uid>` so the merchant's page can
   acknowledge the booking.
5. **Validate it server-side as an absolute `https://` URL.** This value is
   merchant-controlled and becomes a redirect target; without a scheme and
   host check it is an open redirect on the one page in the product that
   anonymous visitors reach.

---

## Wave 3 — the slug change (item 11)

**This is the only structural item in the list, and the reviewer is right.**

`core/src/connections.ts:173`'s `ensureSlug()` does
`slugify(businessName)`, then appends `-1`, `-2`, … on collision (`:186`).
Every objection in the review follows from that: two "Trevor Hayes" clinics
race for the good URL, the loser gets `-1`, and a business adding a second
location has no answer at all.

**The good news: the migration is nearly free.** `publicConnection()` at
`connections.ts:206` already resolves `{ OR: [{ id: idOrSlug }, { slug: idOrSlug }] }`
— the cuid `id` resolves permanently and `ensureSlug()` is idempotent
(`:175` returns an existing slug untouched). So **existing links keep
working with no redirect layer**, which is the review's last requirement
satisfied for free.

**Fix:**
1. Replace the body of `ensureSlug()` with a random, non-sequential,
   collision-retried slug: 8 characters from a Crockford-style alphabet
   (no `0/O`, `1/l/I`) — `/book/tco71cw7`, as the review suggests. Keep the
   retry loop; just make the candidate random rather than `base-${n}`.
2. **Do not rewrite existing slugs.** A merchant who has already printed a
   QR code or put `/book/trevorhayes` in an Instagram bio must keep it. New
   connections get random slugs; old ones keep what they have. The review
   asks for uniqueness going forward, not for breaking live links.
3. Add a **custom slug** field in Settings so a merchant who *wants*
   `/book/trevorhayes` can claim it deliberately, first-come — which is the
   honest version of what the name-derived slug was pretending to do.
   Validate against a reserved list (`book`, `admin`, `v1`, `api`, `login`,
   `webhooks`, …) and the same uniqueness constraint.

**On "multiple locations".** Worth being precise with the client: in this
schema a `Connection` **is** a location — the Billing page's own meter reads
"Businesses or locations 1 / 1" (`core/src/billing/plans.ts`). So
"a unique slug per location" and "a unique slug per Connection" are the same
change. There is no separate Location model to add, and this item does not
require one.

**Authorization is already correct** and does not change: `publicConnection()`
refuses a revoked connection, `publicSettings()` at `book.$connectionId.tsx:40`
deliberately projects only customer-safe fields, and dashboard routes go
through `getUserConnection()`. Say so explicitly in the reply — three of the
review's seven bullet requirements are about authorization and are already met.

---

## The Clerk phone-number question — on the free plan

**Decision up front: keep doing what the code already does.** The current
design is not a workaround to be removed; on a free Clerk plan it is the
correct design, and the schema comment explaining it should stay.

### Why the obvious routes are closed

`core/prisma/schema.prisma:59` records the constraint: phone is "Collected
at signup for our own records only — not sent to Clerk, since Clerk's SMS
country allowlist rejects +91." That is accurate as far as it goes, but on
the free plan the real blocker is one layer up.

Clerk restricts SMS to an allowlist of countries, **US and Canada only by
default**, and a number from a disabled country "cannot be used upon
sign-up". Three things follow, and all three are paid:

| Route | Blocked by |
|---|---|
| Enable India on the SMS allowlist | Allowlist is a Pro/Business feature, and SMS is metered per message at international rates |
| Phone as a sign-in identifier | Phone authentication requires a paid plan in production; free in dev mode only |
| Phone verified by OTP at signup | Requires both of the above |

So there is no free path to a *verified* phone number in Clerk, and no free
path to phone-as-credential. That is settled.

### What we do instead — Option B, already implemented

`cloud/app/routes/dashboard.profile-phone.tsx` POSTs the number to our own
database after the session goes active; Clerk never sees it. `User.phone`
holds it, `isValidPhone` guards the write server-side (the route's comment
notes this is the only server-side write path, added after "abcdefg" saved
cleanly with a 200).

This costs nothing, works for +91 and every other country, and is honest
about what the number is: a contact field, not a credential. Nobody signs in
with it, so nothing needs to verify it.

**Keep it. Three improvements worth making, all small:**

1. **Normalise to E.164 on write.** `dashboard.profile-phone.tsx` stores the
   raw string. `core/src/booking/bookingsShared.ts:89`'s `normalizePhone()`
   already prepends a country code, strips a leading `0`, and leaves `+`/`00`
   alone — and is unit-tested against `+91` at
   `bookingRulesValidation.test.ts:145`. Use it here, so `9325705315` and
   `+91 93257 05315` are not two different records of the same merchant.
   This is the same gap PB-03 fixed for *customer* phone numbers; the
   merchant's own number never got the fix.
2. **Make it non-best-effort.** `signup.tsx:88` fires the POST and ignores
   the result. The field is marked `required` in the form, so a dropped
   request silently produces an account with no contact number. Either await
   it and surface a failure, or accept the loss deliberately and drop
   `required` — the current combination promises something it does not keep.
3. **Update the schema comment.** `schema.prisma:61`'s "Re-evaluate once
   phone-based sign-in is wired up through Clerk properly" implies this is
   temporary. On a free plan it is not. Rewrite it to say the decision and
   its reason, so the next reader does not re-litigate it.

### The one route that might work for free — test it before believing it

Clerk's **Backend API** `createPhoneNumber()` takes a `verified` flag that
defaults to false and can be set to true, creating the number on the user
**with no SMS round trip at all**. The SMS allowlist governs *sending*; this
sends nothing, so India is irrelevant to it.

```ts
await getClerkClient().phoneNumbers.createPhoneNumber({
  userId: session.userId,
  phoneNumber: e164,   // normalizePhone() output
  primary: true,
  verified: true,      // no SMS is sent; see the caveat below
});
```

**Do not plan around this yet.** Clerk's reference page for
`createPhoneNumber()` documents no plan gating, but the add-a-phone guide
says the phone attribute must be enabled under User & Authentication — and
*that* is the switch tied to the paid phone-authentication feature in
production. Whether a backend-created, pre-verified number slips past that
gate on a Hobby instance is not something the docs answer either way.

It is a ten-minute experiment: one Backend API call against the production
instance. If it returns the phone number, we get Clerk-side storage for
free — the number shows up in the Clerk dashboard, in exports, and in
`user.updated` webhooks, and `User.phone` becomes a mirror rather than the
only copy. If it 403s with a plan error, we have lost ten minutes and
Option B stands unchanged.

**If it does work, write the comment carefully.** `verified: true` would be
a lie about provenance — we have not verified anything. That is acceptable
for a stored contact attribute and *not* acceptable if the number is ever
promoted to a recovery channel or second factor. Say so at the call site,
because the next reader will assume the flag means what it says.

### What to tell the client

Phone numbers are collected at signup and stored against the account; they
are not SMS-verified, and Indian numbers work fine. Verified phone numbers
and phone-based sign-in need a paid auth tier and are not planned.

---

## Suggested sequencing

| Wave | Items | Shape |
|---|---|---|
| 0 | 2, 7, 15 | Secrets + Razorpay/PayPal plan creation. No code. Unblocks the rest. |
| 1 | 1, 5, 14, 3, 4, 6 | Small, independent, parallelisable. ~1 day each. Item 3 is a deletion. |
| 1b | 12 | Set `SENTRY_DSN` in Wave 0, then diagnose. Do not pre-fix. |
| 2 | 8, 10, 9 | UI over existing backend. Fix the waitlist claim-URL bug *before* item 10. |
| 2b | 13 | Needs a product decision first (manual vs. aggregator). |
| 3 | 11 | Structural, but migration-free. Ship after Wave 1 is green. |
| — | Clerk phone | Option B, already shipped — three small hardening fixes. Independent of everything above. |

## Worth saying back to the client

**Three of the fifteen (2, 7, 15) are unset production secrets** — not
defects in the code. Items 8, 10 and 13 are reported as missing features but
are built and tested server-side; only the customer-facing button is absent.
That is a much better position than the review reads as, and it is worth
stating plainly.

**One item we are declining, and should say so rather than quietly not do:**
item 3, two-step verification. It requires a paid Clerk tier. We are
removing the UI that advertises it rather than leaving a button that goes
nowhere — which means the client will see that section *disappear* in the
next build, and should hear why from us first, not notice it themselves.

**One item the review asked for that is partly impossible as specified:**
item 13. "Confirmed only after payment succeeds" cannot be automatic while
payments go merchant-direct over UPI with no aggregator in the loop. The
honest version — booking held `pending`, merchant confirms the UTR — is
shippable now; the automatic version is a decision about whether GetBooqin
enters the money flow at all.
