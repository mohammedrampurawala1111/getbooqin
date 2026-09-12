# Phase 0 runbook — make what exists actually work

Phase 0 of [the MVP trim plan](mvp-trim-plan.md): the only phase that
fixes rather than builds. Its exit criterion, verbatim from the plan:

> a booking made on the live site sends a confirmation that lands in a
> real inbox; a reminder fires the next morning; two simultaneous requests
> for one slot produce exactly one booking and one clean 409; an exception
> pages you.

The code for all five items is merged. **Four of them are not finished
until someone does the operational half below** — a DNS record, a Sentry
project, an uptime check, a restored backup. Code that is inert without a
secret is not monitoring, and a `From` header pointed at a domain with no
SPF record is not deliverability.

---

## What changed in the code

| Item | What shipped | Where |
|---|---|---|
| **B1** Reminder observability | Shared `Jobs.runReminders()` behind a claim/lease + run record; `/healthz?strict=1` for external alerting | [core/src/jobs.ts](../core/src/jobs.ts), [healthz.tsx](../shopify-openslot/app/routes/healthz.tsx) |
| **B2** Double-booking race | Per-shop advisory lock + re-check inside the insert's transaction, and two `EXCLUDE USING gist` constraints as the database backstop | [core/src/booking/slotLock.ts](../core/src/booking/slotLock.ts), [migration](../core/prisma/migrations/20260912090000_booking_overlap_exclusion/migration.sql) |
| **B3** Email deliverability | `From: "Business via GetBooqin" <MAIL_FROM_EMAIL>` + `Reply-To: merchant`, header-injection-safe. Brevo relay already in place; domain authentication half-finished — see below | [mailer.ts `fromHeaders()`](../core/src/booking/mailer.ts) |
| **B4** Monitoring | Sentry in the server process and both apps' `handleError`, inert without `SENTRY_DSN`; `/healthz` for uptime | [server/instrument.js](../server/instrument.js) |
| **5** Backups | Nothing to write — see the procedure below | — |
| *(deploy safety)* | Migrations moved from the Docker `CMD` to a `release_command`; a liveness health check added | [fly.toml](../fly.toml), [Dockerfile](../Dockerfile) |

### A correction to the plan's B1

The plan states that nothing schedules the reminder cron and that
**"reminders do not fire in production today."** That is not the case.
[server/combined.js](../server/combined.js) — the production entrypoint —
has always run the sweep on a 10-minute in-process interval. The audit
saw `fly.toml`, `ci.yml` and `/cron/reminders`, and missed
`startReminderScheduler()`.

The three defects it *did* leave are real, and are what B1 actually
fixed:

1. **Nothing recorded that a sweep happened.** A working sweep and a dead
   one look identical from outside, because most hours have nothing to
   send. If the interval had died with a process restart, nobody would
   have found out until a customer missed an appointment.
2. **Two sweeps could run at once and send the same reminder twice.**
   `sendReminders()` only flips `reminderSent` *after* a successful send.
   This needs two app machines (`min_machines_running` is 1, so it hasn't
   bitten) — it is guaranteed the moment this scales past one.
3. **The two triggers did different work.** The route also ran
   `ChatFlow.cleanup()`; the interval didn't.

Both triggers now call one function, every run is recorded, and a lease
makes them safe to run together. The external hourly schedule is still
worth having: it's the only check that runs *outside* the app process, so
it catches a wedged app as well as a dead timer.

---

## Operational steps — the half that isn't code

### 1. Reminder scheduling — nothing to do, by decision

**There is deliberately no external scheduler.** Deploys are run from
local and no GitHub Actions automation is in play, so the only thing that
fires the reminder sweep is the 10-minute in-process interval in
[server/combined.js](../server/combined.js) — which has always been
there, and which is what B1's audit missed.

That is a supportable position, but only because of what Phase 0 added
around it. An external cron's real value was never the redundant
invocation; it was being the one signal that originates *outside* the app
process, so a dead timer or a wedged app can't hide. `/healthz?strict=1`
provides that signal directly to any uptime monitor, with no scheduler
and no shared secret — if the sweep stops advancing its `JobRun` row, the
check goes red. **That makes step 3's uptime monitor the load-bearing
part of B1, not an optional extra.** Skip it and reminders are back to
failing silently.

