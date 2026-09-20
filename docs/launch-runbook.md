# Launch runbook — everything between here and a first paying client

[The Phase 0 runbook](phase-0-runbook.md) covered the operational half
of making the product work. This is its counterpart for the half that
takes money, and for the half that puts a stranger's booking link on a
domain that is actually ours.

**The code is done.** 577 core tests pass, three typechecks are clean,
and every workstream from the [MVP trim plan](mvp-trim-plan.md) has
landed. Nothing below is a feature; every item is a credential, a DNS
record, an account at a vendor, or a decision only you can make.

---

## Why this document exists at all

Phase 0 ended with five items whose code was merged and whose *effect*
depended on a human doing something — a DNS record, a Sentry project, a
restored backup. The same shape repeats here, and worse, because the
failures in this list have **no symptom**.

A missing secret breaks something visibly on the first request. A
sandbox credential works perfectly, takes no money, and looks like a
successful upgrade to everyone involved. A Clerk development instance
signs people in exactly like a production one right up until the user
cap. A `getbooqin.fly.dev` link in a confirmation email delivers fine
and just quietly tells your client's customer that this is somebody's
side project.

So two things now report this rather than a checklist:

- **`Env.productionWarnings()`** runs at every boot and prints each
  problem with its fix beside it. Warnings, never fatal — a staging box
  is *supposed* to hold test keys.
- **`/admin`** shows the same list, plus **billing coverage**: which of
  the eighteen paid price points can actually be charged, on which rail,
  in which mode.

**Both are empty when this runbook is finished.** That, and not this
file, is the real exit criterion.

---

## Production is a separate app

`fly.toml` is the app that has been deployed to since before Phase 0. It
carries a Clerk development key compiled into its bundle, Razorpay test
keys, credentials for features Phase 1 deleted, and a seeded test
merchant. It is a good place to break things and a bad place to put a
paying customer.

**`fly.prod.toml` is production** — `fly deploy -c fly.prod.toml`.

A separate app rather than upgrading that one in place, for a reason
that is not tidiness: **Clerk users do not migrate between instances.**
Block B means every account on the old app signs up again regardless,
so there is nothing to preserve by converting it — and a clean app costs
one `fly launch` to avoid inheriting five days of ad-hoc deploys and a
test merchant.

Two deliberate differences from staging, both explained in the file:

- **`ams`, on cost.** Fly has no Indian region (`bom` is gone), so
  serving India meant Singapore — the most expensive region Fly sells:
  $9.20/mo per 1GB machine against $5.70, and double the egress. Roughly
  60% more for roughly 60ms less. A good trade once page-load latency in
  India is something you can measure the cost of, and a bad one before
  there is a customer to lose. One line and a database move when that
  changes.
- **Two machines, not one.** A rolling deploy across two is
  zero-downtime where one cannot be. Safe for the background sweeps only
  because Phase 0's lease in `Jobs.record()` makes concurrent runs safe;
  before that it would have been a bug rather than redundancy.

Create it before starting block B:

```bash
fly apps create getbooqin-prod
fly postgres create --name getbooqin-prod-db --region ams
fly postgres attach getbooqin-prod-db --app getbooqin-prod
```

Every block below then applies to `getbooqin-prod`, with
`--app getbooqin-prod` on each command.

---

## The order matters

Items within a block are independent; the blocks are not.

```
A. Secrets hygiene        ──┐
B. Clerk production         ├── can all proceed in parallel
C. Domain                   │
D. Email authentication   ──┘
                              ↓
E. Billing go-live  (needs C — the return URL is on the real domain)
                              ↓
F. Legal identity   (must be answered before the first charge)
                              ↓
G. Monitoring, H. Backups, I. CI secrets
                              ↓
J. The verification pass — the actual gate

K. WhatsApp — start this on day one and let it run alongside everything
   above. Meta Business Verification plus App Review is the longest lead
   time here by a wide margin, and none of it can be hurried.
```

---

## A. Secrets hygiene — 20 minutes

### A1. Roll the Razorpay key that was in git

`rzp-test-key.csv` held a `key_id` and `key_secret` in the repo root and
was tracked. Test mode, so no money was ever at risk — but it is a real
credential, and **it is still in git history**, so deleting the file is
not the fix.

