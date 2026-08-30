import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useClerk } from "@clerk/react-router";
import { LogoMark } from "./onboarding";

/* ------------------------------------------------------------------ */
/* Button — <Button variant="primary">Save</Button> or as={Link}      */
/* ------------------------------------------------------------------ */
const BTN = {
  primary: "btn-pri",
  secondary: "btn-sec",
  destructive: "btn-del",
  ghost: "btn-ghost",
} as const;

export function Button({
  variant = "secondary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BTN }) {
  return <button {...props} className={`${BTN[variant]} ${className}`} />;
}

/* ------------------------------------------------------------------ */
/* LogoutButton — ends the Clerk identity session client-side first     */
/* (routes/logout.tsx only clears the leftover gb_session/TenantSession */
/* cookie; it doesn't itself terminate Clerk's own session), then       */
/* navigates there to clean that up and land on /login.                 */
/* ------------------------------------------------------------------ */
export function LogoutButton({ className = "btn-ghost", children = "Log out" }: { className?: string; children?: ReactNode }) {
  const { signOut } = useClerk();
  const navigate = useNavigate();
  return (
    <button type="button" className={className} onClick={() => signOut(() => navigate("/logout"))}>
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* GoogleIcon — for "Continue with Google" buttons (login/signup)      */
/* ------------------------------------------------------------------ */
export function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.87 2.7-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.83.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.95v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.95A9 9 0 0 0 0 9c0 1.45.35 2.83.95 4.03l3-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .95 4.97l3 2.33C4.66 5.17 6.65 3.58 9 3.58Z" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* PageHeader                                                          */
/* ------------------------------------------------------------------ */
export function PageHeader({
  title,
  subtitle,
  actions,
}: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-5">
      <div className="flex flex-col gap-[5px]">
        <h1 className="page-title">{title}</h1>
        {subtitle ? <p className="page-sub">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Badge — status is semantic, never brand-coloured                    */
/* ------------------------------------------------------------------ */
const STATUS = {
  confirmed: ["badge-ok", "Confirmed"],
  pending: ["badge-pending", "Pending"],
  completed: ["badge-ok", "Completed"],
  cancelled: ["badge-neutral", "Cancelled"],
  declined: ["badge-neutral", "Declined"],
  no_show: ["badge-danger", "No-show"],
  paid: ["badge-ok", "Paid"],
  deposit: ["badge-pending", "Deposit"],
  not_required: ["badge-neutral", "No payment"],
  unpaid: ["badge-neutral", "Unpaid"],
  refunded: ["badge-neutral", "Refunded"],
  failed: ["badge-danger", "Failed"],
  waiting: ["badge-neutral", "Waiting"],
  offered: ["badge-pending", "Offered"],
  claimed: ["badge-ok", "Claimed"],
  expired: ["badge-danger", "Expired"],
} as const;

export function Badge({
  status,
  label,
  dot = false,
}: { status: keyof typeof STATUS; label?: string; dot?: boolean }) {
  const [cls, fallback] = STATUS[status] ?? STATUS.cancelled;
  return (
    <span className={cls}>
      {dot ? <span className="badge-dot" /> : null}
      {label ?? fallback}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* StatCard                                                            */
/* ------------------------------------------------------------------ */
export function StatCard({
  label,
  value,
  note,
  tone = "muted",
}: { label: string; value: string; note?: string; tone?: "muted" | "ok" | "warn" | "danger" }) {
  const noteTone = {
    muted: "text-muted",
    ok: "text-ok font-medium",
    warn: "text-warn font-medium",
    danger: "text-danger font-medium",
  }[tone];
  return (
    <div className="flex flex-col gap-[9px] rounded-card border border-line bg-surface px-[18px] py-4 shadow-card">
      <div className="text-[12px] font-medium text-muted">{label}</div>
      <div className="num text-stat font-medium tracking-[-0.03em]">{value}</div>
      {note ? <div className={`text-[12px] ${noteTone}`}>{note}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Field — label + control + hint/error                                */
/* ------------------------------------------------------------------ */
export function Field({
  label,
  hint,
  error,
  children,
}: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className={`field-label ${error ? "text-danger" : ""}`}>{label}</span>
      {children}
      {error ? (
        <span className="field-error">
          <span className="inline-flex h-[13px] w-[13px] items-center justify-center rounded-full bg-danger text-[9px] text-white">!</span>
          {error}
        </span>
      ) : hint ? (
        <span className="field-hint">{hint}</span>
      ) : null}
    </label>
  );
}

export function Input({
  error,
  className = "",
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { error?: boolean }) {
  return <input {...props} className={`input ${error ? "input-error" : ""} ${className}`} />;
}

/* ------------------------------------------------------------------ */
/* AlertError — every form's failure banner. role="alert" +            */
/* aria-live so a screen reader actually hears it (axe: A4), and it    */
/* scrolls itself into view on mount so a banner that renders above    */
/* the fold — with the submit button below it — doesn't look like the  */
/* click did nothing (see the UX audit's B5 finding).                  */
/* ------------------------------------------------------------------ */
export function AlertError({ children, className = "" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);
  return (
    <div ref={ref} role="alert" aria-live="assertive" className={`alert-error ${className}`}>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* TimezoneSelect — replaces free-text timezone entry (onboarding,     */
/* Settings › General). A typo like "banana/notatimezone" used to save */
/* silently (UX audit's V1) — a <select> of real IANA zones makes that */
/* impossible, and it defaults to the browser's own zone.              */
/* ------------------------------------------------------------------ */
const TIMEZONES: string[] =
  typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["UTC"];

export function TimezoneSelect({
  name = "timezone",
  value,
  onChange,
  defaultValue,
}: { name?: string; value?: string; onChange?: (tz: string) => void; defaultValue?: string }) {
  return (
    <select
      name={name}
      className="input cursor-pointer"
      {...(value !== undefined ? { value } : { defaultValue })}
      onChange={onChange ? (e) => onChange(e.target.value) : undefined}
    >
      {value && !TIMEZONES.includes(value) ? <option value={value}>{value}</option> : null}
      {TIMEZONES.map((tz) => (
        <option key={tz} value={tz}>{tz.replace(/_/g, " ")}</option>
      ))}
    </select>
  );
}

/* ------------------------------------------------------------------ */
/* DataTable — CSS-grid rows so cells stay aligned and rows can be     */
/* whole links. `cols` is a grid-template-columns value.               */
/* ------------------------------------------------------------------ */
export function DataTable<T>({
  cols,
  columns,
  rows,
  rowKey,
  renderRow,
  mobileCard,
  href,
  empty,
  footer,
  compact = false,
}: {
  cols: string;
  columns: string[];
  rows: T[];
  rowKey: (row: T) => string;
  renderRow: (row: T) => ReactNode[];
  // Opt-in stacked-card layout below 640px, swapped in for the grid row
  // instead of it (rather than compressing every fixed-width column into a
  // 382px screen — a five-column row wrapped mid-word and its chevron
  // affordance sat half off the card edge, UX audit's S1 finding). Each
  // <Row>/card pair below is one data row wrapped in its own visibility
  // toggle, not a shared grid, so this can't disturb either layout's own
  // column sizing.
  mobileCard?: (row: T) => ReactNode;
  href?: (row: T) => string;
  empty?: ReactNode;
  footer?: ReactNode;
  compact?: boolean;
}) {
  const Row = href ? "a" : "div";
  return (
    <div className="card">
      <div className={mobileCard ? "hidden sm:block" : undefined}>
        <div className="thead" style={{ gridTemplateColumns: cols }}>
          {columns.map((c) => (
            <div key={c} className={c ? "th" : ""}>{c}</div>
          ))}
        </div>
      </div>

      {rows.map((row) => (
        <div key={rowKey(row)}>
          <div className={mobileCard ? "hidden sm:block" : undefined}>
            <Row
              {...(href ? { href: href(row) } : {})}
              className={`trow no-underline text-ink hover:no-underline ${compact ? "trow-compact" : ""} ${href ? "cursor-pointer" : ""}`}
              style={{ gridTemplateColumns: cols }}
            >
              {renderRow(row).map((cell, i) => (
                <div key={i} className="min-w-0">{cell}</div>
              ))}
            </Row>
          </div>
          {mobileCard && (
            <Row
              {...(href ? { href: href(row) } : {})}
              className={`flex sm:hidden flex-col gap-1 no-underline text-ink hover:no-underline border-b border-row px-4 py-[13px] text-[13px] hover:bg-canvas-alt ${href ? "cursor-pointer" : ""}`}
            >
              {mobileCard(row)}
            </Row>
          )}
        </div>
      ))}

      {rows.length === 0 ? empty : null}
      {footer ? <div className="tfoot">{footer}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* EmptyState                                                          */
/* ------------------------------------------------------------------ */
export function EmptyState({
  icon,
  title,
  body,
  action,
}: { icon?: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-[10px] px-5 py-14 text-center">
      {icon ? (
        <div className="flex h-11 w-11 items-center justify-center rounded-[12px] bg-row text-subtle">{icon}</div>
      ) : null}
      <div className="text-card font-semibold">{title}</div>
      {body ? <div className="max-w-[340px] text-[13px] text-muted">{body}</div> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Toggle — used by weekly-hours rows and notification settings.       */
/* Renders a real checkbox so forms still post without JS.             */
/* ------------------------------------------------------------------ */
export function Toggle({
  name,
  value,
  defaultChecked,
  label,
  onChange,
}: {
  name: string;
  value?: string;
  defaultChecked?: boolean;
  label?: string;
  onChange?: (checked: boolean) => void;
}) {
  return (
    <label className="group inline-flex cursor-pointer items-center gap-[10px]">
      <input
        type="checkbox"
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        onChange={onChange ? (e) => onChange(e.currentTarget.checked) : undefined}
        className="peer sr-only"
      />
      <span className="flex h-[19px] w-[32px] rounded-full bg-[#d3d7e0] p-[2px] transition-colors peer-checked:bg-brand-500">
        {/* `peer-checked` only matches true siblings of the checkbox — this
            knob is a child of the track span above, one level too deep, so
            peer-checked never applied to it and the knob never moved (only
            the track's own background did). group-has-checked reaches into
            descendants via `:has()` on the <label>, which does match here. */}
        <span className="h-[15px] w-[15px] rounded-full bg-white shadow-[0_1px_2px_rgba(16,24,40,.2)] transition-transform group-has-checked:translate-x-[13px]" />
      </span>
      {label ? <span className="text-body font-medium text-subtle peer-checked:text-ink">{label}</span> : null}
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* CheckCard — service-assignment checklist item (progressive: real    */
/* checkbox, styling via peer)                                         */
/* ------------------------------------------------------------------ */
export function CheckCard({
  name,
  value,
  label,
  meta,
  defaultChecked,
}: { name: string; value: string; label: string; meta?: string; defaultChecked?: boolean }) {
  return (
    <label className="flex cursor-pointer items-center gap-[10px] rounded-[9px] border border-[#e2e4ea] bg-surface px-3 py-[10px] has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50">
      <input type="checkbox" name={name} value={value} defaultChecked={defaultChecked} className="peer sr-only" />
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-[5px] border border-[#c9cdd8] text-[10px] text-white peer-checked:border-brand-600 peer-checked:bg-brand-600 peer-checked:after:content-['✓']" />
      <span className="text-body font-medium">{label}</span>
      {meta ? <span className="num ml-auto text-[11.5px] text-subtle">{meta}</span> : null}
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Bar chart — no charting library. `data` is {date,count}[].          */
/* ------------------------------------------------------------------ */
export function BarChart({
  data,
  highlightLast = 3,
}: { data: { date: string; count: number }[]; highlightLast?: number }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="flex flex-col gap-4">
      <div className="relative h-[172px] border-b border-line">
        <div className="absolute inset-0 flex flex-col justify-between">
          {[0, 1, 2, 3].map((i) => <div key={i} className="border-t border-dashed border-row" />)}
        </div>
        <div className="absolute inset-0 flex items-end gap-1">
          {data.map((d, i) => (
            <div
              key={d.date}
              title={`${d.date}: ${d.count}`}
              className={`min-h-[3px] flex-1 rounded-t-[3px] hover:brightness-90 ${
                i >= data.length - highlightLast ? "bg-brand-500" : "bg-brand-200"
              }`}
              style={{ height: `${Math.round((d.count / max) * 100)}%` }}
            />
          ))}
        </div>
      </div>
      <div className="num flex justify-between text-[10.5px] text-subtle">
        <span>{data[0]?.date}</span>
        <span>{data[Math.floor(data.length / 2)]?.date}</span>
        <span>{data[data.length - 1]?.date}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* MeterRow — resource utilisation / top-services bars                 */
/* ------------------------------------------------------------------ */
export function MeterRow({
  name,
  meta,
  ratio,
  right,
}: { name: string; meta?: string; ratio: number; right?: string }) {
  const pct = Math.round(ratio * 100);
  const fill = pct > 80 ? "bg-chart-warn" : pct > 50 ? "bg-brand-500" : "bg-chart-off";
  return (
    <div className="grid grid-cols-[168px_1fr_92px] items-center gap-4">
      <div className="flex min-w-0 flex-col gap-[2px]">
        <span className="truncate text-[13px] font-medium">{name}</span>
        {meta ? <span className="num text-[11px] text-subtle">{meta}</span> : null}
      </div>
      <div className="h-2 rounded-[5px] bg-row">
        <div className={`h-2 rounded-[5px] ${fill}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="num text-right text-[13px]">{right ?? `${pct}%`}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ConfirmDialog — native <dialog>; degrades to a normal submit button */
/* when JS is off (render the form outside too, or keep the fallback   */
/* link to a /confirm route).                                          */
/* ------------------------------------------------------------------ */
export function ConfirmDialog({
  id,
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  children,
}: {
  id: string;
  title: string;
  body: string;
  confirmLabel: string;
  // Hardcoded "Keep booking" regardless of what was actually being
  // confirmed — removing a time-off block or deleting a resource got a
  // cancel button that named the wrong object entirely (pass 7's N3
  // finding). Defaults to the generic "Cancel"; only the one dialog this
  // was written for still has something more specific to say.
  cancelLabel?: string;
  children?: ReactNode;
}) {
  // Confirm submits the form passed as `children` via HTML's `form=` attribute
  // (works regardless of DOM nesting) — that form's id must be `${id}-form`.
  // `m-auto`: a native <dialog> centers itself via the UA stylesheet's own
  // `margin: auto`, but Tailwind's preflight zeroes margin on every element
  // — including <dialog> — so without this it opened pinned to the
  // top-left corner instead (UX audit's S1 finding).
  return (
    <dialog
      id={id}
      className="m-auto w-full max-w-[420px] rounded-modal p-0 shadow-modal backdrop:bg-[rgba(19,17,24,0.42)]"
    >
      <div className="flex flex-col gap-4 p-[22px]">
        <div className="flex gap-3">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-danger-bg text-[15px] text-danger">!</span>
          <div className="flex flex-col gap-1">
            <h2 className="m-0 text-[16px] font-semibold">{title}</h2>
            <p className="m-0 text-[13px] leading-normal text-muted">{body}</p>
          </div>
        </div>
        {children}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="btn-sec"
            onClick={(e) => (e.currentTarget.closest("dialog") as HTMLDialogElement | null)?.close()}
          >
            {cancelLabel}
          </button>
          <button
            form={`${id}-form`}
            type="submit"
            className="btn rounded-field bg-danger font-semibold text-white hover:bg-[#9a1e14]"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

/* ------------------------------------------------------------------ */
/* LegalShell — chrome shared by privacy.tsx / terms.tsx / support.tsx.
   Same .mkt-* marketing tokens as _index.tsx so these public pages read
   as one site, not a bolted-on legal doc.                              */
/* ------------------------------------------------------------------ */
export function LegalShell({
  title, updated, children,
}: { title: string; updated?: string; children: ReactNode }) {
  return (
    <div className="mkt-shell">
      <div className="mkt-bar">
        <div className="mkt-wrap flex h-[60px] items-center gap-7">
          <a href="/" className="flex items-center gap-[9px] no-underline hover:no-underline">
            <LogoMark size={26} />
            <span className="text-[14px] font-semibold text-ink">GetBooqin</span>
          </a>
          <a href="/" className="mkt-link ml-auto">← Back to home</a>
        </div>
      </div>

      <div className="mkt-wrap flex flex-col gap-6 py-16">
        <div className="flex max-w-[680px] flex-col gap-1">
          <h1 className="mkt-h2 text-[28px]">{title}</h1>
          {updated ? <p className="m-0 text-meta text-subtle">Last updated: {updated}</p> : null}
        </div>
        <div className="legal-copy flex max-w-[680px] flex-col gap-4 text-[14.5px] leading-relaxed text-ink-3">
          {children}
        </div>
      </div>

      <LegalFooter />
    </div>
  );
}

export function LegalFooter() {
  return (
    <footer className="border-t border-line">
      <div className="mkt-wrap flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-7">
        <span className="flex items-center gap-[9px]">
          <LogoMark size={22} />
          <span className="text-[13px] font-medium text-muted">GetBooqin</span>
        </span>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
          <a href="/legal/privacy" className="mkt-link">Privacy</a>
          <a href="/legal/terms" className="mkt-link">Terms</a>
          <a href="/support" className="mkt-link">Support</a>
          <span className="text-[12.5px] text-subtle">© {new Date().getFullYear()} GetBooqin</span>
        </div>
      </div>
    </footer>
  );
}

/* ------------------------------------------------------------------ */
/* ThemeToggle — light is the default regardless of the OS setting;
   this is purely opt-in to dark. Reads/writes localStorage directly
   rather than any shared app state: there's no server-side session
   concept for "theme" and no other component needs to react to it —
   app.css's :root[data-theme="dark"] rules pick it up purely from the
   DOM attribute this sets. root.tsx's inline bootstrap script applies a
   stored choice before first paint; this component only needs to
   handle *changes* after that.

   Starts at null ("unknown") rather than reading localStorage
   synchronously — that value can differ between the server (which has
   none) and the client, and rendering it on first client render, before
   hydration reconciles, would still be a hydration mismatch. The real
   value arrives one effect tick later; the placeholder button below
   keeps that from shifting layout.                                     */
/* ------------------------------------------------------------------ */
export function ThemeToggle({
  className = "btn-sec px-[9px] py-[7px]", showLabel = false,
}: { className?: string; showLabel?: boolean }) {
  const [theme, setThemeState] = useState<"light" | "dark" | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem("gb-theme");
    setThemeState(stored === "dark" ? "dark" : "light");
  }, []);

  function setTheme(next: "light" | "dark") {
    setThemeState(next);
    try {
      localStorage.setItem("gb-theme", next);
    } catch {
      // Private browsing etc. — the toggle still works for this page load,
      // it just won't be remembered next visit.
    }
    document.documentElement.setAttribute("data-theme", next);
  }

  if (theme === null) {
    return <span className={`${className} invisible`} aria-hidden="true" />;
  }

  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  const icon =
    theme === "dark" ? (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0">
        <circle cx="8" cy="8" r="3.5" />
        <path d="M8 1.5v1.4M8 13.1v1.4M14.5 8h-1.4M2.9 8H1.5M12.5 3.5l-1 1M4.5 11.5l-1 1M12.5 12.5l-1-1M4.5 4.5l-1-1" strokeLinecap="round" />
      </svg>
    ) : (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0">
        <path d="M13.7 9.3A5.8 5.8 0 0 1 6.7 2.3a5.8 5.8 0 1 0 7 7Z" strokeLinejoin="round" />
      </svg>
    );

  return (
    <button
      type="button"
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      className={className}
      aria-label={showLabel ? undefined : label}
      title={label}
    >
      {icon}
      {showLabel ? label.replace("Switch to ", "").replace(" theme", " mode") : null}
    </button>
  );
}