`/cron/reminders` stays for manual runs and for whatever scheduler gets
pointed at it later. Adding one back needs no code change — the lease in
`Jobs.record()` already makes two triggers safe to run together. Set
`CRON_SECRET` if and when you want to use the route; nothing depends on
it today.

To trigger a sweep by hand:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
     https://getbooqin.fly.dev/cron/reminders
```

`"skipped": true` means another sweep held the lease — healthy, not an
error.

### 2. Email: finish authenticating your own domain (B3) — 15 min + propagation

**Most of this already exists.** Brevo's SMTP relay is wired up and
deployed, you own `getbooqin.com`, and Brevo's ownership code and a DMARC
record are already published. Two records and two secrets are missing.

#### A correction to the plan's B3

The plan states the mailer sends as `"Business Name" <merchant's own
address>` over our relay. It doesn't, and hasn't: `MAIL_FROM_EMAIL` has
been set in production all along, so mail has been going out from
Brevo's address. The three defects that *were* real, and that the code
change fixes:

- **No `Reply-To`.** A customer hitting reply reached a Brevo SMTP login
  with no mailbox behind it.
- **No "via" disclosure.** The display name said the merchant's business
  while the envelope said `smtp-brevo.com`. A From whose display name
  and domain disagree is itself a phishing signal.
- **Sending from a domain you don't control.** `smtp-brevo.com` can't be
  given SPF/DKIM/DMARC records by you, so there was nothing to align
  against. This is the half that is still open.

#### Current state

| | |
|---|---|
| Brevo SMTP relay | done, deployed |
| `brevo-code` ownership TXT on `getbooqin.com` | published |
| DMARC (`p=none`, rua → Brevo) | published |
| **DKIM** (`mail._domainkey`) | **missing** |
| **SPF includes Brevo** | only `_spf.mail.hostinger.com` |
| `MAIL_FROM_EMAIL` | `b675ff001@smtp-brevo.com` — Brevo's SMTP *login*, not a mailbox you own |
| `MAIL_FROM_NAME` | `"OpenSlot"` — stale brand, and now customer-visible as "… via OpenSlot" |

#### What to do

1. **Brevo → Senders, Domains & Dedicated IPs → Domains → `getbooqin.com`
   → finish authentication.** It gives you a DKIM record.

2. **At Hostinger DNS**, add the DKIM record and *merge* Brevo into the
   existing SPF record. Two SPF records on one domain is a `permerror`
   that fails every check — edit the record you have, don't add a second:

   ```
   mail._domainkey   TXT   k=rsa; p=<from Brevo>

   @                 TXT   v=spf1 include:_spf.mail.hostinger.com include:spf.brevo.com ~all
   ```

3. **Point the sender at your own domain:**

   ```bash
   fly secrets set MAIL_FROM_EMAIL=notify@getbooqin.com MAIL_FROM_NAME=GetBooqin
   ```

   Your Hostinger MX is already live, so create `notify@getbooqin.com` as
   a real mailbox or alias while you are in there. Replies reach the
   merchant via `Reply-To`, but bounces need somewhere to land.

4. **Verify alignment, not just arrival.** Book to a Gmail address, open
   the message, **Show original**, and confirm `DKIM: PASS` with
   `d=getbooqin.com` and `DMARC: PASS`. DKIM alignment is what carries
   DMARC here — SPF will align on Brevo's own return-path rather than
   yours, which is normal for a shared relay and not a problem.

5. Once DMARC reports are clean for a couple of weeks, move `p=none` to
   `p=quarantine`.

#### Two things to know about Brevo specifically

- **The free tier caps at 300 emails/day.** A booking product sending
  confirmations *and* reminders reaches that faster than it looks. Check
  which plan you're on before launch — hitting the cap means silently
  dropped confirmations, which is the same customer-facing failure this
  whole item exists to prevent.
- **Free-tier sending is on shared IPs**, so your sender reputation is
  partly other people's. A dedicated IP is worth revisiting if inbox
  placement turns out to be a problem after step 4 passes.

**Until `MAIL_FROM_EMAIL` points at an authenticated domain you own, mail
still goes out unaligned.** It is no longer the merchant-spoofing shape
it was, but `smtp-brevo.com` is not a domain you can authenticate, so
there is nothing for a receiver to verify you against.

### 3. Sentry project + uptime checks (B4) — 30 minutes

```
fly secrets set SENTRY_DSN=https://…@…ingest.sentry.io/…
```

That's all the code needs. Everything Sentry-related is inert without it.
PII is stripped before send (`beforeSend` in
[server/instrument.js](../server/instrument.js) drops request bodies,
headers, cookies and query strings) — booking forms carry names, phone
numbers and free-text notes, which at a clinic can be clinical.

Then point an uptime service (Better Stack, Uptime Robot) at:

- `https://getbooqin.fly.dev/healthz?strict=1` — **every 5 minutes, alert
  on non-2xx.** This is the one that matters, and with no external
  scheduler it is the *only* out-of-process signal that reminders are
  still going out. It returns 503 when the database is unreachable or
  when the sweep hasn't succeeded for 30 minutes (a 10-minute interval
  plus a 20-minute grace for deploys and one failed tick). No auth
  needed; it exposes only timestamps and counts.