1. Razorpay Dashboard → **Settings → API Keys** → regenerate the **test**
   key.
2. Update wherever it is used locally (`core/.env`, `cloud/.env`).
3. If you ever pasted the live key into a file of the same shape, roll
   that one too.

`.gitignore` now refuses the shape rather than the filename — `*-key`,
`*-key.csv`, `*-key.txt`, `*secret*.csv`, `*credentials*.json`.

### A2. Audit what else is in history

```bash
git log --all --diff-filter=A --name-only --format="" | sort -u \
  | grep -Ei 'key|secret|credential|\.env$|\.pem$'
```

Anything that comes back is a credential to roll, not a file to delete.

---

## B. Clerk — move off the development instance — 1 hour + DNS

[fly.toml](../fly.toml) pins `pk_test_ZW5vdWdoLW1hbW1vdGgtNTQ5NC4…` — a
Clerk **development** instance. It has been serving production since
before Phase 0.

What that costs, none of which announces itself: a capped user count,
relaxed session security, **shared unbranded OAuth consent screens**
(your client's staff see Clerk's name, not yours, when they sign in with
Google), and email delivery that does not match production.

1. Clerk Dashboard → **create a production instance** for the app.
2. Add your own OAuth credentials for each social provider you enable —
   this is the step that removes the shared consent screen, and it is the
   one people skip.
3. Add the DNS records Clerk asks for (`clerk`, `accounts`, and two
   `clk._domainkey` entries, on the domain from block C).
4. Set the secret and rebuild with the publishable key:

   ```bash
   fly secrets set CLERK_SECRET_KEY=sk_live_…
   ```

   Then edit `[build.args] VITE_CLERK_PUBLISHABLE_KEY` in
   [fly.toml](../fly.toml) to the `pk_live_` key and deploy. **It is a
   build arg, not a secret** — Vite compiles it into the client bundle,
   so `fly secrets set` will not change it.

5. Users do not migrate between Clerk instances. Any account you created
   while testing has to sign up again. Do this **before** a real client,
   not after.

> Verify: the boot log stops printing `Clerk is a development instance`,
> and a Google sign-in shows your domain on the consent screen.

---

## C. Domain — `app.getbooqin.com` — 30 minutes + propagation

Today every booking link, every "manage your booking" link and every
invoice link is built from `APP_URL`, which is `https://getbooqin.fly.dev`.
Mail goes out from `getbooqin.com`. A customer receives a message from
one domain containing a link to another — bad for trust, and bad for the
DMARC story block D is about to fix.

```bash
fly certs add app.getbooqin.com
fly certs show app.getbooqin.com     # prints the exact DNS records
```

At Hostinger DNS, add what it prints (a `CNAME` to
`getbooqin.fly.dev`, plus the `_acme-challenge` record). Then wait for
the certificate to read **Ready** — and only then cut over:

```bash
fly secrets set APP_URL=https://app.getbooqin.com
```

**Order matters here.** Setting `APP_URL` before the certificate issues
means every email sent in between carries a link to a host that does not
resolve — strictly worse than the fly.dev link it replaces.

Once it is live, update `[env] APP_URL` in [fly.toml](../fly.toml) too,
so the next deploy does not quietly revert it.

### What deliberately does *not* change

`SHOPIFY_APP_URL` stays on `getbooqin.fly.dev`. It has to match what is
registered in the Shopify Partner dashboard and in
`shopify.app.production.toml`, and changing it means a Partner dashboard
edit plus `shopify app deploy`. Shopify is shipped dark (no plan grants
it), the fly.dev hostname keeps serving, and OAuth keeps working — so
this is not worth touching until a Shopify merchant is actually in front
of you.

> Verify: `curl -sI https://app.getbooqin.com/healthz` returns 200, and a
> test booking's confirmation email contains an `app.getbooqin.com` link.

---

## D. Email authentication — finish what Phase 0 started — 15 min + propagation

**This is unfinished from Phase 0 and it is the highest-consequence item
in this document.** Every customer-facing thing the product does is an
email: confirmations, reminders, cancellations, invoices, trial nudges.
If they land in spam, nothing else here matters.

