# Team Management — UI/UX Spec

Status: draft for Full-stack engineer handoff
Inputs: `~/.claude/plans/modular-imagining-canyon.md` (approved plan), `docs/team-management-spec.md` (BA spec)
Author: UI/UX pass, 2026-09-03

This spec covers two surfaces — the Team settings page
(`cloud/app/routes/dashboard.$connectionId.settings.tsx`, replacing the
`page === "team"` stub at lines 649-663) and the invite-accept route
(`cloud/app/routes/invite.$token.tsx`, new) — plus the component stubs the
engineer can drop into `cloud/app/components/settings.tsx`. It reuses this
app's existing visual language throughout (`card`/`card-header`/`card-title`/
`card-footer`, `btn-pri`/`btn-sec`/`btn-link`/`btn-del`, `badge-ok`/
`badge-pending`/`badge-neutral`, `Row`/`Field`/`Input`/`RowSelect`/
`ConfirmDialog`/`AlertError`/`useToast`, the `Form` + hidden `_section` +
`useFetcher`-for-row-actions convention) — no new tokens, no new component
family.

---

## 0. Decision: §4.3 — hidden vs. disabled vs. inert

**Decision: hidden, never disabled, never shown-and-inert.** For a viewer
whose role is `write` or `read` (i.e. not `admin`/`owner`), every control
that would 404 on submit is **removed from the DOM**, not grayed out.
Concretely, on the Team settings page:

| Control | admin / owner | write / read |
|---|---|---|
| Invite form card | shown | **not rendered** |
| Pending invites card | shown (if ≥1 pending invite) | **not rendered** |
| Member row role `<select>` | shown (except Owner row) | **not rendered** — replaced by a plain `RoleBadge` |
| Member row Remove button | shown (except Owner row) | **not rendered** |
| Member row Resend/Revoke | shown (pending invites only, admin/owner) | n/a — card isn't rendered |
| Owner row role control / Remove | **never rendered, for any viewer** | never rendered |

Rationale, in order:

1. **This is what the app already does elsewhere**, not a new pattern.
   The Sales channels card in this same route
   (`dashboard.$connectionId.settings.tsx:626-637`) never renders the
   Disconnect button for a connection it doesn't apply to (manual, or not
   `active`) — it doesn't render a disabled one. Same move here.
2. A disabled control communicates "not right now" (mid-submit, a
   prerequisite unmet) — that's what `btn-pri disabled={pending}` already
   means throughout this file. Role is not transient state, so reusing
   the disabled affordance for it would misuse a signal this codebase
   already gives a specific meaning.
3. The server-side check in `requireTenant`/the action branches is the
   real boundary either way (plan, §"Tenant/session authorization" and
   §"Team settings page"). Hiding is purely so a `write`/`read` viewer
   never sees an interactive-looking control whose only possible outcome
   is a 404 — not a security measure.
4. A judgment call on top of the BA's matrix, stated explicitly since the
   matrix doesn't cover it: **the Pending Invites card itself is
   admin/owner-only**, not merely its Resend/Revoke buttons. The matrix
   (`docs/team-management-spec.md` §2) only promises `write`/`read`
   visibility into the established **roster** ("view roster: View"); an
   in-flight invite isn't a roster entry. If BA's still-open §4.2 is
   later answered "read should see less of Settings," nothing here needs
   to change; if it's answered "read sees everything," this is the one
   card to revisit.

**Scope note:** this ruling covers the Team page's own controls, which is
what §4.3 named explicitly (invite form, role select, remove/resend/revoke).
It does not extend to Save/Delete controls on the operational pages
(bookings/services/resources/…) — those loaders don't carry `viewerRole`
today, and the plan's verification step only asks that their *actions*
404 correctly for a `write`/`read` viewer, not that their buttons hide.
If a later pass wants that too, apply the same principle (hide, don't
disable) and thread `viewerRole` through those loaders the same way the
Team page's loader now does.

---

## 1. Team settings page

### 1.1 Data the loader must add

