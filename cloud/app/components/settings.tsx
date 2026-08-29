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
   for visual continuity but link out to /dashboard/account — that route
   is identity-scoped (one user, many stores), this one is per-connection,
   see components/account.tsx's UserMenu comment for why they're split.
   ================================================================== */

export const SETTINGS_NAV = [
  { group: "Account", items: [
    { key: "profile", label: "Profile", href: "/dashboard/account", title: "Account", subtitle: "Your personal details. Business-wide settings are below." },
    { key: "security", label: "Password & security", href: "/dashboard/account?tab=security", title: "Account", subtitle: "Your personal details. Business-wide settings are below." },
  ]},
  { group: "Business", items: [
    { key: "general", label: "General", title: "General", subtitle: "Business identity and how time is displayed." },
    { key: "template", label: "Business template", title: "Business template", subtitle: "Industry preset, vocabulary and which Overview cards show." },
    { key: "rules", label: "Booking rules", title: "Booking rules", subtitle: "When customers can book, and what happens automatically." },
    { key: "notifications", label: "Notifications", title: "Notifications", subtitle: "Emails sent to customers and staff." },
    { key: "payments", label: "Payments", title: "Payments", subtitle: "How money is collected for bookings." },
    { key: "integrations", label: "Integrations", title: "Integrations", subtitle: "Connected channels and Shopify stores." },
    { key: "team", label: "Team", title: "Team", subtitle: "Who can access this dashboard, and what they can do." },
  ]},
] as const;

export type SettingsKey = typeof SETTINGS_NAV[number]["items"][number]["key"];

export function settingsMeta(key: string) {
  for (const g of SETTINGS_NAV) {
    const hit = g.items.find((i) => i.key === key);
    if (hit) return hit;
  }
  return SETTINGS_NAV[1].items[0];
}

export function SettingsShell({
  active, hide, businessBaseHref = "", children,
}: {
  active: SettingsKey; hide?: SettingsKey[];
  // Business-group items have no explicit href — they link with a plain
  // `?page=key`, which only resolves correctly when this shell is already
  // rendered from the settings route itself. Rendered from the identity-
  // scoped /dashboard/account instead (see the Account-item comment
  // above), that same relative link would just tack ?page= onto /dashboard/
  // account — pass the current store's settings base ("/dashboard/:id/
  // settings") here so those links resolve to the right place.
  businessBaseHref?: string;
  children: ReactNode;
}) {
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
                  <a key={i.key} href={"href" in i ? i.href : `${businessBaseHref}?page=${i.key}`}
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
   control has its own stacked hint (e.g. password strength).          */
/* ------------------------------------------------------------------ */
export function Row({
  label, hint, align = "center", children,
}: { label: string; hint?: string; align?: "center" | "start"; children: ReactNode }) {
  return (
    <div className={`grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-x-6 gap-y-2 border-b border-row px-[18px] py-[14px] ${
      align === "start" ? "items-start" : "items-center"
    }`}>
      <div className="flex flex-col gap-[2px]">
        <span className="text-[13px] font-medium">{label}</span>
        {hint ? <span className="text-[12px] text-subtle">{hint}</span> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
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
  name, label, hint, defaultChecked,
}: { name: string; label: string; hint: string; defaultChecked?: boolean }) {
  return (
    <label className="flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 border-b border-row px-[18px] py-[13px]">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="peer sr-only" />
      <span className="flex-[0_0_200px] text-[13px] font-medium">{label}</span>
      <span className="min-w-0 flex-[1_1_160px] text-meta text-muted">{hint}</span>
      <span className="flex h-5 w-[34px] shrink-0 rounded-full bg-[#d3d7e0] p-[2px] peer-checked:bg-brand-500">
        <span className="h-4 w-4 rounded-full bg-white shadow-[0_1px_2px_rgba(16,24,40,.2)] transition-transform peer-checked:translate-x-[14px]" />
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