[Phase 0's §2](phase-0-runbook.md) has the full detail and the current
state. The short version of what is still open:

| | |
|---|---|
| Brevo SMTP relay | done |
| `brevo-code` ownership TXT | published |
| DMARC (`p=none`) | published |
| **DKIM** (`mail._domainkey`) | **missing** |
| **SPF includes Brevo** | **missing** — only Hostinger today |
| `MAIL_FROM_EMAIL` | Brevo's SMTP *login*, not a mailbox you own |

1. Brevo → **Senders, Domains & Dedicated IPs → Domains → getbooqin.com
   → finish authentication**. It gives you a DKIM record.
2. At Hostinger DNS, add the DKIM record and **merge** Brevo into the
   existing SPF record. Two SPF records on one domain is a `permerror`
   that fails every check — edit the record you have:

   ```
   mail._domainkey   TXT   k=rsa; p=<from Brevo>
   @                 TXT   v=spf1 include:_spf.mail.hostinger.com include:spf.brevo.com ~all
   ```

3. Create `notify@getbooqin.com` as a real mailbox (replies reach the
   merchant via `Reply-To`, but bounces need somewhere to land), then:

   ```bash
   fly secrets set MAIL_FROM_EMAIL=notify@getbooqin.com MAIL_FROM_NAME=GetBooqin
   ```

4. **Verify alignment, not arrival.** Send yourself a test booking, open
   it in Gmail, **Show original**, and confirm `DKIM: PASS` with
   `d=getbooqin.com` and `DMARC: PASS`.

### Two things about Brevo before a client depends on it

- **The free tier caps at 300 emails/day.** A booking product sending
  confirmations *and* reminders reaches that faster than it looks, and
  hitting the cap means silently dropped confirmations — exactly the
  failure this block exists to prevent. Check which plan you are on.
- Free-tier sending is on **shared IPs**, so your sender reputation is
  partly other people's.

---

## E. Billing go-live — the long one

### Where it actually stands

`/admin` prints this now, but so you know what to expect: of the
**eighteen** paid price points, **three** can be charged today.

| Currency | Rail | State |
|---|---|---|
| INR | Razorpay | Starter monthly ✅, Starter yearly ✅, Growth monthly ✅ |
| INR | Razorpay | **Growth yearly ❌** — see E2 |
| USD | PayPal | **Nothing ❌** — no plan has ever been created |
| EUR | PayPal | **Nothing ❌** — no plan has ever been created |

`business` is `visible: false` and not sold, so its missing ids do not
block anything.

### E1. Razorpay live credentials

```bash
fly secrets set RAZORPAY_KEY_ID=rzp_live_… RAZORPAY_KEY_SECRET=…
```

Mode is derived from the key's own prefix, so there is no separate
variable to forget and nothing that can drift out of step with the keys.
Setting a live key switches the whole rail to the `live` column of
`PRICES` — which is why E2 has to be done first or at the same time.

### E2. Create the missing Razorpay Growth Yearly plan

There is a specific, already-diagnosed reason this slot is empty. The
first live "GetBooqin Growth Yearly" (`plan_TbDSgwJW8j7O0t`) was created
with **`period=monthly`** — it would have billed ₹7,990 *every month*.
Razorpay plans are immutable, so it cannot be corrected, only replaced.

1. Razorpay Dashboard → **Subscriptions → Plans → Create Plan**
   - Billing frequency: **Yearly**, every **1** year
   - Amount: **₹7,990**
   - Name something that cannot be confused with the broken one
2. **Read it back before trusting it.** This is the failure mode that
   produced the empty slot in the first place:

   ```bash
   curl -u "$RAZORPAY_KEY_ID:$RAZORPAY_KEY_SECRET" \
     https://api.razorpay.com/v1/plans/plan_XXXX
   ```

   Confirm `"period": "yearly"`, `"interval": 1`, `"amount": 799000`.
3. Paste the id into `growth.INR.yearly.razorpay.live` in
   [core/src/billing/plans.ts](../core/src/billing/plans.ts) and delete
   the comment above it explaining why it was empty.

### E3. PayPal — account, plans, webhook

Nothing outside India can pay until this is done.

1. **PayPal Business account**, then Developer Dashboard → **Apps &
   Credentials** → create an app. Do **sandbox first**.
2. Create the plans with the script, which is idempotent by name and
   prints ids to paste:

   ```bash
   PAYPAL_ENV=sandbox PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… \
     npx tsx core/scripts_create_paypal_plans.ts
   ```

   Eight ids for the visible ladder: Starter and Growth × monthly and
   yearly × USD and EUR. Paste them into `paypal.test` in `plans.ts`.
3. **Read them back** before deploying — the same lesson E2 is made of:

   ```bash
   PAYPAL_ENV=sandbox … npx tsx core/scripts_create_paypal_plans.ts --verify
   ```

4. Register the webhook at PayPal → your app → **Webhooks**:
   - URL: `https://app.getbooqin.com/webhooks/paypal`
   - Events: `BILLING.SUBSCRIPTION.ACTIVATED`, `.CANCELLED`, `.SUSPENDED`,
     `.EXPIRED`, `.UPDATED`, `PAYMENT.SALE.COMPLETED`,
     `BILLING.SUBSCRIPTION.PAYMENT.FAILED`
   - Copy the **webhook id** (not a secret — PayPal verifies by API call):

     ```bash
     fly secrets set PAYPAL_WEBHOOK_ID=…
     ```

5. Exercise the whole loop in sandbox — **including the failure paths** —
   then repeat steps 1–4 with live credentials, paste into `paypal.live`,
   and:

   ```bash
   fly secrets set PAYPAL_ENV=live PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… PAYPAL_WEBHOOK_ID=…
   ```

### E4. Razorpay webhook

Razorpay Dashboard → **Settings → Webhooks**:

- URL: `https://app.getbooqin.com/webhooks/razorpay`
- Events: `subscription.activated`, `.charged`, `.pending`, `.halted`,
  `.cancelled`, `.completed`, `payment.failed`
- Set a secret, then `fly secrets set RAZORPAY_WEBHOOK_SECRET=…`

Without this secret, renewals and failures are never recorded — money
moves and nothing in the product knows. It is a `capability` var
precisely so the boot log says so.

### E5. What to actually test, in both sandboxes

The subscription table is written by **exactly one** code path — the
webhook handler. Checkout success pages never write it. So every one of
these has to be triggered for real, and the happy path is the least
interesting:

- [ ] Upgrade completes → webhook lands → plan changes in `/admin`
- [ ] Upgrade abandoned at the provider → **no** plan change
- [ ] Renewal succeeds → `BillingEvent` row, invoice issued and emailed
- [ ] **Payment fails** → dunning email, in-app banner, 7-day grace,
      entitlements *not* dropped on day one
- [ ] Cancel → runs to period end, then drops to Free
- [ ] **Duplicate webhook delivery** → applied once, not twice
- [ ] Webhook with a bad signature → rejected
- [ ] A payment whose webhook never arrived → `BillingReconcile` fixes it

---

## F. Invoice legal identity — decide before the first charge

Invoicing is off until these are set, and
[seller.ts](../core/src/billing/seller.ts) deliberately refuses to issue
an invoice carrying a placeholder GSTIN rather than print a weaker one.

```bash
fly secrets set \
  INVOICE_LEGAL_NAME="…" \
  INVOICE_ADDRESS="…" \
  INVOICE_GSTIN="…" \
  INVOICE_LUT_ON_FILE=false \
  INVOICE_SERIES_PREFIX=GB \
  INVOICE_GST_RATE=18
```

Four questions, and only you can answer them:

1. **Which entity is the seller?** The name that appears on every
   invoice and in the subscription terms.
2. **Is it GST-registered?** A blank `INVOICE_GSTIN` is legitimate below
   the registration threshold — but it must be blank *because that is
   true*, not because nobody filled it in.
3. **Is a Letter of Undertaking on file?** This decides whether export
   invoices go out under LUT without IGST (`true`) or with IGST payable
   (`false`). Getting it wrong is a tax problem, not a display bug.
4. **EU VAT**: the code implements B2B-only with VAT-number capture and
   reverse charge, which was gate **G2**'s cheapest correct answer. If
   you intend to sell to EU *consumers*, that is a different answer and
   it changes checkout.

`INVOICE_SERIES_PREFIX` must not change once an invoice has been issued
under it — the series is per financial year and has to stay continuous.

---

## G. Monitoring — 30 minutes

```bash
fly secrets set SENTRY_DSN=https://…@….ingest.sentry.io/…
```

Everything Sentry-related is inert without it. PII is stripped before
send — [server/instrument.js](../server/instrument.js)'s `beforeSend`
drops request bodies, headers, cookies and query strings, because
booking forms carry names, phone numbers and free-text notes that at a
clinic can be clinical.

Then point an uptime monitor (Better Stack, Uptime Robot) at:

```
https://app.getbooqin.com/healthz?strict=1     every 5 min, alert on non-2xx
```

**This one is load-bearing, not optional.** There is deliberately no
external scheduler — the reminder sweep runs on a ten-minute in-process
interval — so this is the *only* signal that originates outside the app
process. It returns 503 when the database is unreachable **or** when the
sweep has not succeeded in 30 minutes. Skip it and reminders are back to
failing silently, which is the exact defect Phase 0 existed to fix.

Note the `?strict=1`. Without it, `/healthz` reports liveness only, and
that plain variant is what Fly's own health check watches — a machine
with a dead background job is still serving bookings, and pulling it out
of rotation would turn a background problem into an outage.

Do **not** point an uptime check at `/cron/reminders`: it needs the
bearer token and an unauthenticated probe gets a 401 forever.

---

## H. Backups — restore one, or you do not have one

Fly Postgres takes daily volume snapshots. Confirming they *exist* is
the easy half and not the half that fails.

```bash
fly volumes snapshots list <volume-id>
fly postgres create --name getbooqin-restore-test --snapshot-id <snap>
```

Then connect to the restored database and check that a booking you know
about is in it. Destroy the scratch instance afterwards. **Do this
before a client's data is in there, not after.**

Note `min_machines_running = 1` in [fly.toml](../fly.toml): one machine,
and the reminder sweep runs inside it. Fine for a first client; it is
the reason block G's uptime check matters as much as it does.

---

## I. CI secrets — 5 minutes

The `a11y` and `e2e` jobs, and every authenticated suite, need these as
**repository secrets** (Settings → Secrets and variables → Actions):

| Secret | From |
|---|---|
| `CLERK_SECRET_KEY` | a Clerk **test** instance — never the live one |
| `VITE_CLERK_PUBLISHABLE_KEY` | the same test instance |
| `CONNECTION_ENCRYPTION_KEY` | any 32-byte value; CI's database is disposable |
| `SESSION_SIGNING_SECRET` | same |

Until these are set, those jobs cannot pass — which is why the a11y job
has never run green.

---

## J. The verification pass — this is the gate

Not a checklist of intentions. Each line is something you *observe*.

**The two reports are empty**

- [ ] Boot log prints no `NOT PRODUCTION-READY` lines
- [ ] `/admin` shows no readiness card and no billing-coverage card

**A stranger can become a customer**

- [ ] Sign up from `app.getbooqin.com` with an address you have never used
- [ ] Onboard to a live booking link in under five minutes
- [ ] Book from the public page as a customer
- [ ] The confirmation arrives in a **Gmail inbox**, not spam, with
      `DKIM: PASS d=getbooqin.com`, an `.ics` attached, and an
      `app.getbooqin.com` link
- [ ] The booking appears in the dashboard
- [ ] Cancel from the customer's own link; the cancellation email arrives
- [ ] Paste the embed snippet into a scratch HTML file and book through it
- [ ] Upgrade to a paid plan with a real card, in the live environment
- [ ] The invoice PDF downloads and carries the right legal identity
- [ ] The account shows as paying in `/admin`
- [ ] Cancel the subscription; it runs to period end

**It fails safely**

- [ ] `npm run smoke` green against `app.getbooqin.com`
- [ ] Deliberately break something trivial and confirm Sentry pages you
- [ ] Stop the reminder sweep and confirm `/healthz?strict=1` goes red
      within 30 minutes

---

## K. WhatsApp — Meta Business Verification and Tech Provider access

**Start this early.** It is the longest lead time in this document by a
wide margin: Business Verification alone is typically days, App Review
can be a week or more, and neither can be hurried. The code is written
and inert until all of it is done.

**The arrangement to keep in mind throughout:** the merchant connects
*their own* WhatsApp Business Account and attaches *their own* payment
method inside Meta's popup. Meta bills them. You carry no per-message
cost — which is the only reason this is a plan feature rather than a
metered add-on, and it is worth saying to Meta in your use-case
description too, because it is exactly what a Tech Provider is.

### K1. Meta app and Business Verification

1. **developers.facebook.com** → create an app of type **Business**, and
   add the **WhatsApp** product to it.
2. Attach it to your Meta Business account, then complete **Business
   Verification** (Business Settings → Security Centre). You will need
   the registered entity's documents — the same entity as block F's
   invoice identity, and the mismatch is worth avoiding.
3. Request **Advanced Access** for `whatsapp_business_management` and
   `whatsapp_business_messaging`. Both are App Review, and the review
   asks for a screencast of the flow.

### K2. Embedded Signup configuration

Under the WhatsApp product → **Embedded Signup** → create a
configuration. It gives you a **config id**, which is not a secret and
is compiled into the page the merchant clicks.

Your app must be registered as a **Tech Provider** for Embedded Signup
to be offered at all. Without it, `FB.login` opens and the merchant
simply cannot get through.

**Then two settings that have nothing to do with WhatsApp and block it
completely.** Under **Facebook Login for Business → Settings**:

1. **Login with the JavaScript SDK → Yes.** Off by default. With it off
   the popup opens and immediately says "JSSDK Option is Not Toggled".
2. **Allowed Domains for the JavaScript SDK** → add the origin the
   dashboard is served from, exactly, including scheme:

   ```
   https://getbooqin.fly.dev
   https://app.getbooqin.com     ← add when block C lands; keep both
   http://localhost:3100         ← only if you run the flow locally
   ```

   This is the one people miss. Flipping the toggle alone gets you past
   the first dialog and into a second, quieter failure, because the SDK
   then checks the calling origin against a list that is still empty.

### K3. Secrets

```bash
fly secrets set \
  META_APP_ID=... \
  META_APP_SECRET=... \
  META_WHATSAPP_CONFIG_ID=... \
  META_WEBHOOK_VERIFY_TOKEN=$(openssl rand -hex 24)
```

`META_APP_ID` and `META_WHATSAPP_CONFIG_ID` are publishable — they ship
in the client bundle by design, like the Clerk publishable key.
`META_APP_SECRET` never leaves the server: it signs nothing outbound,
but it is what verifies **every** inbound webhook.

`META_WEBHOOK_VERIFY_TOKEN` is a value you invent. It is only used once,
to answer Meta's verification GET.

### K4. Webhook

Meta app dashboard → WhatsApp → **Configuration** → Webhook:

- Callback URL: `https://app.getbooqin.com/webhooks/meta`
- Verify token: the `META_WEBHOOK_VERIFY_TOKEN` you just set
- Subscribe to fields: **`messages`**, **`message_template_status_update`**,
  and — required for coexistence — **`history`**,
  **`smb_app_state_sync`** and **`smb_message_echoes`**

Saving it triggers the verification GET, which the route answers with
the challenge as plain text. If it fails, the token does not match —
that is the only thing that check can be wrong about.

All five matter, for different reasons. `messages` carries delivery
receipts and customer replies. `message_template_status_update` is how a
merchant's template approval ever reaches the Settings screen —
subscribe to only the first and every merchant sits on "In review"
forever. The three `history` / `smb_*` fields are Meta's requirement for
running coexistence at all; the code names and ignores them today (see
`whatsapp/webhook.ts`), and `smb_message_echoes` is the one worth
building on first, since it is what would let a booking's timeline show
that the merchant replied from their own app.

### K4a. Coexistence — the merchant keeps their WhatsApp Business app

**This is the difference between a feature merchants adopt and one they
refuse.** A salon or clinic lives in the WhatsApp Business app; it is
how they talk to customers all day.

Meta decides which path applies from what the number already is, and
tells us afterwards through the session event — so there is nothing to
configure per merchant and nothing for them to choose wrongly:

| Meta's event | Path | What happens to the app |
|---|---|---|
| `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` | coexistence | **Kept.** They chat from the app, we send the automation, history syncs |
| `FINISH` / `FINISH_ONLY_WABA` | classic | Number moves to the Cloud API; the app is signed out for it |

The code reads the event and branches, and the consequence is one line:
a coexistence number is **already registered**, so `/register` is
skipped. Calling it is precisely what would take the app away.

What a merchant on coexistence gives up, which the Connect card states
before the popup rather than after:

- Disappearing messages, view-once, live location and broadcast lists
  switch off in their 1:1 chats
- Linked devices (WhatsApp Web, desktop, tablets) unlink and need
  re-linking
- Fixed 20 messages/second ceiling — irrelevant at booking volumes
- History sync has a **24-hour window** after onboarding, or the flow
  has to be repeated
- Messages they send from the app stay free; ours are charged at Cloud
  API rates

### K5. What to test, in this order

- [ ] A number **already on the WhatsApp Business app** connects, lands
      `active` as `coexistence`, and **the app still works** — this is
      the test that matters most, and the one to run first
- [ ] A number **not** on the app connects as `classic` and registers
- [ ] A test merchant completes Embedded Signup and lands `active`
- [ ] Five templates appear as **In review**, then **Ready** — this is
      where you find out whether Meta likes the copy
- [ ] A booking with the opt-in box ticked produces a WhatsApp message
- [ ] The same booking with the box **unticked** produces none
- [ ] `WhatsAppMessage.status` reaches `delivered`, then `read`
- [ ] A number with no WhatsApp fails as `not_on_whatsapp` and the
      email still arrives
- [ ] Remove the app from the merchant's Meta account → the next send
      marks the account `revoked` and Settings offers Reconnect
- [ ] A merchant on Free cannot connect, and a connected merchant who
      **lapses** to Free stops sending

### K6. Things that will bite

- **Rejected templates.** Meta rejects UTILITY templates that read as
  marketing. The copy in `whatsapp/templates.ts` is written to avoid
  that — no offers, no encouragement, nothing the customer did not ask
  for. Changing it is changing a submission.
- **A number already signed in to the WhatsApp Business app** cannot be
  registered for the Cloud API until it is signed out there — which is
  why coexistence exists and why the code never registers a coexistence
  number. If you see a registration error mentioning this, the mode was
  detected wrongly; check which session event came back.
- **Quality rating.** Failed sends and customer blocks push a number
  toward RED, and a RED number stops sending. That is why
  `toWhatsAppNumber()` refuses a malformed number locally instead of
  letting Meta count it as a failure.
- **Meta deprecates Graph API versions on a schedule.** `GRAPH_VERSION`
  in `whatsapp/graph.ts` is one constant, overridable with
  `META_GRAPH_VERSION`, and it will need bumping roughly annually.

---

## First-client onboarding

Once J is green:

1. **Create their account yourself, or watch them do it.** The first one
   is research, not support.
2. **Set their plan from `/admin`** rather than asking for a card on day
   one — a plan override never touches the payment provider and is the
   mechanism to reach for 95% of the time. `reason` is required and ends
   up in the audit log, which is what lets you answer "why is this
   account free?" six months from now.
3. **If they are on Shopify**, grant the `shopify` entitlement per
   account. No plan grants it; it is shipped dark on purpose.
4. **Tell them the truth about payments.** Settings → Payments collects
   over UPI or PayPal.me directly to *them*. GetBooqin is not in that
   transaction, and **a payment is marked paid by a person, not
   verified** — the UTR a customer quotes is evidence to match against a
   bank statement, not proof. Every screen says so; make sure they have
   heard it from you too.
5. **Watch `/admin`** for the first week. It carries the job health, the
   trial countdown and the readiness reports.

---

## Known and accepted for a first client

Not oversights — decisions, listed so they are not rediscovered as
surprises.

- **One machine.** `min_machines_running = 1`, reminders on an
  in-process interval. Block G's uptime check is the mitigation.
- **No merchant-facing SLA, no status page.**
- **Shopify dark.** Its embedded admin is one screen that links into the
  cloud dashboard. Gate **G3** — whether an App Store listing is in
  scope — is still open.
- **`business` tier hidden.** Enable it from `/admin` for the first
  person who asks for unlimited or multi-location, and learn what it
  should contain from them.
- **No mid-cycle proration.** Plan changes take effect next billing date.
- **No Google Calendar sync.** The right first thing *after* launch.
- **Manual deploys from a laptop.** Which is why `smoke.yml` is
  `workflow_dispatch` plus an hourly backstop rather than triggered by a
  push.
