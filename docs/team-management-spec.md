# Team Management — Functional Spec

Status: draft for UI/UX handoff
Source plan: `~/.claude/plans/modular-imagining-canyon.md` (approved)
Author: Business Analyst pass, 2026-09-03

This spec translates the approved implementation plan into user stories, a
concrete permission matrix, and edge cases, grounded in the current
codebase (`core/prisma/schema.prisma`, `cloud/app/components/settings.tsx`,
`cloud/app/routes/dashboard.$connectionId.settings.tsx`). It does not
revisit settled decisions from the plan: roles are **read / write / admin**
(assignable) plus implicit **owner**; there is no ownership transfer in v1;
Clerk (`@clerk/react-router`) is the auth provider, with both password and
Google sign-up/sign-in already built for `signup.tsx`/`login.tsx`.

---

## 1. User stories

### 1.1 Owner (or admin) invites a teammate

> As the owner or an admin of a business, I want to invite a teammate by
> email and assign them a role, so they can access the dashboard with the
> right level of access without sharing my login.

- Only visible/reachable by a member whose role is `admin` or `owner` —
  Settings → Team is gated the same as every other admin action
  (`requireTenant(request, connectionId, "admin")` on the invite action).
- The invite form is email + a role `<select>` limited to **Admin / Write /
  Read** — "Owner" is never an option (`ConnectionInvite.role` explicitly
  excludes `"owner"`).
- On submit: a `ConnectionInvite` row is created (or refreshed — see edge
  case 3.1) with a 7‑day expiry, an email is sent via
  `Mailer.sendTeamInvite` containing the `/invite/:token` link, and the new
  row appears immediately under **Pending invites** (email, role, invited
  date, Resend/Revoke actions).
- Inviting an email that's already an active member on this connection is
  rejected inline (edge case 3.2) rather than silently creating a
  duplicate or a second invite.

### 1.2a Teammate accepts an invite — sets a password

> As an invited teammate without a GetBooqin account, I want to open my
> invite link and create a password, so I can start using the dashboard
> with the access the business gave me.

- Opening `/invite/:token` logged out shows "**{Business}** invited you to
  join as **{role}**" with the invited email shown but locked (not
  editable — it's the identity the role was granted to).
- Completing Clerk sign-up with a password (reusing `signup.tsx`'s
  `useSignUp`/`MIN_PASSWORD_LENGTH` conventions) redirects back to the same
  `/invite/:token` URL, whose loader then runs `ensureUserRow` →
  `Team.acceptInvite` and redirects into `/dashboard/:connectionId`.
- The teammate lands directly in the dashboard with the UI/data access
  matching their assigned role — no separate "welcome" or onboarding step.

### 1.2b Teammate accepts an invite — Google sign-in

> As an invited teammate, I want to accept using "Continue with Google"
> instead of setting a password, so I can use my existing Google account.

- Same entry screen as 1.2a, but the teammate uses the existing Google
  OAuth control (`GoogleIcon`/Clerk OAuth flow already used by
  `signup.tsx`/`sso-callback.tsx`), with `redirectUrlComplete` pointed back
  at `/invite/:token`.
- If the Google account they authenticate with doesn't match the invited
  email, this is **not** treated as a valid acceptance — see edge case
  3.5.
- On success, same outcome as 1.2a: membership created, redirected into the
  dashboard with the assigned role in effect.

### 1.3 Admin changes or revokes a member's role or access

> As an admin (or the owner), I want to change a teammate's role or remove
> their access entirely, so permissions stay current as responsibilities
> change or someone leaves.

- The Members list (`MemberRow`) shows every active member with a role
  `<select>` (Admin/Write/Read) and a Remove action — except the Owner row,
  which renders with no select and no remove control at all.
- Changing a role or removing a member takes effect via a `useFetcher`
  action; because `requireTenant` re-checks membership/role on every
  subsequent request, the change is enforced from that member's very next
  request regardless of whether their browser session refreshes.
- An admin can also **Resend** or **Revoke** a still-pending invite from
  the same page, before it's ever accepted.
