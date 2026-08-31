import type { ReactNode } from "react";
import { PRESETS, DAY_ABBR, getPreset, summarizeHours, rulesFor, ruleChips, type Preset, type PresetId } from "~/lib/presets";
import { LogoutButton } from "~/components/ui";

/* ==================================================================
   1. Signup — industry preset picker
   Renders a real <select> (works with JS off) plus, on wide screens,
   the same choices as tiles. Post `preset` with the signup form.
   ================================================================== */
export function PresetSelect({
  name = "preset",
  defaultValue = "generic",
  onChange,
}: { name?: string; defaultValue?: PresetId; onChange?: (id: PresetId) => void }) {
  return (
    <label className="field">
      <span className="field-label">What does your business do?</span>
      <select
        name={name}
        defaultValue={defaultValue}
        onChange={(e) => onChange?.(e.target.value as PresetId)}
        className="input cursor-pointer"
      >
        {PRESETS.map((p) => (
          <option key={p.id} value={p.id}>{p.label}</option>
        ))}
      </select>
      <span className="field-hint">
        Sets your default services, terminology and reminder timing. Editable later.
      </span>
    </label>
  );
}

/* Tile grid variant — used on the marketing page and onboarding step 1.
   `as` lets it post without JS: render inside a form with radio inputs. */
export function PresetTiles({
  name = "preset",
  value,
  onPick,
  columns = 2,
}: { name?: string; value: PresetId; onPick?: (id: PresetId) => void; columns?: 2 | 5 }) {
  return (
    // Single column below sm — a 2-up grid left ~150px per tile at a
    // 389px viewport, not enough for a label like "Home Services / Trades"
    // plus its unit, so 7 of 10 subtitles clipped by up to 26px (UX
    // audit's text-overflow finding). min-w-0 + truncate is a second,
    // width-independent safety net for any leftover long combination.
    <div className={`grid grid-cols-1 gap-2 sm:grid-cols-2 ${columns === 5 ? "md:grid-cols-5" : ""}`}>
      {PRESETS.map((p) => (
        <label
          key={p.id}
          onClick={() => onPick?.(p.id)}
          className={`tile ${p.id === value ? "tile-on" : ""}`}
        >
          <input type="radio" name={name} value={p.id} defaultChecked={p.id === value} className="sr-only" />
          <span className="h-5 w-5 shrink-0 rounded-[6px]" style={{ background: p.tint }} />
          <span className="min-w-0 truncate text-body font-medium">{p.label}</span>
          <span className="ml-auto shrink-0 text-[11px] text-subtle">{p.unit}</span>
        </label>
      ))}
    </div>
  );
}

/* ==================================================================
   2. Onboarding shell — progress bar + step rail + body
   Step lives in the URL (?step=2) so Back/Forward and no-JS both work.
   ================================================================== */
const STEP_NAMES = ["Business", "Your setup", "Integrations", "Go live"] as const;

export function OnboardingShell({
  step,
  onStep,
  finishLaterHref = "/dashboard",
  children,
}: { step: number; onStep?: (n: number) => void; finishLaterHref?: string; children: ReactNode }) {
  return (
    <div className="ob-shell">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-[940px] items-center gap-[14px] px-7 py-[14px]">
          <LogoMark size={28} />
          <span className="text-[14px] font-semibold">Set up GetBooqin</span>
          <span className="num ml-auto text-[12px] text-subtle">Step {step} of 4</span>
          <a href={finishLaterHref} className="text-meta font-medium text-muted no-underline hover:text-ink">Finish later</a>
          <LogoutButton className="btn-ghost px-[10px] py-[6px] text-meta" />
        </div>
        <div className="ob-progress"><span style={{ width: `${(step / 4) * 100}%` }} /></div>
      </header>

      <div className="ob-grid">
        <nav className="ob-rail">
          {STEP_NAMES.map((name, i) => {
            const n = i + 1, done = n < step, active = n === step;
            return (
              <a
                key={name}
                href={`?step=${n}`}
                onClick={onStep ? (e) => { e.preventDefault(); onStep(n); } : undefined}
                className={`ob-step no-underline hover:no-underline ${active ? "ob-step-active" : done ? "ob-step-done" : ""}`}
              >
                <span className={`ob-dot ${done ? "ob-dot-done" : active ? "ob-dot-active" : ""}`}>
                  {done ? "✓" : n}
                </span>
                {name}
              </a>
            );
          })}
        </nav>
        <div className="flex min-w-0 flex-col gap-[18px]">{children}</div>
      </div>
    </div>
  );
}

export function LogoMark({ size = 30 }: { size?: number }) {
  const bar = Math.round(size / 5);
  return (
    <span
      className="flex shrink-0 flex-col justify-center gap-[3px] rounded-[8px] bg-brand-950"
      style={{ width: size, height: size, padding: Math.round(size / 5) }}
    >
      <span className="rounded-[2px] bg-brand-500" style={{ height: bar }} />
      <span className="rounded-[2px] border-[1.5px] border-brand-500" style={{ height: bar }} />
    </span>
  );
}

