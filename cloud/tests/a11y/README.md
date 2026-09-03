# Axe-core smoke suite

UX audit pass 11's #9 finding: form-label and contrast regressions had been
introduced and re-fixed three times across this audit series, and the only
version of a fix that survives a branch mix-up is one that fails the build.

## Running locally

```
cd cloud
npm run dev              # separate terminal, or let the config start it for you
A11Y_BOOKING_ID=<a connection id with at least one active service> npm run test:a11y
```

`A11Y_BOOKING_ID` defaults to a connection seeded by `core/scripts_seed_local.ts`
(`npx tsx scripts_seed_local.ts` from `core/`, against your local Postgres —
prints the connection id it created). Without it, the `/book/:connectionId`
case is skipped rather than failing on a 404 for a connection that doesn't
exist in whatever database CI is pointed at.

## What's covered

Unauthenticated routes only — no Clerk session, no seeded dashboard data
beyond one Connection + Service row:

- `/` (marketing home)
- `/login`, `/signup`, `/forgot-password`
- `/legal/privacy`, `/legal/terms`, `/support`
- `/book/:connectionId` — the public booking page's first ("Choose a
  service") step

## What's NOT covered yet

The prompt also asked for axe scans of the Consultations list, a booking
detail page, and two Settings panes — all authenticated, dashboard-only
routes. Reaching those needs a Clerk test-session bypass (a seeded session
token, or Clerk's Testing Tokens API) that this repo doesn't have wired up
yet. Flagged here rather than silently left out: extending this suite to
the dashboard is the natural next step once that exists, using the same
`checkA11y()` helper.

## CI

Wired into `.github/workflows/ci.yml` alongside `core`'s `npm test` and
both apps' `npm run typecheck`.