- Attempting to change the role or remove the Owner row is impossible from
  the UI (no controls rendered) and rejected server-side if attempted
  anyway (edge case 3.4) — defense in depth, not just a hidden button.

### 1.4 A read-only member's restricted dashboard experience

> As a read-only teammate, I want to view the business's bookings,
> services, customers, etc. so I can look things up, but I should not be
> able to create, edit, delete, or touch settings, so the business is
> protected from mistakes or changes outside my remit.

- Every operational loader (bookings, services, resources, customers,
  timeoff, waitlist) stays open at the default `"read"` minimum role, so a
  `read` member sees exactly the same operational data everyone else does.
  **Settings is the one exception** — see the correction note under §2:
  the orchestrator resolved this differently from the plan-as-literally-
  written, and every Settings page's loader (not just its action) now
  requires `"admin"`, so a `read`/`write` member sees none of Settings,
  not even the Team roster.
- Any create/edit/delete submission is rejected server-side with a 404
  (mutations require `"write"`; Settings/Team mutations require
  `"admin"`), matching the "store not found"-style failure `requireTenant`
  already uses for out-of-tenant access elsewhere in the app.
- **Open question for UI/UX** (see §4): the plan only specifies server-side
  enforcement. Whether write/edit/delete controls should be visually
  hidden or disabled for a `read` viewer — versus left interactive and
  failing on submit — is not decided in the plan and needs a call before
  screens are built.

---

## 2. Role permission matrix

Confirmed against the real `SETTINGS_NAV` in `cloud/app/components/settings.tsx`
(Business group: General, Business template, Booking rules, Notifications,
Payments, Visit summaries, Integrations, Team — more sections than the
four commonly assumed). Account (Profile / Password & security) is
identity-scoped to the signed-in user, not connection-role-gated, so it's
excluded from this table — every member manages their own account
regardless of role.

Legend: **Edit** = can submit the section's mutating actions · **View** =
loader-rendered data visible, no mutating controls available (or any
attempt 404s) · **—** = not applicable to that role.

| Dashboard area | Owner | Admin | Write | Read |
|---|---|---|---|---|
| Bookings | Edit | Edit | Edit | View |
| Services | Edit | Edit | Edit | View |
| Resources | Edit | Edit | Edit | View |
| Customers | Edit | Edit | Edit | View |
| Timeoff | Edit | Edit | Edit | View |
| Waitlist | Edit | Edit | Edit | View |
| Settings → General | Edit | Edit | No access (404) | No access (404) |
| Settings → Business template | Edit | Edit | No access (404) | No access (404) |
| Settings → Booking rules | Edit | Edit | No access (404) | No access (404) |
| Settings → Notifications | Edit | Edit | No access (404) | No access (404) |
| Settings → Payments | Edit | Edit | No access (404) | No access (404) |
| Settings → Visit summaries | Edit | Edit | No access (404) | No access (404) |
| Settings → Integrations | Edit | Edit | No access (404) | No access (404) |
| Settings → Team (view roster) | Edit | Edit | No access (404) | No access (404) |
| Settings → Team (invite / change role / remove / resend / revoke) | Edit | Edit | No access (404) | No access (404) |

Notes:
- **Owner vs Admin are functionally identical** everywhere in this table —
  the only asymmetry is that the Owner's own membership row can never be
  demoted or removed by anyone (including another admin, including the
  owner acting on themself), and there is no "transfer ownership" action
  for either role in v1.
- The **Bookings–Waitlist** rows are flat by design in the plan: all
  mutating routes in that group are uniformly bumped to `"write"` minimum,
  with no finer-grained distinction between e.g. "can cancel a booking" vs
  "can edit a service."
