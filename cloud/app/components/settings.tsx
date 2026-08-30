import type { ReactNode } from "react";

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
    { key: "integrations", label: "Integrations", path: "/settings?page=integrations", title: "Integrations", subtitle: "Connected channels and Shopify stores." },
    { key: "team", label: "Team", path: "/settings?page=team", title: "Team", subtitle: "Who can access this dashboard, and what they can do." },
  ]},
] as const;

export type SettingsKey = typeof SETTINGS_NAV[number]["items"][number]["key"];

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

      <div className="grid grid-cols-[minmax(0,168px)_minmax(0,1fr)] items-start gap-5">
        <nav className="sticky top-[26px] flex flex-col gap-[14px]">
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

/* Segmented control for 2-3 short options (week start, % vs £). */
export function Segmented({
  name, options, value,
}: { name: string; options: string[]; value: string }) {
  return (
    <div className="flex w-fit gap-[2px] rounded-[9px] bg-[#efecf4] p-[2px]">
      {options.map((o) => (
        <label key={o} className={`cursor-pointer rounded-[7px] px-3 py-[5px] text-meta ${
          o === value ? "bg-surface font-semibold shadow-card" : "font-medium text-muted"
        }`}>
          <input type="radio" name={name} value={o} defaultChecked={o === value} className="sr-only" />
          {o}
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

/* Member row — the text column must CLIP, not just shrink. `min-w-0`
   alone lets glyphs paint over the badge; truncate is what fixes it. */
export function MemberRow({
  name, email, initials, role, status, action,
}: {
  name: string; email: string; initials: string; role: string;
  status: "Active" | "Invited"; action?: { label: string; danger?: boolean };
}) {
  return (
    <div className="flex items-center gap-3 border-b border-row px-[18px] py-3">
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#efecf4] text-[11px] font-semibold text-ink-3">{initials}</span>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <span className="truncate text-[13px] font-medium">{name}</span>
        <span className="truncate text-[12px] text-subtle">{email}</span>
      </div>
      <span className={`shrink-0 ${status === "Active" ? "badge-ok" : "badge-pending"}`}>{status}</span>
      <select defaultValue={role} className="shrink-0 rounded-[7px] border border-line-strong bg-surface px-[9px] py-[6px] text-meta">
        <option>Owner</option><option>Manager</option><option>Staff</option>
      </select>
      {action ? (
        <button className={`btn-link shrink-0 ${action.danger ? "text-danger" : "text-brand-600"}`}>{action.label}</button>
      ) : null}
    </div>
  );
}