Alongside its existing `Settings.getSettings` etc. fetches (plan, §"Team
settings page"):

```ts
viewerRole: "owner" | "admin" | "write" | "read"; // this session's own membership.role
members: {
  userId: string;
  name: string;
  email: string;
  initials: string;         // e.g. "JS" — computed server-side from name/email
  role: "owner" | "admin" | "write" | "read";
}[]; // Team.listMembers, owner first
pendingInvites: {           // omit the fetch entirely for write/read viewers — see §0
  inviteId: string;
  email: string;
  role: "admin" | "write" | "read";
  invitedAt: string;        // pre-formatted, e.g. "Aug 27, 2026" — see §4 copy table
}[];
```

`canManage = viewerRole === "owner" || viewerRole === "admin"` is the one
boolean every control in §0's table gates on.

### 1.2 Screen states

All four states share the page chrome from `SettingsShell` (title "Team",
subtitle "Who can access this dashboard, and what they can do." — already
correct in `SETTINGS_NAV`, `components/settings.tsx:37`). Card order,
top to bottom: **Team members → Pending invites → Invite a teammate**
(the last two omitted per §0 for `write`/`read`).

#### State A — Empty (owner only, no teammates invited yet)

`members.length === 1` (just the owner) and `pendingInvites.length === 0`.

- **Team members** card: one row — the owner (`RoleBadge`, no select, no
  Remove). Below it, inside the same card, an empty hint block:
  - Heading: **"It's just you so far"**
  - Body: **"Invite a teammate below to give them their own sign-in and
    access to this dashboard."**
- **Pending invites** card: not rendered (nothing pending).
- **Invite a teammate** card: rendered normally (§1.3).

#### State B — Populated (mix of active members + pending invites)

- **Team members**: Owner row, then one `MemberRow` per other member,
  newest-invited-first-or-alphabetical is fine (`Team.listMembers`'s own
  order, per the plan — "owner first").
- **Pending invites**: one `PendingInviteRow` per pending invite —
  email, role badge, "Invited {date}", Resend / Revoke.
- **Invite a teammate**: the form, no error.

#### State C — Invite validation error (email already a member)

Same layout as State B, plus: the **Invite a teammate** card's Email
field shows an inline error instead of clearing the form on submit
(the plain `<Form>` round-trips, so `email`/`role` stay filled via
`defaultValue`/browser autofill — don't reset them).

- Field error text: **"{Name} is already on the team — change their role
  in the list above instead of sending a new invite."**
  (`{Name}` = the existing member's display name, looked up server-side;
  this is the exact case from BA edge case 3.2.)

**Do not confuse this with re-inviting a still-*pending* email** — that's
not an error (BA edge case 3.1): the existing `ConnectionInvite` row's
token/expiry refresh silently succeeds, the page shows a toast **"Invite
re-sent to {email}."**, and the Pending Invites row's date updates. Only
"already an active member" is a field error; "already pending" is a
success path indistinguishable in the UI from a fresh Resend click.

#### State D — Read-only (viewer is `write` or `read`)

**Post-implementation note:** the orchestrator's final decision on Settings
access (see docs/team-management-spec.md §2's correction note) gates the
*entire* Settings route — every page, not just Team, and the loader, not
just the action — at `"admin"`. A `write`/`read` viewer now 404s before
ever reaching this page, so this state is unreachable through normal
navigation today (the Settings nav link is also hidden for them). The
engineer implemented it anyway — `TeamReadOnlyNotice`, `canManage`-aware
`MemberRow`, the Pending Invites/Invite-form cards omitted — as
defense-in-depth rather than deleting it, so the page still renders
correctly if that routing decision is ever loosened independently of this
one. Kept here as the spec for that code path, not as a claim that it's
currently reachable.

- A notice sits above the Team members card (new `bg-canvas-alt`/
  `border-line` block — reuses existing tokens, not a new alert variant):
  **"You can see who has access, but only admins and the owner can
  invite, remove, or change someone's role. Ask an admin if you need
  something changed."**
- **Team members**: every member shown (roster stays visible per the
  matrix), each row rendered with `canManage={false}` — `RoleBadge`
  instead of a `<select>`, no Remove button.
- **Pending invites** card: not rendered (§0).
- **Invite a teammate** card: not rendered (§0).

### 1.3 Copy reference (Team page)

| Element | Copy |
|---|---|
| Empty-state heading | It's just you so far |
| Empty-state body | Invite a teammate below to give them their own sign-in and access to this dashboard. |
| Read-only notice | You can see who has access, but only admins and the owner can invite, remove, or change someone's role. Ask an admin if you need something changed. |
| Invite card title | Invite a teammate |
| Invite card, role hint | Admin can manage settings and the team. Write can create and edit bookings, services, and customers. Read can only view. |
| Invite submit button | Send invite / Sending… (in flight) |
| Invite duplicate-member error | {Name} is already on the team — change their role in the list above instead of sending a new invite. |
| Invite re-sent toast | Invite re-sent to {email}. |
| Pending invites card title | Pending invites |
| Pending row status badge | Pending (`badge-pending`, already used for this exact word elsewhere — `ui.tsx`'s `STATUS.pending`) |
| Resend button | Resend / Resending… |
| Revoke button | Revoke |
| Revoke confirm dialog title | Revoke this invite? |
| Revoke confirm dialog body | {email} won't be able to use this invite link anymore. |
| Revoke confirm button | Revoke |
| Revoked toast | Invite to {email} revoked. |
| Remove confirm dialog title | Remove {name} from the team? |
| Remove confirm dialog body | They'll immediately lose access to this dashboard. You can invite them again later. |
| Remove confirm button | Remove |
| Removed toast | {name} removed from the team. |
| Role updated toast | {name}'s role changed to {Role}. |
| Role select options (assignable) | Admin / Write / Read — **never** Owner |

---

## 2. `/invite/:token` accept page

New route, no nav chrome — same two-column shell as `signup.tsx`/
`login.tsx` (`grid min-h-dvh grid-cols-1 md:h-dvh md:grid-cols-2`, logo
card on the left capped `max-w-[372px]`, `side-dark` panel on the right).
Reuses `useSignUp`/`useSignIn`/`isClerkAPIResponseError`/`AlertError`/
`Field`/`Input`/`GoogleIcon` exactly as `signup.tsx`/`login.tsx` already
do — this spec does not re-derive that wiring, only the copy and which
of the two forms (sign-up vs. sign-in) is showing.

One difference from onboarding sign-up: **no business name / preset /
phone fields** — this isn't creating a business, so the only inputs on
the password path are First name and Password; Email is prefilled from
the invite and **locked** (`disabled`, not just `readOnly`, so it can't
be submitted-and-mismatched by devtools tampering — the server re-checks
anyway, this is just so the field doesn't visually invite editing).

### 2.1 State A — Valid invite, logged out

Left card:
- Logo mark (same as signup/login).
- `h1`: **"You're invited"**
- `p`: **"{Business} invited you to join with {Role} access."** — where
  `{Role}` is the exact token (Admin/Write/Read, §5), followed by one
  clause of plain-English gloss, e.g.: *"…with **Write** access — you'll
  be able to create and edit bookings, services, and customers, but not
  change settings or the team."* (see the per-role gloss table in §2.4).
- `Field` "Email": value = invite email, `disabled`, hint: **"This
  invite was sent to this address."**
- `btn-sec` w/ `GoogleIcon`: **"Continue with Google"**
- divider "or" (same `h-px flex-1 bg-line` treatment as signup.tsx)
- Password mode fields: `Field` "First name" (required), `Field`
  "Password" (hint **"At least 15 characters."**, show/hide toggle,
  same `MIN_PASSWORD_LENGTH = 15` as signup.tsx), Terms checkbox (same
  copy as signup.tsx: *"I agree to the Terms of Service and Privacy
  Policy."*, required to submit the password path — matches signup.tsx's
  existing behavior exactly, including that the Google path isn't gated
  on it either, since that's already the case there).
- Submit: `btn-pri` **"Create account & join {Business}"** /
  **"Joining…"** while submitting.
- Toggle link (`btn-link`) below the form: **"Already have an account?
  Sign in instead"** — flips the card into sign-in mode:
  - Same locked email field, `Field` "Password" only (no First name, no
    Terms checkbox — matches login.tsx, which has neither).
  - Submit: `btn-pri` **"Sign in & join {Business}"** / **"Joining…"**.
  - Toggle back: **"New here? Create an account instead"**.
- `AlertError` copy on failure reuses the exact strings already in
  `signup.tsx`/`login.tsx` (*"That email is already registered."* /
  *"Incorrect email or password."*) — no new error strings to invent
  here, same Clerk error mapping.

Right panel (`side-dark`):
- `h2`: **"You've been invited"**
- `p`: **"Once you join, you'll have your own sign-in with {Role} access
  to {Business}'s dashboard."**

### 2.2 State B — Valid invite, already logged in as the invited email

The plan's loader does `Team.acceptInvite` then `throw redirect(...)`
server-side with no intermediate screen. **Recommend a small change**:
have the loader accept the invite and return a small payload instead of
throwing the redirect, so the component can render a brief confirmation
before navigating client-side — an instant, silent redirect reads as
"did anything happen?" in an app that otherwise never lets a mutation
pass without visible feedback (see `AlertError`'s and `SettingsCard`'s
own comments on exactly this). Concretely:

```ts
// loader, matched-email branch
await ensureUserRow(...);
await Team.acceptInvite({ token, userId });
return { accepted: true, connectionId: invite.connectionId, businessName, role: invite.role };
```

Component, on `{ accepted: true, ... }`:

- A larger instance of the same checkmark token `SettingsCard` already
  uses for "Saved" (`bg-ok`, white glyph) — just sized up for a page-level
  moment, no new color introduced.
- `h1`: **"You're in!"**
- `p`: **"You now have {Role} access to {Business}. Taking you to the
  dashboard…"**
- `useEffect` navigates to `/dashboard/{connectionId}` after ~1.2s.
- Fallback in case the timer/navigation stalls: `btn-pri` **"Continue to
  dashboard"** linking to the same URL.

### 2.3 State C — Valid invite, logged in as a *different* email

Matches BA edge case 3.5 exactly.

- `h1`: **"Wrong account"**
- `p`: **"You're signed in as {currentEmail}. This invite was sent to
  {invitedEmail}."**
- `btn-pri`: **"Sign out and continue"** — signs out the current Clerk
  session, then reloads this same `/invite/:token` URL (which then lands
  on State A for the invited email).
- `btn-link`: **"Go to my dashboard instead"** → `/dashboard` — an escape
  hatch so someone who opened a colleague's invite link by mistake isn't
  stuck on a dead end.

### 2.4 State D — Expired / revoked / invalid / already-accepted token

Four sub-states, one shared shape (see `InviteStatusCard` stub, §3):
title + one-sentence body + optional single action. No form.

| Case | Title | Body | Action |
|---|---|---|---|
| Expired (BA 3.6) | This invite has expired | This invite expired. Ask an admin at **{Business}** to send you a new one. | none |
| Revoked (BA 3.3) | This invite is no longer valid | It was revoked by an admin at **{Business}**. Ask them if you still need access. | none |
| Already accepted | This invite has already been used | If that was you, sign in below. Otherwise, ask an admin at **{Business}** for a new invite. | `btn-pri` "Sign in" → `/login` |
| Malformed/unknown token | This invite link isn't valid | Double-check the link you were sent, or ask whoever invited you to send a new one. | `btn-sec` "Go to homepage" → `/` |

The expired/revoked/already-accepted cases have a `{Business}` name to
show (the invite row resolves even though it's unusable). The malformed
case may not — the token doesn't decode to a real invite at all, so
there's nothing to name; the copy above is written to not need it.

### 2.5 Per-role gloss (used in §2.1's invite line and reusable in the
Team page's Invite-form hint, §1.3 — same three sentences, one source of
truth):

| Role | Gloss |
|---|---|
| Admin | you'll be able to manage settings, the team, and everything operational. |
| Write | you'll be able to create and edit bookings, services, and customers, but not change settings or the team. |
| Read | you'll be able to view bookings, services, and customers, but not make changes. |

---

## 3. Component stubs

Drop these into `cloud/app/components/settings.tsx`, replacing the
current unused `MemberRow` (lines 305-327). All four are new exports;
`RoleBadge`/`InviteStatusCard` are shared by both the Team page and the
invite-accept route.

```tsx
import { useFetcher } from "react-router";
import { ConfirmDialog } from "~/components/ui";

export type Role = "owner" | "admin" | "write" | "read";

const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", write: "Write", read: "Read" };

/* Small role indicator — used wherever a role needs to be *shown* but not
   *changed*: the Owner row (any viewer), every row for a write/read
   viewer (§0 of docs/team-ui-spec.md — hidden select, not disabled), and
   the invite-accept page's "join with {Role} access" line. Owner gets the
   same brand-tinted treatment PresetFieldBadge already uses for
   "Customized" (components/settings.tsx:155-161) so it reads as
   "special", not just another neutral badge. */
export function RoleBadge({ role }: { role: Role }) {
  return (
    <span className={role === "owner" ? "badge bg-brand-50 text-brand-600" : "badge-neutral"}>
      {ROLE_LABEL[role]}
    </span>
  );
}

/* Member row — one per active ConnectionMember. The Owner row never gets
   a select or a Remove control, for ANY viewer — role is always shown as
   RoleBadge and no action renders (BA edge case 3.4: this is defense in
   depth, the server-side reject in Team.updateMemberRole/removeMember is
   the real guarantee). For a write/read viewer, pass canManage={false}:
   role renders as RoleBadge instead of a <select>, and Remove doesn't
   render at all — see docs/team-ui-spec.md §0 for why this is hidden,
   not disabled, and never shown-and-inert. */
export function MemberRow({
  userId, name, email, initials, role, canManage,
}: {
  userId: string;
  name: string;
  email: string;
  initials: string;
  role: Role;
  /** viewerRole === "owner" || viewerRole === "admin" */
  canManage: boolean;
}) {
  const roleFetcher = useFetcher();
  const removeFetcher = useFetcher();
  const isOwner = role === "owner";
  const dialogId = `remove-member-${userId}`;

  // Optimistic role: reflect the in-flight submission immediately, same
  // pattern as this file's own MessageRow/toggleFetcher (route file,
  // dashboard.$connectionId.settings.tsx ~line 748-767).
  const displayRole = (roleFetcher.formData?.get("role") as Role | null) ?? role;

  return (
    <div className="flex items-center gap-3 border-b border-row px-[18px] py-3">
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#efecf4] text-[11px] font-semibold text-ink-3">
        {initials}
      </span>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <span className="truncate text-[13px] font-medium">{name}</span>
        <span className="truncate text-[12px] text-subtle">{email}</span>
      </div>

      {!canManage || isOwner ? (
        <RoleBadge role={displayRole} />
      ) : (
        <roleFetcher.Form method="post" onChange={(e) => roleFetcher.submit(e.currentTarget)}>
          <input type="hidden" name="_section" value="update_member_role" />
          <input type="hidden" name="target_user_id" value={userId} />
          <select
            name="role"
            defaultValue={role}
            className="shrink-0 rounded-[7px] border border-line-strong bg-surface px-[9px] py-[6px] text-meta"
          >
            <option value="admin">Admin</option>
            <option value="write">Write</option>
            <option value="read">Read</option>
          </select>
        </roleFetcher.Form>
      )}

      {canManage && !isOwner ? (
        <>
          <button
            type="button"
            className="btn-link shrink-0 text-danger"
            onClick={() => (document.getElementById(dialogId) as HTMLDialogElement | null)?.showModal()}
          >
            Remove
          </button>
          <ConfirmDialog
            id={dialogId}
            title={`Remove ${name} from the team?`}
            body="They'll immediately lose access to this dashboard. You can invite them again later."
            confirmLabel="Remove"
            pending={removeFetcher.state !== "idle"}
            pendingLabel="Removing…"
          >
            <removeFetcher.Form method="post" id={`${dialogId}-form`}>
              <input type="hidden" name="_section" value="remove_member" />
              <input type="hidden" name="target_user_id" value={userId} />
            </removeFetcher.Form>
          </ConfirmDialog>
        </>
      ) : null}
    </div>
  );
}

/* Pending-invite row — distinct from MemberRow (not an extension of it):
   a pending invite has no user account yet (no initials-from-a-real-name,
   no Owner special-case, no role select to change in place — the fix for
   "wrong role" is Revoke + re-invite, not an inline edit), and carries two
   actions MemberRow never has (Resend/Revoke) instead of one (Remove).
   Forcing both shapes through one component would mean threading a pile
   of "only if this is actually a member" conditionals through it for no
   shared benefit — this whole page only renders it when canManage is
   true (§0: the Pending Invites card doesn't exist for write/read at
   all), so there's no read-only variant to keep in sync with MemberRow's. */
export function PendingInviteRow({
  inviteId, email, role, invitedAt,
}: {
  inviteId: string;
  email: string;
  role: Exclude<Role, "owner">;
  /** Pre-formatted server-side, e.g. "Aug 27, 2026" — see docs/team-ui-spec.md §1.3. */
  invitedAt: string;
}) {
  const resendFetcher = useFetcher();
  const revokeFetcher = useFetcher();
  const dialogId = `revoke-invite-${inviteId}`;
  const resending = resendFetcher.state !== "idle";

  return (
    <div className="flex items-center gap-3 border-b border-row px-[18px] py-3">
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#efecf4] text-[11px] font-semibold text-ink-3">
        {email.slice(0, 1).toUpperCase()}
      </span>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <span className="truncate text-[13px] font-medium">{email}</span>
        <span className="truncate text-[12px] text-subtle">Invited {invitedAt}</span>
      </div>
      <RoleBadge role={role} />
      <span className="badge-pending shrink-0">Pending</span>

      <resendFetcher.Form method="post">
        <input type="hidden" name="_section" value="resend_invite" />
        <input type="hidden" name="invite_id" value={inviteId} />
        <button type="submit" className="btn-link shrink-0" disabled={resending}>
          {resending ? "Resending…" : "Resend"}
        </button>
      </resendFetcher.Form>

      <button
        type="button"
        className="btn-link shrink-0 text-danger"
        onClick={() => (document.getElementById(dialogId) as HTMLDialogElement | null)?.showModal()}
      >
        Revoke
      </button>
      <ConfirmDialog
        id={dialogId}
        title="Revoke this invite?"
        body={`${email} won't be able to use this invite link anymore.`}
        confirmLabel="Revoke"
        pending={revokeFetcher.state !== "idle"}
        pendingLabel="Revoking…"
      >
        <revokeFetcher.Form method="post" id={`${dialogId}-form`}>
          <input type="hidden" name="_section" value="revoke_invite" />
          <input type="hidden" name="invite_id" value={inviteId} />
        </revokeFetcher.Form>
      </ConfirmDialog>
    </div>
  );
}

/* Invite form — a plain Form (not a fetcher), per the plan's own
   convention for this card ("matching every other section's convention
   in this file" — i.e. disconnect_store's plain <Form>, route file
   ~line 630-634). `pending`/`error` are computed by the route from
   useNavigation()/actionData, the same way TemplateTab already derives
   `pending={navigation.state !== "idle"}` for its own plain-Form submit
   (route file ~line 852-892) — this component doesn't own a fetcher. */
export function InviteMemberCard({ pending, error }: { pending: boolean; error?: string }) {
  return (
    <form method="post" className="card">
      <div className="card-header">
        <h2 className="card-title">Invite a teammate</h2>
      </div>
      <div className="flex flex-col gap-[14px] px-[18px] py-[16px]">
        <input type="hidden" name="_section" value="invite_member" />
        <Row label="Email">
          <RowInput type="email" name="email" required autoComplete="email" cap={320} />
        </Row>
        {error ? (
          <span className="flex items-center gap-[7px] px-[18px] text-meta font-medium text-danger">
            <span className="inline-flex h-[15px] w-[15px] items-center justify-center rounded-full bg-danger text-[9px] text-white">!</span>
            {error}
          </span>
        ) : null}
        <Row label="Role" hint="Admin can manage settings and the team. Write can create and edit bookings, services, and customers. Read can only view.">
          <RowSelect name="role" defaultValue="write" cap={200}>
            <option value="admin">Admin</option>
            <option value="write">Write</option>
            <option value="read">Read</option>
          </RowSelect>
        </Row>
      </div>
      <div className="card-footer">
        <span />
        <button type="submit" className="btn-pri" disabled={pending}>
          {pending ? "Sending…" : "Send invite"}
        </button>
      </div>
    </form>
  );
}

/* Read-only banner — Team page, write/read viewer only (§0/State D). */
export function TeamReadOnlyNotice() {
  return (
    <div className="flex items-center gap-3 rounded-[10px] border border-line bg-canvas-alt px-[15px] py-[13px] text-[13px] text-ink-2">
      You can see who has access, but only admins and the owner can invite, remove, or change someone's role. Ask an admin if you need something changed.
    </div>
  );
}

/* Team page's empty state (§1.2 State A) — rendered inside the Team
   members card, below the owner's own row, only when there's no one
   else to show yet. */
export function TeamEmptyHint() {
  return (
    <div className="flex flex-col items-center gap-2 px-[18px] py-10 text-center">
      <span className="text-[13px] font-medium text-ink-2">It's just you so far</span>
      <p className="m-0 max-w-[320px] text-meta text-subtle">
        Invite a teammate below to give them their own sign-in and access to this dashboard.
      </p>
    </div>
  );
}

/* Shared shape for the invite-accept page's terminal states (expired /
   revoked / already-accepted / malformed token — docs/team-ui-spec.md
   §2.4): a title, one sentence, and an optional single action. Lives in
   the same left-card slot signup.tsx/login.tsx use
   (`card w-full max-w-[372px] p-[26px]`), so invite.$token.tsx can drop
   this straight into that shell instead of rebuilding it four times. */
export function InviteStatusCard({
  title, body, action,
}: { title: string; body: ReactNode; action?: ReactNode }) {
  return (
    <div className="card w-full max-w-[372px] p-[26px]">
      <h1 className="page-title mt-4">{title}</h1>
      <p className="mt-2 text-body text-muted">{body}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
```

**Note on `InviteMemberCard`'s shape**: it uses `Row`/`RowInput`/
`RowSelect` (the settings-page row pattern) rather than `Field`/`Input`
(the auth-page pattern `signup.tsx` uses) — this card lives inside the
Team settings page's card stack, so it should look like every other
settings card (General, Notifications, …), not like a login form. The
invite-*accept* page (§2) is the opposite context and correctly uses
`Field`/`Input` to match `signup.tsx`/`login.tsx`.

### 3.1 Why a new `PendingInviteRow` instead of extending `MemberRow`

Answering the open question directly: **yes, a distinct component**, not
an extended `MemberRow`. Three reasons, all in the code comment above too:
a pending invite has no user identity yet (no real name/initials, no
possibility of being the Owner row), its one meaningful action (fix a
wrong role) is Revoke-and-reinvite rather than an inline role change, and
it needs two buttons (Resend, Revoke) where `MemberRow` needs at most one
(Remove). The original `MemberRow`'s `status: "Active" | "Invited"` prop
— which was the old placeholder's way of cramming both shapes into one
component — is dropped entirely in the stub above; every `MemberRow` is
now implicitly "Active" (pending members render as `PendingInviteRow` in
a separate card instead).

---

## 4. Relabeling — confirmed

The existing unused `MemberRow`'s `<option>Owner</option>
<option>Manager</option><option>Staff</option>` (line 320) does **not**
carry over. Per the approved plan's role set:

- **Owner** — never an `<option>` anywhere; the Owner's row (§3's
  `MemberRow`) renders `RoleBadge` unconditionally, no `<select>`, for
  every viewer, always.
- **Admin**, **Write**, **Read** — the only three assignable values, in
  that order, in every role `<select>` (member-role-change) and every
  invite-role `<select>` (Team page's Invite form, none elsewhere). Use
  these exact labels — not "Manager"/"Staff", and not a friendlier alias
  like "Staff access" — so the visible word always matches the
  `ConnectionMember.role`/`ConnectionInvite.role` string values
  (`admin`/`write`/`read`) the engineer is storing, with only a
  capitalized first letter as the transform. Where more explanation is
  useful (the invite form's hint, the accept page's invite line), add a
  plain-English gloss *alongside* the label (§2.5) — never rename the
  label itself.

---

## 5. Summary for the engineer

- §0 is the answer to the BA's §4.3 risk: hide, don't disable, per the
  table there. `canManage` (from the loader's `viewerRole`) is the one
  flag every control check needs.
- New components: `RoleBadge`, `PendingInviteRow`, `InviteMemberCard`,
  `TeamReadOnlyNotice`, `TeamEmptyHint`, `InviteStatusCard` — all in §3,
  ready to paste into `components/settings.tsx`. `MemberRow` is revised
  in place (owner-aware, `canManage`-aware, no `status` prop).
- Every string used across both pages is written out in §1.3 and inline
  through §2 — nothing should need to be invented while implementing.