- **Correction, post-implementation (superseding the two notes originally
  here):** this section originally read every Settings row (including the
  Team roster) as `write`/`read`-**viewable**, on a literal reading of the
  plan text ("only the settings *action* is bumped to `admin`; the loader
  stays at the default `read`"). The orchestrator resolved this
  explicitly and differently: `dashboard.$connectionId.settings.tsx`'s
  **loader**, not just its action, requires `"admin"` — every Settings
  page, including Team's roster view, is business configuration/sensitive
  data (billing, integration credentials, every member's name and email),
  not merely "read" like an operational list. A `write`/`read` teammate
  now gets a 404 on the Settings route entirely (loader-level), and the
  dashboard's own Settings nav link is hidden for them so it isn't a
  dead link. This is what's actually implemented — the table above
  reflects it. The `write`/`read` "read-only Team page" screen state
  (`TeamReadOnlyNotice`, docs/team-ui-spec.md §1.2 State D) is still
  implemented in code as defense-in-depth, but is unreachable today given
  this loader-level gate — see that doc's own updated note.

---

## 3. Edge cases

### 3.1 Re-inviting an email that already has a pending invite
**Given** a `ConnectionInvite` with `status: "pending"` already exists for
`jane@biz.com` on this connection,
**when** an admin submits another invite for `jane@biz.com` (same or a
different role),
**then** the existing invite's token and `expiresAt` are refreshed in
place (backed by the `@@unique([connectionId, email])` constraint) rather
than a second row being created, the role updates to whatever was just
submitted, a fresh invite email goes out, and the Pending Invites list
still shows exactly one row for Jane. *(See §4.1 — whether the
previously-sent email link keeps working after this refresh is an open
question, not settled by the plan text.)*

### 3.2 Inviting an email that's already a member
**Given** `jane@biz.com` already has an active `ConnectionMember` row on
this connection,
**when** an admin tries to invite `jane@biz.com` again,
**then** the invite is rejected inline with a clear message ("Jane is
already a member — change her role from the list below instead") and no
`ConnectionInvite` row or email is created.

### 3.3 Revoking a pending invite
**Given** a pending invite exists for `jane@biz.com`,
**when** an admin clicks Revoke on that row,
**then** the invite's `status` flips to `"revoked"`, it disappears from
Pending Invites, and opening the (now-revoked) accept link shows an
explicit "this invite is no longer valid" screen — not a generic error and
not a silent accept — even though the link's own signed token may still be
within its cryptographic TTL. The DB-side `status` check in `acceptInvite`
is what must block it, not the token's own expiry.

### 3.4 Removing or demoting the sole owner
**Given** a connection has exactly one member with `role: "owner"`,
**when** any actor — including another admin, including the owner acting
on their own row — calls `updateMemberRole` or `removeMember` targeting
that owner's `ConnectionMember` row,
**then** the operation is rejected server-side unconditionally (the rule
is "never touch the owner row," not "unless they're the last one"), the
Owner row in the UI never renders a role select or remove control in the
first place, and no client-constructible request should be able to reach
this state — the server-side reject is the real guarantee, the missing UI
control is only the first line of defense.

### 3.5 Invite accepted by a Clerk account whose email doesn't match the invited email
**Given** an invite is pending for `jane@biz.com`,
**when** a user already signed into Clerk as `bob@biz.com` opens
`/invite/:token` (or completes "Continue with Google" mid-flow using a
Google account that resolves to `bob@biz.com`),
**then** the loader must not auto-accept using Bob's session — it shows
"You're signed in as bob@biz.com — sign out to accept this invite as
jane@biz.com," and acceptance only proceeds once someone actually
authenticated as `jane@biz.com` (via new sign-up or an existing account's
sign-in) lands back on `/invite/:token`. This applies identically to the
password and Google paths — the email match is checked after
authentication completes, not assumed from which button was clicked.

### 3.6 Expired invite link
**Given** a `ConnectionInvite` with `status: "pending"` whose `expiresAt`
(7 days from creation/last resend) has passed,
**when** the invite link is opened,
**then** the loader's expiry check (against the DB row's `expiresAt`, not
only the token's own signed TTL) renders an explicit expired state ("This
invite has expired — ask an admin to resend it") rather than a generic
404 or a silent accept, and the invite's `status` must not be flippable to
`"accepted"` by an out-of-window request even if the signed token itself
would otherwise still verify.

---

## 4. Open questions / risks for the engineer to confirm before building

These are gaps or under-specified interactions in the approved plan, not
disagreements with its settled decisions (roles, no ownership transfer,
Clerk as the provider). Flagging so they're resolved deliberately rather
than by accident of implementation order.

**4.1 — Does resending an invite invalidate the previously emailed link?**
`inviteMember`'s token is generated via `signPayload({ inviteId }, ttl)`
(`core/src/auth/session.ts`), which bakes its own expiry into the signed
string, independent of the `ConnectionInvite.expiresAt` DB column the plan
also checks. The plan says a resend "refresh[es] its token/expiry," but
doesn't say whether `acceptInvite` looks up the invite by matching the
*presented* token string against the current `ConnectionInvite.token`
column, or simply decodes `inviteId` from whatever valid, unexpired token
is presented and checks the DB row's `status`/`expiresAt` from there. If
it's the latter, a stale, previously-emailed link keeps working
interchangeably with the newly-sent one until either hits the shared
`expiresAt` — which may not match an admin's mental model of "resend"
(that the old email is now the wrong/expired one). Worth deciding
explicitly, and testing, either way.

**4.2 — How much of Settings is really meant to be `read`-visible?**
The plan only bumps the Settings route's **action** to `"admin"`; its
**loader** — and every other loader in the app — stays at the default
`"read"`. Taken literally, that means a `read`-role teammate (e.g.
front-desk staff invited just to look up bookings) can navigate to
Settings → Payments and Settings → Integrations and see whatever those
pages currently render, plus the full Team roster (every member's name and
email). That may be entirely intended ("read sees everything, edits
nothing," consistent with the operational pages) — but it's worth an
explicit yes/no before building, since it's the one place "view" plausibly
means something more sensitive than "see today's bookings." If the answer
is no, the Settings loader (or specific sub-pages within it) would need
its own minRole bump that the current plan doesn't call for.

**4.3 — No client-side gating is specified for role-restricted controls.**
Enforcement in the plan is entirely server-side (a 404 on an
underprivileged mutation). Nothing says the write/edit forms and buttons
themselves should be hidden or disabled based on the viewer's role. Left
as-is, a `read` member sees fully interactive Save/Delete/Invite buttons
throughout the dashboard that all dead-end in a 404 on click — confusing
rather than simply absent. This is really a question for the UI/UX pass
next, but it has an engineering dependency: today only the Team page's
loader is planned to return the viewer's own role; if other routes should
also hide controls by role, their loaders need the same addition.

**4.4 — Email comparison/normalization isn't specified.**
The "already a member" check in `inviteMember`, the `@@unique([connectionId,
email])` constraint, and the accept-loader's "does the Clerk account's
email match the invite's email" check (edge case 3.5) all appear to be
plain string comparisons on whatever the admin typed into the invite form.
Clerk normalizes account emails (generally lower-cased); a free-typed
`Jane@Biz.com` in the invite form could fail to match `jane@biz.com` as
Jane's actual Clerk identity, sending a legitimate acceptance down the
"signed in as a different email" dead end (3.5) for no real reason.
Recommend normalizing (trim + lower-case) on write (invite creation) and
on every subsequent comparison, not just relying on Postgres's
case-sensitive uniqueness.

**4.5 — Ordering between creating the invite row and sending the email isn't specified.**
If `Mailer.sendTeamInvite` throws (provider outage, bad address, etc.)
after `inviteMember` has already written the `ConnectionInvite` row, does
the admin see an error, or does the invite silently sit in "Pending" with
an email the recipient never received? Since a Resend action already
exists as the natural recovery path, the simplest resolution is: persist
the invite row first, attempt the send, and surface a toast error on
failure without rolling back the row (so Resend is right there) — but the
plan doesn't state this, and it's cheap to get wrong (e.g. rolling back
the row on send failure, which would silently drop the "it's pending, hit
Resend" recovery path).

---

**Handoff to UI/UX:** the permission matrix (§2) and the four dashboard
states implied by it (owner/admin-full-control, write-operational-only,
read-view-only, plus the pending/expired/revoked/mismatched-email invite
states in §3) are the inputs for the Team settings cards and the
`/invite/:token` accept screen. §4.3 in particular needs a decision from
you before the engineer wires up per-role UI, since it changes what the
loaders need to return.
