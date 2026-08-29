import { useState, type ReactNode } from "react";
import { PRESETS, getPreset, type PresetId } from "../lib/presets";
import { LogoutButton } from "./ui";

/* ==================================================================
   1. User menu — sidebar footer popover
   The popover itself is <details>, which needs no state and closes on
   outside click in modern browsers via the `name` attribute (exclusive
   accordion) or Escape. Profile/security live under the top-level
   /dashboard/account route (one identity, many stores) rather than nested
   under :connectionId, so those two links are absolute; only "Business
   settings" is per-store.
   ================================================================== */
export function UserMenu({
  name, email, role, initials, dark = false, settingsHref = "/dashboard",
}: { name: string; email: string; role: string; initials: string; dark?: boolean; settingsHref?: string }) {
  return (
    <details className="group relative mt-auto border-t border-line open:bg-row/50 [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex cursor-pointer list-none items-center gap-[9px] rounded-[9px] p-[10px]">
        <span className={`inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
          dark ? "bg-white/[0.09] text-[#ece9f0]" : "bg-line text-ink-3"
        }`}>{initials}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-meta font-medium">{name}</span>
          <span className="block text-[11px] text-subtle">{role}</span>
        </span>
        <span className="text-[11px] text-subtle transition-transform group-open:rotate-180">⌄</span>
      </summary>

      <div className="absolute inset-x-[6px] bottom-[calc(100%+6px)] z-20 flex flex-col gap-px rounded-[11px] border border-line bg-surface p-[5px] shadow-[0_12px_34px_rgba(16,24,40,.18)]">
        <div className="flex flex-col gap-px px-[10px] pt-[9px] pb-[7px]">
          <span className="text-meta font-semibold text-ink">{name}</span>
          <span className="text-[11.5px] text-subtle">{email}</span>
        </div>
        <div className="my-[2px] h-px bg-row" />
        <MenuLink href="/dashboard/account">Profile settings</MenuLink>
        <MenuLink href="/dashboard/account?tab=security">Password &amp; security</MenuLink>
        <MenuLink href={settingsHref}>Business settings</MenuLink>
        <div className="my-[2px] h-px bg-row" />
        {/* Nothing signed-in linked here at all — no Help, no Support, no
            FAQ, no contact. A merchant stuck at 7pm had no route to a
            human even though /support already exists (UX audit's U3
            finding). */}
        <MenuLink href="/support">Help &amp; support</MenuLink>
        <div className="my-[2px] h-px bg-row" />
        {/* Was a raw <form method="post" action="/logout">, which crashed:
            logout.tsx only exports a loader, not an action, and (worse)
            skipped ending the actual Clerk identity session — that only
            happens client-side via signOut(), which is what routes/
            logout.tsx's own loader comment already assumes ran first. Every
            other logout entry point already went through LogoutButton;
            this was the one place that didn't. */}
        <LogoutButton className="flex w-full cursor-pointer items-center gap-[9px] rounded-field px-[10px] py-2 text-left text-[13px] font-medium text-danger hover:bg-danger-bg" />
      </div>
    </details>
  );
}

function MenuLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="flex items-center gap-[9px] rounded-field px-[10px] py-2 text-[13px] text-ink-2 no-underline max-md:min-h-[44px] hover:bg-canvas hover:no-underline">
      {children}
    </a>
  );
}

/* ==================================================================
   2. Social sign-in buttons (login.tsx / signup.tsx)
   Real POST forms to the OAuth start routes — no client JS needed.
   ================================================================== */
export function SocialAuth({ label = "Continue" }: { label?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <form method="post" action="/auth/google">
        <button className="flex w-full cursor-pointer items-center justify-center gap-[9px] rounded-[9px] border border-line-strong px-[14px] py-[10px] text-body font-medium hover:bg-canvas">
          <GoogleGlyph /> {label} with Google
        </button>
      </form>
      <form method="post" action="/auth/shopify">
        <button className="flex w-full cursor-pointer items-center justify-center gap-[9px] rounded-[9px] border border-line-strong px-[14px] py-[10px] text-body font-medium hover:bg-canvas">
          <span className="inline-flex h-4 w-4 items-center justify-center rounded-[4px] bg-[#5a8f3d] text-[10px] font-bold text-white">S</span>
          {label} with Shopify
        </button>
      </form>
    </div>
  );
}

