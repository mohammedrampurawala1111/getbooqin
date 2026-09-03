import { useEffect, useRef, type ReactNode } from "react";
import { Form, useFetcher } from "react-router";
import { ConfirmDialog, useToast } from "~/components/ui";

/* ==================================================================
   Settings shell — one rail, one page at a time (design handoff v4).
   The old design stacked every field in its own full-width card, which
   burned a screen of height on four inputs. This uses a settings rail
   plus a dense row pattern: label left, control right, hairline between.

   The row is `repeat(auto-fit, minmax(200px, 1fr))`, NOT a fixed label
   column. A fixed 216px label + gap cannot coexist with a real control
   in a ~390px content track; auto-fit drops to one column and stacks
   label above control instead of clipping. Every capped control also
   needs `w-full min-w-0`, or intrinsic input width overflows the track.

   Account items (Profile, Password & security) render in the same rail
   for visual continuity — Account's own data is identity-scoped (one
   user, many stores), but the *route* now lives nested under the current
   connection (dashboard.$connectionId.account.tsx) precisely so it stays
   inside this same shell instead of dropping to a bare topbar the moment
   you click over to it. Every item's path is relative to that connection,
   so this shell always needs a `base` ("/dashboard/:connectionId").
   ================================================================== */

export const SETTINGS_NAV = [
  { group: "Account", items: [
    { key: "profile", label: "Profile", path: "/account", title: "Account", subtitle: "Your personal details. Business-wide settings are below." },
    { key: "security", label: "Password & security", path: "/account?tab=security", title: "Account", subtitle: "Your personal details. Business-wide settings are below." },
  ]},
  { group: "Business", items: [
    { key: "general", label: "General", path: "/settings?page=general", title: "General", subtitle: "Business identity and how time is displayed." },
    { key: "template", label: "Business template", path: "/settings?page=template", title: "Business template", subtitle: "Industry preset, vocabulary and which Overview cards show." },
    { key: "rules", label: "Booking rules", path: "/settings?page=rules", title: "Booking rules", subtitle: "When customers can book, and what happens automatically." },
    { key: "notifications", label: "Notifications", path: "/settings?page=notifications", title: "Notifications", subtitle: "Emails sent to customers and staff." },
    { key: "payments", label: "Payments", path: "/settings?page=payments", title: "Payments", subtitle: "How money is collected for bookings." },
    { key: "visit_summaries", label: "Visit summaries", path: "/settings?page=visit_summaries", title: "Visit summaries", subtitle: "AI-drafted, clinician-reviewed summaries patients can keep after a visit." },
    { key: "integrations", label: "Integrations", path: "/settings?page=integrations", title: "Integrations", subtitle: "Optional integrations. GetBooqin works fully without any of them." },
    { key: "team", label: "Team", path: "/settings?page=team", title: "Team", subtitle: "Who can access this dashboard, and what they can do." },
  ]},
] as const;

export type SettingsKey = typeof SETTINGS_NAV[number]["items"][number]["key"];

/**
 * Which settings-nav items to hide, given the two feature gates that
 * control them. Two routes render this same rail (dashboard.$connectionId.
 * settings.tsx and dashboard.$connectionId.account.tsx) and each used to
 * compute its own visibility independently — the account route never
 * checked visit_summaries/preset at all, so switching the business
 * template away from Clinic left "Visit summaries" showing there while the
 * settings route correctly hid it, in the same session (Defect Dossier's
 * BQ-21 finding). One function both routes call now.
 */
export function hiddenSettingsNavKeys(gates: {
  paymentsEnabled: boolean;
  visitSummariesEnabled: boolean;
  preset: string | null;
}): SettingsKey[] {
  return [
    ...(gates.paymentsEnabled ? [] : (["payments"] as const)),
    ...(gates.visitSummariesEnabled && gates.preset === "clinic" ? [] : (["visit_summaries"] as const)),
  ];
}