/* ==================================================================
   3. Onboarding step 2 — preset scaffold preview
   ================================================================== */
export function PresetScaffold({ presetId }: { presetId: PresetId }) {
  const preset = getPreset(presetId);
  const rules = rulesFor(presetId);

  return (
    <>
      <div className="card p-[18px]">
        <h2 className="card-title mb-3">Starting rules</h2>
        <p className="mb-3 text-meta text-muted">
          A preset sets policy, not just wording — every one of these stays editable in Settings once you're live.
        </p>
        <div className="flex flex-wrap gap-[8px]">
          {ruleChips(rules).map((chip) => (
            <span key={chip} className="rounded-full border border-line bg-surface px-[10px] py-[4px] text-meta text-ink-2">
              {chip}
            </span>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h2 className="card-title">{preset.vocab.services}</h2>
          <span className="text-meta text-subtle">{preset.services.length} included</span>
        </div>
        {/* Read-only — nothing here is actually configurable until there's a
            real catalogue behind it (Shopify's product sync, or the manual
            service editor once you go live without Shopify), so this used
            to render as selectable tiles that quietly did nothing when
            clicked. See the UX audit's P9 finding. */}
        <div className="grid grid-cols-2 gap-2 px-[18px] py-[14px]">
          {preset.services.map((s) => (
            <div key={s.name} className="tile cursor-default">
              <span className="text-body font-medium">{s.name}</span>
              <span className="num ml-auto text-[11.5px] text-subtle">{s.minutes} min</span>
            </div>
          ))}
        </div>
        <div className="card-footer">
          <span className="text-meta text-muted">
            A preview of a typical {preset.label.split(" / ")[0].toLowerCase()} setup — your real{" "}
            {preset.vocab.services.toLowerCase()} come from your store's product catalogue once it's connected
            (or from the service editor if you go live without one).
          </span>
        </div>
      </div>

      <div className="card p-[18px]">
        <h2 className="card-title mb-3">Business hours</h2>
        <p className="mb-3 text-meta text-muted">{summarizeHours(preset.open, preset.range)}</p>
        <div className="flex flex-col gap-[7px]">
          {DAY_ABBR.map((abbr, i) => {
            const open = preset.open[i];
            return (
              <div key={abbr} className="flex items-center gap-[10px] text-meta">
                <span className={`w-[34px] font-medium ${open ? "text-ink-2" : "text-faint"}`}>{abbr}</span>
                <span className={`h-[6px] flex-1 rounded-[4px] ${open ? "bg-brand-200" : "bg-row"}`} />
                <span className={`num text-[11.5px] ${open ? "text-ink-2" : "text-faint"}`}>
                  {open ? preset.range : "Closed"}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

/* ==================================================================
   4. Integration row — onboarding step 3 and Settings › Integrations.
   `variant` only changes the copy/CTA, never the layout. `disabled`
   renders the tag as the reason nothing is clickable yet (e.g. "Coming
   soon", "Connect your store first") instead of a working Connect form —
   used for channels with no backend yet, or that need a store to attach to.
   ================================================================== */
export function IntegrationRow({
  id, name, initial, tint, tag, blurb, detail, connected, variant = "onboarding", disabled = false, action,
}: {
  id: string; name: string; initial: string; tint: string; tag: string;
  blurb: string; detail?: string; connected: boolean; variant?: "onboarding" | "settings";
  disabled?: boolean; action?: ReactNode;
}) {
  const card = variant === "onboarding";
  return (
    <div className={card
      ? `flex items-center gap-[14px] rounded-card border bg-surface px-[18px] py-4 shadow-card ${connected ? "border-brand-200" : "border-line"}`
      : "integ-row"}>
      <span className={`integ-logo ${card ? "h-[38px] w-[38px] text-[15px]" : "h-[34px] w-[34px]"} ${disabled ? "opacity-50" : ""}`} style={{ background: tint }}>
        {initial}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-semibold tracking-[-0.01em]">{name}</span>
          <span className={`rounded-full px-[7px] py-[2px] text-[11px] font-medium ${connected ? "bg-ok-bg text-ok" : "bg-neutral-bg text-neutral"}`}>
            {connected ? "Connected" : tag}
          </span>
        </div>
        {card ? <span className="text-meta text-muted text-pretty">{blurb}</span> : null}
        {connected && detail
          ? <span className={card ? "num text-[11.5px] text-ok" : "text-meta text-muted"}>{detail}</span>
          : !card && !disabled ? <span className="text-meta text-muted">Not connected — {tag.toLowerCase()}</span> : null}
      </div>
      {action ?? (
        disabled ? (
          <button className="btn-sec cursor-not-allowed opacity-50" disabled>
            {connected ? "Manage" : "Connect"}
          </button>
        ) : (
          <form method="post" action={connected ? `integrations/${id}/configure` : `integrations/${id}/connect`}>
            <button className={connected ? "btn-sec" : "btn-pri"}>
              {connected ? (card ? "Manage" : "Configure") : "Connect"}
            </button>
          </form>
        )
      )}
    </div>
  );
}

/* ==================================================================
   5. Empty dashboard — setup checklist card.
   Feed it setupSummary(facts) so the headline and the "N of total done"
   label can never disagree — never hardcode the task count here, it's
   setupTasks()'s own length. An hrefs map (keyed by task.key)
   pointing each row at the real page that edits that fact.
   ================================================================== */
export function SetupChecklist({
  summary,
  hrefs,
  resumeHref,
}: {
  summary: {
    tasks: { key: string; name: string; hint: string; done: boolean }[];
    done: number; total: number; pct: number; complete: boolean;
  };
  hrefs: Record<string, string>;
  resumeHref: string;
}) {
  return (
    <div className="card">
      <div className="card-header">
        <div className="flex flex-1 flex-col gap-[7px]">
          {/* This card used to say "Finish setting up" / "Continue setup"
              unconditionally — on a genuinely finished account it sat right
              next to a subtitle already saying setup was complete,
              disagreeing with itself on the same screen (UX audit's C3
              finding). summary.complete is the same flag that headline
              text already reflects; this just lets the card agree with it. */}
          <h2 className="card-title">{summary.complete ? "Setup complete" : "Finish setting up"}</h2>
          <div className="flex items-center gap-[10px]">
            <span className="h-[6px] max-w-[220px] flex-1 rounded-[4px] bg-row">
              <span className="block h-[6px] rounded-[4px] bg-brand-500" style={{ width: `${summary.pct}%` }} />
            </span>
            <span className="num text-[12px] text-muted">{summary.done} of {summary.total} done</span>
          </div>
        </div>
        {!summary.complete && (
          <a href={resumeHref} className="btn-pri no-underline hover:no-underline">Continue setup</a>
        )}
      </div>
      {summary.tasks.map((t) => (
        <a key={t.key} href={hrefs[t.key] ?? resumeHref} className="task-row no-underline hover:no-underline">
          <span className={`task-dot ${t.done ? "task-dot-done" : ""}`}>{t.done ? "✓" : ""}</span>
          <div className="min-w-0 flex-1">
            <div className={`text-body font-medium ${t.done ? "text-muted" : "text-ink"}`}>{t.name}</div>
            <div className="text-meta text-muted">{t.hint}</div>
          </div>
          <span className={`text-meta font-medium ${t.done ? "text-subtle" : "text-brand-600"}`}>
            {t.done ? "Edit" : "Set up"}
          </span>
        </a>
      ))}
    </div>
  );
}

/* Zeroed stat card for the empty state — greyed value, no fake trend. */
export function EmptyStat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="flex flex-col gap-[9px] rounded-card border border-line bg-surface px-[18px] py-4 shadow-card">
      <div className="text-[12px] font-medium text-muted">{label}</div>
      <div className="num text-stat font-medium tracking-[-0.03em] text-faint">{value}</div>
      <div className="text-[12px] text-subtle">{note}</div>
    </div>
  );
}

/* ==================================================================
   6. Marketing pricing card (routes/_index.tsx #pricing)
   ================================================================== */
export function PlanCard({
  name, price, per, blurb, features, featured, cta, href = "/signup",
}: {
  name: string; price: string; per: string; blurb: string;
  features: string[]; featured?: boolean; cta: string; href?: string;
}) {
  return (
    <div className={`plan-card ${featured ? "plan-card-featured" : ""}`}>
      <div className="flex items-center gap-2">
        <span className="text-card font-semibold">{name}</span>
        {featured ? (
          <span className="rounded-full bg-brand-50 px-[7px] py-[2px] text-[11px] font-medium text-brand-600">Most popular</span>
        ) : null}
      </div>
      <div className="flex items-baseline gap-[5px]">
        <span className="num text-[30px] font-medium tracking-[-0.03em]">{price}</span>
        <span className="text-meta text-subtle">{per}</span>
      </div>
      <p className="m-0 text-meta text-muted">{blurb}</p>
      <div className="flex flex-col gap-2">
        {features.map((f) => (
          <div key={f} className="flex items-center gap-2 text-[13px]">
            <span className="inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-full bg-brand-fill text-[8px] text-white">✓</span>
            {f}
          </div>
        ))}
      </div>
      <a href={href} className={`mt-auto rounded-[9px] px-[14px] py-[10px] text-center text-[13px] font-semibold no-underline hover:no-underline ${
        featured ? "bg-brand-fill text-white hover:bg-brand-700" : "border border-line-strong text-ink hover:bg-canvas"
      }`}>
        {cta}
      </a>
    </div>
  );
}

export type { Preset, PresetId };