export function GoogleGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.34A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3.01-2.34z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.94l3.01 2.34C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}

/* Login-only row under the password field. "Keep me signed in" reflects
   this Clerk instance's default session lifetime — there's no
   per-sign-in override in the client SDK, so it's an affordance, not a
   separate code path. */
export function LoginOptions() {
  return (
    <div className="-mt-[6px] flex items-center justify-between gap-3">
      <label className="flex cursor-pointer items-center gap-[7px] text-meta text-ink-2">
        <input type="checkbox" name="remember" defaultChecked className="h-[14px] w-[14px] accent-brand-600" />
        Keep me signed in
      </label>
      <a href="/forgot-password" className="text-meta font-medium text-brand-600">Forgot password?</a>
    </div>
  );
}

/* ==================================================================
   3. Password strength meter (account?tab=security, forgot-password)
   Purely presentational; server still validates. Below the real 15-char
   minimum (Clerk's own instance policy — UX audit's B4 finding) a
   password can only ever read "Weak", never "Fair" or better: the old
   scorePassword() called an 8-character string "Fair", which is exactly
   what the server was about to reject.
   ================================================================== */
const MIN_PASSWORD_LENGTH = 15;
const PW_STEPS = [
  { label: "", cls: "bg-row", text: "text-subtle", w: "0%" },
  { label: "Weak", cls: "bg-danger", text: "text-danger", w: "25%" },
  { label: "Fair", cls: "bg-warn", text: "text-warn", w: "50%" },
  { label: "Good", cls: "bg-ok", text: "text-ok", w: "75%" },
  { label: "Strong", cls: "bg-ok", text: "text-ok", w: "100%" },
];

export function scorePassword(pw: string) {
  if (!pw) return 0;
  if (pw.length < MIN_PASSWORD_LENGTH) return 1; // Weak — server will reject this regardless
  const variety = (/[0-9]/.test(pw) ? 1 : 0) + (/[^A-Za-z0-9]/.test(pw) ? 1 : 0) + (/[a-z]/.test(pw) && /[A-Z]/.test(pw) ? 1 : 0);
  return Math.min(4, 1 + variety);
}