// The route's own ?page= value used to be cast straight to SettingsKey with
// `as` — an unrecognized value (a typo, a stale link, a preset id someone
// pasted into the wrong param) matched none of the route's `page === "x"`
// blocks, so the content pane rendered nothing while the nav/title still
// looked normal via settingsMeta's own fallback below (UX audit's #7
// finding). "profile"/"security" are the /account route's own tab values,
// not valid here.
const SETTINGS_PAGE_KEYS: readonly string[] = SETTINGS_NAV.find((g) => g.group === "Business")!.items.map(
  (i) => i.key
);

export function isSettingsPage(value: string | null): value is SettingsKey {
  return !!value && SETTINGS_PAGE_KEYS.includes(value);
}

export function settingsMeta(key: string) {
  for (const g of SETTINGS_NAV) {
    const hit = g.items.find((i) => i.key === key);
    if (hit) return hit;
  }
  return SETTINGS_NAV[1].items[0];
}

export function SettingsShell({
  active, base, hide, children,
}: { active: SettingsKey; base: string; hide?: SettingsKey[]; children: ReactNode }) {
  const meta = settingsMeta(active);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-[5px]">
        <h1 className="page-title">{meta.title}</h1>
        <p className="page-sub">{meta.subtitle}</p>
      </div>

      <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-[minmax(0,168px)_minmax(0,1fr)]">
        <nav className="flex flex-col gap-[14px] md:sticky md:top-[26px]">
          {SETTINGS_NAV.map((g) => (
            <div key={g.group} className="flex flex-col gap-px">
              <span className="px-[10px] pb-[5px] text-[10.5px] font-semibold uppercase tracking-[0.07em] text-subtle">{g.group}</span>
              {g.items
                .filter((i) => !hide?.includes(i.key))
                .map((i) => (
                  <a key={i.key} href={`${base}${i.path}`}
                    className={`rounded-field px-[10px] py-[7px] text-[13px] font-medium no-underline hover:no-underline ${
                      i.key === active ? "bg-brand-50 text-brand-600" : "text-ink-2 hover:bg-canvas-alt"
                    }`}>
                    {i.label}
                  </a>
                ))}
            </div>
          ))}
        </nav>
        <div className="flex min-w-0 flex-col gap-[14px]">{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The row. `align` = "center" for single controls, "start" when the
   control has its own stacked hint (e.g. password strength). Wraps in a
   real <label> by default — the label span and the control were two
   unrelated siblings with no `for`/`id` pair and no wrapping element, so
   every field built on Row had no accessible name at all (axe: label
   [critical] — pass 7's N1 finding: General 6/6, Notifications' two plain
   Row fields). A wrapping <label> is the same implicit-association
   pattern ui.tsx's Field already uses correctly.
   `as="div"` opts out for the couple of rows whose child already renders
   its own <label> (Toggle) — nesting <label> inside <label> is invalid
   HTML and breaks the association for both. */
export function Row({
  as = "label", label, hint, align = "center", badge, children,
}: { as?: "label" | "div"; label: string; hint?: string; align?: "center" | "start"; badge?: ReactNode; children: ReactNode }) {
  const Tag = as;
  return (
    <Tag className={`grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-x-6 gap-y-2 border-b border-row px-[18px] py-[14px] ${
      align === "start" ? "items-start" : "items-center"
    }`}>
      <div className="flex flex-col gap-[2px]">
        <span className="flex items-center gap-2 text-[13px] font-medium">{label}{badge}</span>
        {hint ? <span className="text-[12px] text-subtle">{hint}</span> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </Tag>
  );
}

/* "Preset default" vs "Customized" — tells a merchant which fields a
   template switch will (and won't) touch: applyPreset() (core's
   settings.ts) skips any key in settings.customized_fields, so a hand-edit
   here survives picking a different template later. */
export function PresetFieldBadge({ customized }: { customized: boolean }) {
  return customized ? (
    <span className="badge bg-brand-50 text-brand-600">Customized</span>
  ) : (
    <span className="badge-neutral">Preset default</span>
  );
}

/* Controls sized for a row. `cap` is a max-width; w-full/min-w-0 stop
   the intrinsic input width from blowing out the track. */
export function RowInput({
  cap = 280, mono, ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { cap?: number; mono?: boolean }) {
  return (
    <input {...props}
      style={{ maxWidth: cap, ...props.style }}
      className={`w-full min-w-0 rounded-field border border-line-strong bg-surface px-[11px] py-2 text-body ${mono ? "num" : ""}`} />
  );
}

export function RowSelect({
  cap = 260, children, ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { cap?: number }) {
  return (
    <select {...props} style={{ maxWidth: cap, ...props.style }}
      className="w-full min-w-0 rounded-field border border-line-strong bg-surface px-[11px] py-2 text-body">
      {children}
    </select>
  );
}

/* Multi-line sibling of RowInput — same w-full min-w-0/cap/sizing discipline,
   just a <textarea> instead of an <input>. First real consumer is the
   visit-summary consent notice (a free-text paragraph, not a short value),
   which is why the default `cap` is generous rather than RowInput's 280. */
export function RowTextarea({
  cap = 9999, rows = 4, ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { cap?: number }) {
  return (
    <textarea {...props} rows={rows}
      style={{ maxWidth: cap, ...props.style }}
      className="w-full min-w-0 resize-y rounded-field border border-line-strong bg-surface px-[11px] py-2 text-body" />
  );
}

/* Read-only value + inline action (email, currency). Wrapping flex, and
   the value gets `overflow-wrap: anywhere` because a long address will
   otherwise push the badge out of the card. */
export function ValueRow({
  label, hint, value, badge, action,
}: { label: string; hint?: string; value: string; badge?: ReactNode; action?: ReactNode }) {
  return (
    <Row label={label} hint={hint}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-0 text-body [overflow-wrap:anywhere]">{value}</span>
        {badge}
        {action}
      </div>
    </Row>
  );
}

/* Toggle row — wrapping flex, not a 3-column grid: at narrow widths a
   grid squeezes the hint to nothing while the switch keeps its 34px. */
export function ToggleRow({
  name, label, hint, defaultChecked, badge,
}: { name: string; label: string; hint: string; defaultChecked?: boolean; badge?: ReactNode }) {
  return (
    <label className="group flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 border-b border-row px-[18px] py-[13px]">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="peer sr-only" />
      <span className="flex flex-[0_0_200px] items-center gap-2 text-[13px] font-medium">{label}{badge}</span>
      <span className="min-w-0 flex-[1_1_160px] text-meta text-muted">{hint}</span>
      <span className="flex h-5 w-[34px] shrink-0 rounded-full bg-[#d3d7e0] p-[2px] peer-checked:bg-brand-500">
        {/* `peer-checked` only matches true siblings of the checkbox — this
            knob is a child of the track span above, one level too deep, so
            peer-checked never applied and the knob never visibly moved,
            only the track's background did (UX audit's #4 finding — the
            same class of bug already fixed in ui.tsx's Toggle and the
            inline toggle in account.tsx; this row had drifted from that
            pattern). group-has-checked reaches into descendants via
            `:has()` on the <label>, which does match here. */}
        <span className="h-4 w-4 rounded-full bg-white shadow-[0_1px_2px_rgba(16,24,40,.2)] transition-transform group-has-checked:translate-x-[14px]" />
      </span>
    </label>
  );
}

/* Segmented control for 2-3 short options (week start, % vs £). `labels` is
   optional display text keyed by option — added for the first real consumer
   (visit-summary default language), whose stored values ("auto"/"nl"/"en")
   aren't fit to show a merchant directly ("Detect automatically"/
   "Nederlands"/"English" is). Omitting it keeps every option's raw value as
   its own label, unchanged from before. */
export function Segmented({
  name, options, value, labels,
}: { name: string; options: string[]; value: string; labels?: Record<string, string> }) {
  return (
    <div className="flex w-fit gap-[2px] rounded-[9px] bg-[#efecf4] p-[2px]">
      {options.map((o) => (
        <label key={o} className={`cursor-pointer rounded-[7px] px-3 py-[5px] text-meta ${
          o === value ? "bg-surface font-semibold shadow-card" : "font-medium text-muted"
        }`}>
          <input type="radio" name={name} value={o} defaultChecked={o === value} className="sr-only" />
          {labels?.[o] ?? o}
        </label>
      ))}
    </div>
  );
}

/* Card + footer with the page's own save button and feedback. `onSubmit`
   is for pages whose save is a client SDK call (Clerk), not a server
   action — when given, it replaces the default real POST (still
   `preventDefault()`-driven by the caller, so nothing here changes). */
export function SettingsCard({
  title, subtitle, saveLabel, savedAt, error, onSubmit, children,
}: {
  title?: string; subtitle?: string; saveLabel: string;
  savedAt?: string; error?: string; onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
  return (
    <form method="post" onSubmit={onSubmit} className="card">
      {title ? (
        <div className="flex flex-col gap-[2px] border-b border-line px-[18px] py-[13px]">
          <h2 className="m-0 text-[14px] font-semibold">{title}</h2>
          {subtitle ? <p className="m-0 text-meta text-muted">{subtitle}</p> : null}
        </div>
      ) : null}
      {children}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-canvas-alt px-[18px] py-3">
        {error ? (
          <span className="flex items-center gap-[7px] text-meta font-medium text-danger">
            <span className="inline-flex h-[15px] w-[15px] items-center justify-center rounded-full bg-danger text-[9px] text-white">!</span>
            {error}
          </span>
        ) : savedAt ? (
          <span className="alert-success">
            <span className="inline-flex h-[15px] w-[15px] items-center justify-center rounded-full bg-ok text-[9px] text-white">✓</span>
            Saved {savedAt}
          </span>
        ) : <span />}
        <button className="btn-pri">{saveLabel}</button>
      </div>
    </form>
  );
}

/* ==================================================================
   Team management (Settings › Team, cloud/app/routes/
   dashboard.$connectionId.settings.tsx, and the /invite/:token accept
   route) — see docs/team-management-spec.md (role matrix, edge cases) and
   docs/team-ui-spec.md (these exact screen states/copy). §0 of the UI spec
   is the load-bearing decision throughout: a control that would 404 on
   submit is removed from the DOM for a write/read viewer, never disabled.
   ================================================================== */

export type Role = "owner" | "admin" | "write" | "read";

const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", write: "Write", read: "Read" };

/** Fires `message(fetcher.data)` once a useFetcher submission this component owns settles back to idle — the shared bit behind every row-level toast below (role changed, member removed, invite resent/revoked). Returns null from `message` to stay silent (e.g. a failed submission with no fetcher.data yet). Takes the fetcher structurally (not via useFetcher's own generic) since useFetcher<T>().data is typed SerializeFrom<T>, not T. */
function useFetcherToast<Data>(fetcher: { state: string; data: Data | undefined }, message: (data: Data) => string | null) {
  const toast = useToast();
  const wasActive = useRef(false);
  useEffect(() => {
    if (fetcher.state !== "idle") {
      wasActive.current = true;
      return;
    }
    if (!wasActive.current) return;
    wasActive.current = false;
    if (fetcher.data) {
      const text = message(fetcher.data);
      if (text) toast(text);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state]);
}

/* Small role indicator — used wherever a role needs to be *shown* but not
   *changed*: the Owner row (any viewer), every row for a write/read
   viewer (§0 — hidden select, not disabled), and the invite-accept page's
   "join with {Role} access" line. Owner gets the same brand-tinted
   treatment PresetFieldBadge already uses for "Customized" so it reads as
   "special", not just another neutral badge. */
export function RoleBadge({ role }: { role: Role }) {
  return (
    <span className={role === "owner" ? "badge bg-brand-50 text-brand-600" : "badge-neutral"}>
      {ROLE_LABEL[role]}
    </span>
  );
}

/* Member row — one per active ConnectionMember. The Owner row never gets a
   select or a Remove control, for ANY viewer — role is always shown as
   RoleBadge and no action renders (BA edge case 3.4: this is defense in
   depth, the server-side reject in Team.updateMemberRole/removeMember is
   the real guarantee). For a write/read viewer, pass canManage={false}:
   role renders as RoleBadge instead of a <select>, and Remove doesn't
   render at all. The text column must CLIP, not just shrink — `min-w-0`
   alone lets glyphs paint over the badge; truncate is what fixes it. */
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
  const roleFetcher = useFetcher<{ saved?: boolean; role?: Role }>();
  const removeFetcher = useFetcher<{ saved?: boolean }>();
  const isOwner = role === "owner";
  const dialogId = `remove-member-${userId}`;

  useFetcherToast(roleFetcher, (data) => (data.saved && data.role ? `${name}'s role changed to ${ROLE_LABEL[data.role]}.` : null));
  useFetcherToast(removeFetcher, (data) => {
    if (!data.saved) return null;
    (document.getElementById(dialogId) as HTMLDialogElement | null)?.close();
    return `${name} removed from the team.`;
  });

  // Optimistic role: reflect the in-flight submission immediately, same
  // pattern as this file's own MessageRow/toggleFetcher (route file,
  // dashboard.$connectionId.settings.tsx's MessageRow).
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

/* Pending-invite row — distinct from MemberRow (not an extension of it): a
   pending invite has no user account yet (no initials-from-a-real-name, no
   Owner special-case, no role select to change in place — the fix for
   "wrong role" is Revoke + re-invite, not an inline edit), and carries two
   actions MemberRow never has (Resend/Revoke) instead of one (Remove).
   This whole page only renders it when canManage is true (the Pending
   Invites card doesn't exist for write/read at all), so there's no
   read-only variant to keep in sync with MemberRow's. */
export function PendingInviteRow({
  inviteId, email, role, invitedAt,
}: {
  inviteId: string;
  email: string;
  role: Exclude<Role, "owner">;
  /** Pre-formatted server-side, e.g. "Aug 27, 2026". */
  invitedAt: string;
}) {
  const resendFetcher = useFetcher<{ saved?: boolean; inviteSent?: boolean; invitedEmail?: string; emailSent?: boolean }>();
  const revokeFetcher = useFetcher<{ saved?: boolean }>();
  const dialogId = `revoke-invite-${inviteId}`;
  const resending = resendFetcher.state !== "idle";

  useFetcherToast(resendFetcher, (data) => {
    if (!data.saved) return null;
    return data.emailSent === false
      ? `Invite refreshed for ${email}, but the email couldn't be sent — try Resend again.`
      : `Invite re-sent to ${email}.`;
  });
  useFetcherToast(revokeFetcher, (data) => {
    if (!data.saved) return null;
    (document.getElementById(dialogId) as HTMLDialogElement | null)?.close();
    return `Invite to ${email} revoked.`;
  });

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

/* Invite form. Uses react-router's <Form> (not a bare <form>, and not a
   fetcher) so useNavigation() in the route component can drive `pending`
   and know when the round trip settles for the toast — same reason
   page === "template"'s own section already upgrades to <Form> instead of
   the plain <form> every other SettingsCard section uses (route file's
   TemplateTab). `pending`/`error` are computed by the route from
   useNavigation()/actionData, the same way TemplateTab already derives
   `pending={navigation.state !== "idle"}` for its own <Form> submit — this
   component doesn't own its own fetcher. */
export function InviteMemberCard({ pending, error }: { pending: boolean; error?: string }) {
  return (
    <Form method="post" className="card">
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
    </Form>
  );
}

/* Read-only banner — Team page, write/read viewer only. */
export function TeamReadOnlyNotice() {
  return (
    <div className="flex items-center gap-3 rounded-[10px] border border-line bg-canvas-alt px-[15px] py-[13px] text-[13px] text-ink-2">
      You can see who has access, but only admins and the owner can invite, remove, or change someone's role. Ask an admin if you need something changed.
    </div>
  );
}

/* Team page's empty state — rendered inside the Team members card, below
   the owner's own row, only when there's no one else to show yet. */
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
   revoked / already-accepted / malformed token): a title, one sentence,
   and an optional single action. Lives in the same left-card slot
   signup.tsx/login.tsx use (`card w-full max-w-[372px] p-[26px]`), so
   invite.$token.tsx can drop this straight into that shell instead of
   rebuilding it four times. */
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
