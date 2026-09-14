import { useRef, useState, type ReactNode } from "react";
import { termSuggestionPairs, guessPlural, type Terms } from "../lib/presets";
import { LogoutButton, ConfirmDialog } from "./ui";

/* ==================================================================
   1. User menu — sidebar footer popover
   The popover itself is <details>, which needs no state and closes on
   outside click in modern browsers via the `name` attribute (exclusive
   accordion) or Escape. Profile/security render nested under the current
   connection (dashboard.$connectionId.account.tsx) so they share this
   same sidebar shell rather than dropping to a different layout — `base`
   builds both that link and Business settings'.
   ================================================================== */
export function UserMenu({
  name, email, role, initials, dark = false, base,
}: { name: string; email: string; role: string; initials: string; dark?: boolean; base: string }) {
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

      <div className="user-menu-pop absolute inset-x-[6px] bottom-[calc(100%+6px)] z-20 flex flex-col gap-px rounded-[11px] border border-line bg-surface p-[5px] shadow-[0_12px_34px_rgba(16,24,40,.18)]">
        <div className="flex flex-col gap-px px-[10px] pt-[9px] pb-[7px]">
          <span className="text-meta font-semibold text-ink">{name}</span>
          <span className="text-[11.5px] text-subtle">{email}</span>
        </div>
        <div className="my-[2px] h-px bg-row" />
        {/* Business settings and Help & support dropped from here — both
            now have their own entry in the main sidebar nav
            (dashboard.$connectionId.tsx), so listing them a second time
            here was pure duplication. Profile settings and Password &
            security stay: Account isn't in that nav at all, so this menu
            is still the only route to either. Both are connection-scoped
            paths, not a bare /dashboard/account — Account renders nested
            under the current store (dashboard.$connectionId.account.tsx)
            precisely so it stays inside this same sidebar shell instead of
            dropping to a different layout the moment you click over. */}
        <MenuLink href={`${base}/account`}>Profile settings</MenuLink>
        <MenuLink href={`${base}/account?tab=security`}>Password &amp; security</MenuLink>
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
// "revenue" is gone with merchant deposits (Phase 1's trim) — Overview
// no longer renders that card, so offering it as a toggle here would be
// a switch with nothing behind it, which is the shape of Defect
// Dossier's R3-05 finding. An existing shop's stored
// hidden_overview_cards may still contain the key; nothing reads it.
export type OverviewCardKey =
  | "stats" | "chart" | "topServices" | "utilisation" | "noShow";

export function overviewCards(vocab: { booking: string; service: string; services: string; resource: string }) {
  const p = { vocab };
  return [
    { key: "stats" as OverviewCardKey, name: "Headline metrics", hint: `${p.vocab.booking}s, pending and active ${p.vocab.service.toLowerCase()} counts`, disabled: false },
    { key: "chart" as OverviewCardKey, name: `${p.vocab.booking}s over time`, hint: "Daily bar chart for the selected range", disabled: false },
    { key: "topServices" as OverviewCardKey, name: `Top ${p.vocab.services.toLowerCase()}`, hint: "Ranked by volume in range", disabled: false },
    { key: "utilisation" as OverviewCardKey, name: `${p.vocab.resource} utilisation`, hint: `Booked vs available hours per ${p.vocab.resource.toLowerCase()}`, disabled: false },
    { key: "noShow" as OverviewCardKey, name: "No-show tracking", hint: "Rate for the range", disabled: false },
  ];
}

/* ==================================================================
   Dashboard layout — which Overview cards this shop shows. Lives on
   Settings → General now; it used to be the bottom half of a Business
   template page whose top half was the industry-preset picker and a
   before/after diff of everything switching one would overwrite. That
   page went with the presets themselves (Phase 1's trim, see core's
   presets.ts) — this card is the part of it that was doing real work.
   ================================================================== */
export function DashboardLayoutCard({
  vocab, hidden, onToggle,
}: {
  vocab: { booking: string; service: string; services: string; resource: string };
  hidden: Record<string, boolean>;
  onToggle: (key: OverviewCardKey) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {overviewCards(vocab).map((c, i) => {
        const on = !hidden[c.key] && !c.disabled;
        return (
          // No onClick on the label. It used to carry one *and* wrap the
          // checkbox, so a single click ran the handler twice — once for
          // the click on the label, once for the click the label forwards
          // to the input and which bubbles back up through it. The state
          // toggled and untoggled, the checkbox ended up back where it
          // started, and the submitted "cards" list was always whatever
          // it had been on load: switching a card off changed the
          // highlight and then saved nothing.
          <label key={c.key}
            className={`group flex items-center gap-3 rounded-[9px] border px-[13px] py-[11px] ${c.disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"} ${on ? "border-brand-200 bg-surface" : "border-line bg-canvas-alt"}`}>
            {/* Controlled, so React state and the field that actually
                gets submitted cannot disagree — which is the whole bug
                above. */}
            <input
              type="checkbox"
              name="cards"
              value={c.key}
              checked={on}
              disabled={c.disabled}
              onChange={() => onToggle(c.key)}
              className="peer sr-only"
            />
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
  );
}

/* ==================================================================
   Vocabulary — "what do you call things?". Four singular/plural pairs
   of free text with suggestion chips, and that is the whole feature.
   It replaces eleven industry presets, each of which also overwrote
   eleven live settings keys and needed a "Preset default / Customized"
   badge on every field they could touch (see core's presets.ts for the
   full story). A business types the word it uses; the dashboard, the
   booking page and the emails all say it.
   ================================================================== */
const VOCAB_ROWS: { single: keyof Terms; plural: keyof Terms; label: string; hint: string }[] = [
  { single: "booking_single", plural: "booking_plural", label: "Bookings are called", hint: "Every list, heading and confirmation email" },
  { single: "service_single", plural: "service_plural", label: "Services are called", hint: "The things a customer books" },
  { single: "resource_single", plural: "resource_plural", label: "Who or what gets booked", hint: "Staff, practitioners, rooms, bays, tables" },
  { single: "customer_single", plural: "customer_plural", label: "Customers are called", hint: "The people booking" },
];

export function VocabularyFields({
  terms, onChange,
}: {
  terms: Terms;
  /** A patch, not the whole object — a row only ever knows its own two keys. */
  onChange: (patch: Partial<Terms>) => void;
}) {
  return (
    <div className="flex flex-col gap-[18px]">
      {VOCAB_ROWS.map((row) => (
        <VocabRow key={row.single} row={row} terms={terms} onChange={onChange} />
      ))}
    </div>
  );
}

/**
 * One singular/plural pair. Its own component only so it can hold a ref
 * to the last singular it saw — which is how the plural field knows
 * whether it still holds a value we derived (ours to update) or a word
 * the merchant typed (never ours to touch).
 */
/**
 * One noun, asked once.
 *
 * This used to be two text boxes side by side, singular and plural, for
 * every row — and since the plural is "the singular plus an s" almost
 * every time, the pair read as the same question asked twice. Four rows
 * of that is eight boxes to fill in to answer four questions.
 *
 * So the plural is derived and shown as a fact, not a field. The field
 * is still there for the words the rule gets wrong — Person/People,
 * Class/Classes — but it stays out of the way until it is wanted, and
 * it opens by itself for an account whose plural is already irregular,
 * because that word must never be silently overwritten by a guess.
 */
function VocabRow({
  row, terms, onChange,
}: {
  row: (typeof VOCAB_ROWS)[number];
  terms: Terms;
  onChange: (patch: Partial<Terms>) => void;
}) {
  const single = terms[row.single];
  const plural = terms[row.plural];

  // Irregular already? Then the merchant (or a template) chose that word
  // deliberately: show it, and never derive over it.
  const [custom, setCustom] = useState(() => terms[row.plural] !== guessPlural(terms[row.single]));

  // The row owns both keys, so a change to the singular carries the
  // derived plural with it in one update — no second render where the
  // two disagree.
  function changeSingle(value: string) {
    onChange(custom ? { [row.single]: value } : { [row.single]: value, [row.plural]: guessPlural(value) });
  }

  return (
        <div className="flex flex-col gap-[7px]">
          <div className="flex flex-col gap-px">
            <span className="text-body font-medium">{row.label}</span>
            <span className="text-[12px] text-muted">{row.hint}</span>
          </div>

          <input
            className="input w-full min-w-0"
            name={`term_${row.single}`}
            value={single}
            onChange={(e) => changeSingle(e.currentTarget.value)}
            aria-label={row.label}
            placeholder="Singular"
            maxLength={40}
          />

          {/* Always in the DOM, so the form submits a plural whether or
              not anyone has looked at it. Hidden, not unmounted. */}
          <div hidden={!custom} className="flex flex-col gap-[5px]">
            <label className="text-[12px] text-muted" htmlFor={`term_${row.plural}`}>
              Plural
            </label>
            <input
              id={`term_${row.plural}`}
              className="input w-full min-w-0"
              name={`term_${row.plural}`}
              value={plural}
              onChange={(e) => onChange({ [row.plural]: e.currentTarget.value })}
              aria-label={`${row.label} (plural)`}
              placeholder="Plural"
              maxLength={40}
            />
          </div>

          {!custom && (
            <p className="m-0 text-[12px] text-subtle">
              Plural: <span className="text-muted">{plural || "—"}</span>{" "}
              <button
                type="button"
                // Named per row: four "Change" buttons on one screen are
                // indistinguishable to anyone not looking at where they sit.
                aria-label={`Change the plural of ${row.label.toLowerCase()}`}
                className="bg-transparent p-0 text-[12px] font-medium text-brand-600 underline"
                onClick={() => setCustom(true)}
              >
                Change
              </button>
            </p>
          )}

          {/* Suggestions fill the field rather than replacing it — it is
              free text, and these exist to show the product means it,
              not to fence the answer in. A suggestion whose own plural
              is irregular brings that plural with it, and opens the
              field so it is visible rather than silently applied. */}
          <div className="flex flex-wrap gap-[6px]">
            {termSuggestionPairs(row.single, row.plural).slice(0, 6).map((pair) => (
              <button
                key={pair.single}
                type="button"
                className="rounded-full border border-line bg-surface px-[10px] py-[3px] text-meta text-ink-2 hover:border-brand-500"
                onClick={() => {
                  onChange({ [row.single]: pair.single, [row.plural]: pair.plural });
                  if (pair.plural !== guessPlural(pair.single)) setCustom(true);
                }}
              >
                {pair.single}
              </button>
            ))}
          </div>
        </div>
  );
}