export function PasswordField({
  name, label, hint, onChange, minLength = MIN_PASSWORD_LENGTH, autoComplete = "new-password", showMeter = true,
}: {
  name: string; label: string; hint?: string; onChange?: (value: string) => void;
  minLength?: number; autoComplete?: string; showMeter?: boolean;
}) {
  const [pw, setPw] = useState("");
  const step = PW_STEPS[scorePassword(pw)];
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type="password"
        name={name}
        minLength={minLength}
        autoComplete={autoComplete}
        onChange={(e) => {
          setPw(e.target.value);
          onChange?.(e.target.value);
        }}
        className="input"
      />
      {showMeter && (
        <span className="flex items-center gap-2">
          <span className="h-[4px] flex-1 rounded-[3px] bg-row">
            <span className={`block h-[4px] rounded-[3px] transition-[width] ${step.cls}`} style={{ width: step.w }} />
          </span>
          <span className={`text-[11.5px] font-medium ${step.text}`}>{step.label}</span>
        </span>
      )}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

/* ==================================================================
   4. Linked sign-in method + session rows (account?tab=security)
   `onAction`, when given, renders a button so a Clerk client-SDK call can
   run instead of a form POST (there's no server route for either — Clerk
   owns this state). Falls back to a real POST form otherwise.
   ================================================================== */
export function AuthMethodRow({
  glyph, name, detail, connected, actionHref, onAction, busy,
}: {
  glyph: ReactNode; name: string; detail: string; connected: boolean;
  actionHref?: string; onAction?: () => void; busy?: boolean;
}) {
  const label = connected ? "Disconnect" : "Connect";
  return (
    <div className="flex items-center gap-3 border-b border-row px-[18px] py-[15px]">
      {glyph}
      <div className="flex flex-1 flex-col">
        <span className="text-body font-medium">{name}</span>
        <span className="text-meta text-muted">{detail}</span>
      </div>
      {connected ? <span className="badge-ok">Connected</span> : null}
      {onAction ? (
        <button
          type="button"
          onClick={onAction}
          disabled={busy}
          className={`btn-link ${connected ? "text-danger" : "text-brand-600"}`}
        >
          {busy ? "Working…" : label}
        </button>
      ) : (
        <form method="post" action={actionHref}>
          <button className={`btn-link ${connected ? "text-danger" : "text-brand-600"}`}>{label}</button>
        </form>
      )}
    </div>
  );
}

export function SessionRow({
  device, where, current, onRevoke, busy,
}: { device: string; where: string; current?: boolean; onRevoke?: () => void; busy?: boolean }) {
  return (
    <div className="flex items-center gap-3 border-b border-row px-[18px] py-[14px] text-[13px]">
      <div className="flex flex-1 flex-col gap-px">
        <span className="font-medium">{device}</span>
        <span className="text-[11.5px] text-subtle">{where}</span>
      </div>
      {current
        ? <span className="badge-ok">This device</span>
        : <button type="button" onClick={onRevoke} disabled={busy} className="btn-link text-danger">{busy ? "Working…" : "Sign out"}</button>}
    </div>
  );
}

/* ==================================================================
   5. Business template configuration (settings/template)
   The template drives vocabulary AND which Overview cards render, so the
   toggles must map to the same keys the Overview reads. Keep this list
   and `OVERVIEW_CARDS` below as the single shared source.
   ================================================================== */
export type OverviewCardKey =
  | "stats" | "chart" | "revenue" | "topServices" | "utilisation" | "noShow";

export function overviewCards(presetId: PresetId | string | null | undefined) {
  const p = getPreset(presetId as string);
  return [
    { key: "stats" as OverviewCardKey, name: "Headline metrics", hint: "Bookings, pending and active-service counts" },
    { key: "chart" as OverviewCardKey, name: `${p.vocab.booking}s over time`, hint: "Daily bar chart for the selected range" },
    { key: "revenue" as OverviewCardKey, name: "Revenue & payment status", hint: "Split by currency and payment state" },
    { key: "topServices" as OverviewCardKey, name: `Top ${p.vocab.services.toLowerCase()}`, hint: "Ranked by volume in range" },
    { key: "utilisation" as OverviewCardKey, name: `${p.vocab.resource} utilisation`, hint: `Booked vs available hours per ${p.vocab.resource.toLowerCase()}` },
    { key: "noShow" as OverviewCardKey, name: "No-show tracking", hint: "Rate for the range" },
  ];
}

/* What renaming the template changes — shown before applying. */
export function vocabDiff(presetId: PresetId | string | null | undefined) {
  const p = getPreset(presetId as string);
  return [
    { from: "Bookings", to: `${p.vocab.booking}s` },
    { from: "Customers", to: `${p.vocab.customer}s` },
    { from: "Staff & Resources", to: p.vocab.resources },
    { from: "Services", to: p.vocab.services },
    { from: "Resource utilisation", to: `${p.vocab.resource} utilisation` },
  ];
}

export function TemplateConfig({
  presetId, hidden, onPick, onToggle, saved = false,
}: {
  presetId: PresetId | string;
  hidden: Record<string, boolean>;
  onPick?: (id: PresetId) => void;
  onToggle?: (key: OverviewCardKey) => void;
  saved?: boolean;
}) {
  const preset = getPreset(presetId as string);
  return (
    <>
      <div className="card">
        <div className="card-header"><h2 className="card-title">Choose a template</h2></div>
        {/* Same tile grid as onboarding's PresetTiles, but this copy never
            got that component's responsive/truncation fix (UX audit's T3
            finding: the industry-card clipping was fixed in setup but not
            here). */}
        <div className="grid grid-cols-1 gap-2 px-[18px] py-[14px] sm:grid-cols-2">
          {PRESETS.map((p) => (
            <label key={p.id} onClick={() => onPick?.(p.id)} className={`tile ${p.id === presetId ? "tile-on" : ""}`}>
              <input type="radio" name="preset" value={p.id} defaultChecked={p.id === presetId} className="sr-only" />
              <span className="h-5 w-5 shrink-0 rounded-[6px]" style={{ background: p.tint }} />
              <span className="min-w-0 truncate text-body font-medium">{p.label}</span>
              <span className="ml-auto shrink-0 text-[11px] text-subtle">{p.unit}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-[14px] md:grid-cols-2">
        <div className="card">
          <div className="card-header"><h2 className="card-title">What this renames</h2></div>
          <div className="px-[18px] pt-1 pb-[14px]">
            {vocabDiff(presetId).map((v) => (
              <div key={v.from} className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-row py-[11px] text-[13px]">
                <span className="text-subtle">{v.from}</span>
                <span className="num text-[11px] text-faint">→</span>
                <span className="text-right font-medium">{v.to}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Default {preset.vocab.services.toLowerCase()}</h2>
            <span className="text-meta text-subtle">Added if missing</span>
          </div>
          <div className="px-[18px] pt-1 pb-[14px]">
            {preset.services.map((s) => (
              <div key={s.name} className="flex items-center justify-between gap-3 border-b border-row py-[11px] text-[13px]">
                <span>{s.name}</span>
                <span className="num text-[12px] text-muted">{s.minutes} min</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <div className="flex flex-col gap-[3px]">
            <h2 className="card-title">Dashboard layout</h2>
            {/* Don't promise reordering unless drag handles exist. */}
            <p className="m-0 text-meta text-muted">Each template leads with the metrics that matter for it. Switch off any card you don't need.</p>
          </div>
        </div>
        <div className="flex flex-col gap-2 px-[18px] py-[14px]">
          {overviewCards(presetId).map((c, i) => {
            const on = !hidden[c.key];
            return (
              <label key={c.key} onClick={() => onToggle?.(c.key)}
                className={`group flex cursor-pointer items-center gap-3 rounded-[9px] border px-[13px] py-[11px] ${on ? "border-brand-200 bg-surface" : "border-line bg-canvas-alt"}`}>
                <input type="checkbox" name="cards" value={c.key} defaultChecked={on} className="peer sr-only" />
                <span className="num w-[14px] text-[11px] text-subtle">{i + 1}</span>
                <span className="flex flex-1 flex-col gap-px">
                  <span className="text-body font-medium">{c.name}</span>
                  <span className="text-[12px] text-muted">{c.hint}</span>
                </span>
                <span className="flex h-5 w-[34px] shrink-0 rounded-full bg-[#d3d7e0] p-[2px] peer-checked:bg-brand-500">
                  {/* See ui.tsx's Toggle for why this is group-has-checked,
                      not peer-checked: this knob is nested inside the track
                      span, not a direct sibling of the checkbox. */}
                  <span className="h-4 w-4 rounded-full bg-white shadow-[0_1px_2px_rgba(16,24,40,.2)] transition-transform group-has-checked:translate-x-[14px]" />
                </span>
              </label>
            );
          })}
        </div>
        {/* Save used to float alone in a detached card above this picker
            (settings.tsx rendered it as the tab strip's own footer, before
            any of TemplateConfig's cards), so it read as a control for
            something else entirely — every other tab's Save sits in the
            footer of the card it belongs to (UX audit's U6/T3 finding). */}
        <div className="card-footer">
          {saved && <span className="alert-success">Saved.</span>}
          <button type="submit" className="btn-pri ml-auto">Save template</button>
        </div>
      </div>
    </>
  );
}