**Note the `?strict=1`.** Without it, `/healthz` reports liveness only —
503 solely when the database is unreachable. That plain variant is what
Fly's own `http_service.check` watches, and it deliberately ignores a
stale cron: a machine with a dead background job is still serving
bookings perfectly well, and failing its health check would pull it out
of rotation (or roll back a deploy) over something that isn't an outage.
An external monitor wants the opposite answer, because a page is exactly
the right response to reminders having stopped. Same body, different
status code, two different callers.

Don't point an uptime check at `/cron/reminders`: it needs the bearer
token, and an unauthenticated probe gets a 401 forever.

### 4. Backups — restore one, or you don't have one (item 5)

Fly Postgres takes daily volume snapshots by default. Confirming they
*exist* is the easy half and not the half that fails.

```bash
# 1. Confirm snapshots exist and how old the newest is
fly volumes list -a openslot-shelfscore-db
fly volumes snapshots list <volume-id>

# 2. Create a scratch cluster from the most recent snapshot
fly postgres create --name getbooqin-restore-test --snapshot-id <snapshot-id>

# 3. Actually look at the data — this is the step people skip
fly proxy 5433:5432 -a getbooqin-restore-test
psql "postgres://postgres:<pw>@localhost:5433/getbooqin_core" -c \
  'SELECT count(*) FROM "Booking"; SELECT max("createdAt") FROM "Booking";'

# 4. Tear it down
fly apps destroy getbooqin-restore-test
```

Check the row counts and newest timestamp against production. What you're
looking for is an unpleasant surprise: an empty database, a schema from
three migrations ago, or a "daily" snapshot that's a month old. Write the
snapshot's age down — that number is your real RPO, and it is what you'd
be telling a customer.

**Observed 2026-09-12:** snapshots exist and are daily on volume
`vol_v3g28yz6yeelpmm4` (app `getbooqin-db`, *not* the
`openslot-shelfscore-db` still named in `shopify-openslot/.env.example`).
Newest was 20 hours old. Two things to weigh:

- **Retention is 5 days.** That is your entire recovery window — a
  problem noticed on day six is unrecoverable. Fly's default; raise it
  with `fly volumes snapshots --help` if five days feels thin for a
  product about to hold customer bookings.
- **Stored sizes drop sharply across the week** (126 MiB → 14 → 11 → 12
  → 2.8 MiB). Probably just delta encoding, but worth a look when you do
  the restore — a shrinking database is the other explanation.

The restore half is still outstanding. Re-run this quarterly; put it in
a calendar, nobody remembers otherwise.

### 5. Before deploying: check for existing overlaps (B2)

The exclusion constraints cannot be added over data that already violates
them, so the migration refuses rather than applying half. Check
production first:

```bash
DATABASE_URL=<production> npx tsx core/scripts_find_overlapping_bookings.ts
```

Exit 0 means clean and you can deploy. Exit 1 prints each offending pair
with both bookings' times, statuses and creation timestamps — cancel or
reschedule one side of each (usually the later `createdAt`) and run it
again. Finding nothing is the expected outcome; the race needed two
customers on one slot within the same few milliseconds.

---

## Found while rolling this out

Three things the plan didn't know about, in rough order of how much they
matter. None are Phase 0 items; all of them affect it.

Scope note: this repo's `fly.toml` deploys the **`getbooqin`** app, and
that is the only deploy target these notes concern.

### `getbooqin` runs on a Clerk *development* instance — launch blocker

The deployed client bundle is compiled with a `pk_test_` publishable
key, and has been since before Phase 0. A Clerk development instance has
a capped user count, relaxed security, shared unbranded OAuth consent
screens, and email delivery that doesn't match production. That is not
something to discover after the first paying customer signs up.

It needs a `pk_live_` key from a production Clerk instance with your own
domain and OAuth credentials, swapped together with `CLERK_SECRET_KEY`
(never one without the other). Phase 5's launch-readiness work at the
latest; sooner if strangers can already reach signup.

The key was previously passed only as a `--build-arg` on the deploy
command line, so any `fly deploy` that forgot the flag silently shipped
an *empty* key and broke login with no build error. It is now pinned in
`fly.toml` under `[build.args]`, with the warning above next to it.

### Two app machines were running, so B1's duplicate-reminder race was live

The plan's B1 notes said this "needs two app machines
(`min_machines_running` is 1, so it hasn't bitten)". `fly status` shows
**two** started machines in `ams`. Both ran the 10-minute in-process
sweep, so any reminder whose tick had both sweeps read
`reminderSent: false` before either flipped it went out twice. The lease
in `Jobs.record()` is what stops that, and it was more overdue than the
plan implied.

### Migrations ran from the Docker `CMD`, with no health check anywhere

Safe only while migrations couldn't fail. B2's exclusion constraints can
legitimately refuse to apply, and a failed migration in the `CMD` just
crash-loops the machine — with no `[[http_service.checks]]` configured,
Fly had no signal to stop the rollout and would have taken both machines
down. Migrations now run as a `release_command` (once, before any
machine is replaced, aborting the deploy on failure with the old version
still serving) and `/healthz` is wired as a liveness check.

---

## Verifying the exit criterion

| Criterion | How to check |
|---|---|
| A confirmation lands in a real inbox | Book on the live site with a Gmail address; **Show original**; `DKIM: PASS` with `d=getbooqin.com`, and `DMARC: PASS` |
| A reminder fires the next morning | `curl https://getbooqin.fly.dev/healthz` — `jobs[0].stale` is `false` and `last_success_at` is within minutes (the in-process sweep runs every 10) |
| Two simultaneous requests give one booking and one clean 409 | `npm test --workspace=core` — [doubleBooking.test.ts](../core/src/booking/__tests__/doubleBooking.test.ts) races 2, 5 and overlapping-but-different-start requests against real Postgres |
| An exception pages you | Sentry → Issues shows the test event; the uptime check alerts on a 503 |

---

## What Phase 0 deliberately left alone

- **Google Calendar sync, SMS reminders, deposits** — §4.5 of the plan.
- **The `.ics` attachment** (§4.2 #1, the highest value-per-hour item on
  the whole list) — it's an addition, not a fix, so it belongs with the
  Phase 2 lifecycle-email work rather than here.
- **Buffer overlaps at the database level.** The exclusion constraints
  cover a booking's own start/end, not the service's before/after
  buffers. Buffers are per-service policy that can be edited after the
  fact, so baking them into a stored constraint would retroactively
  invalidate rows that were legal when written. Buffer conflicts stay the
  application check's job — now re-run under the shop lock, so the race
  is closed there too.
- **Sentry in the browser.** Server-side coverage (`handleError` in both
  apps plus the Express handler) is where booking failures actually
  surface. Client-side `@sentry/react` is worth revisiting once there's
  traffic to justify the bundle cost.
