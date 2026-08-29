import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import type { Route } from "./+types/onboarding";
import { requireUserSession } from "~/session.server";
import { Field, Input, Toggle } from "~/components/ui";
import { OnboardingShell, PresetTiles, PresetScaffold, IntegrationRow } from "~/components/onboarding";
import { INTEGRATIONS, getPreset, type PresetId } from "~/lib/presets";

// Nothing on this route ever touches the database — there is no store yet
// to attach any of these answers to (a Connection only exists after real
// Shopify OAuth). Every field below just accumulates client-side until the
// "Connect your Shopify store" form fires, which threads the whole payload
// through the signed OAuth state and applies it for real in
// connect.shopify.callback.tsx once the store exists. See the plan's
// "Onboarding persistence" note for why.
export async function loader({ request }: Route.LoaderArgs) {
  await requireUserSession(request);
  return null;
}

const STORAGE_KEY = "gb_onboarding";

type OnboardingState = {
  businessName: string;
  preset: PresetId;
  email: string;
  phone: string;
  timezone: string;
  teamSize: string;
  resourceName: string;
  remindersOn: boolean;
};

const DEFAULT_STATE: OnboardingState = {
  businessName: "",
  preset: "generic",
  email: "",
  phone: "",
  timezone: "",
  teamSize: "1",
  resourceName: "",
  remindersOn: true,
};

function loadSeed(): OnboardingState {
  if (typeof window === "undefined") return DEFAULT_STATE;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_STATE, ...JSON.parse(raw) } : DEFAULT_STATE;
  } catch {
    return DEFAULT_STATE;
  }
}

export default function Onboarding() {
  const [searchParams, setSearchParams] = useSearchParams();
  const step = Math.min(4, Math.max(1, Number(searchParams.get("step")) || 1));
  const [state, setState] = useState<OnboardingState>(DEFAULT_STATE);

  // Seed from sessionStorage on mount only (not SSR — nothing here is
  // stored server-side, and this route never renders on the server with
  // meaningful data anyway since the loader returns null).
  useEffect(() => {
    setState(loadSeed());
  }, []);

  function update(patch: Partial<OnboardingState>) {
    setState((prev) => {
      const next = { ...prev, ...patch };
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // best-effort — same reasoning as signup.tsx's stashOnboardingSeed
      }
      return next;
    });
  }

  function goToStep(n: number) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("step", String(n));
      return next;
    });
  }

  return (
    <OnboardingShell step={step} onStep={goToStep} finishLaterHref="/connect/shopify">
      {step === 1 && <StepBusiness state={state} update={update} onNext={() => goToStep(2)} />}
      {step === 2 && <StepSetup state={state} update={update} onNext={() => goToStep(3)} onBack={() => goToStep(1)} />}
      {step === 3 && <StepIntegrations state={state} onNext={() => goToStep(4)} onBack={() => goToStep(2)} />}
      {step === 4 && <StepGoLive state={state} update={update} onBack={() => goToStep(3)} />}
    </OnboardingShell>
  );
}

/* Carries the full accumulated payload to the real connect flow — a plain
   <Form>, not a fetcher, so the browser can follow the action's redirect to
   Shopify's real (cross-origin) authorize URL. Reused by steps 3 and 4. */
function ShopifyConnectForm({ state, submitLabel }: { state: OnboardingState; submitLabel: string }) {
  const [shop, setShop] = useState("");
  return (
    <form method="post" action="/connect/shopify" className="flex flex-col gap-3">
      <input type="hidden" name="ob_preset" value={state.preset} />
      {state.businessName && <input type="hidden" name="ob_business_name" value={state.businessName} />}
      {state.email && <input type="hidden" name="ob_business_email" value={state.email} />}
      {state.phone && <input type="hidden" name="ob_business_phone" value={state.phone} />}
      {state.timezone && <input type="hidden" name="ob_timezone" value={state.timezone} />}
      {state.resourceName && <input type="hidden" name="ob_resource_name" value={state.resourceName} />}
      <input type="hidden" name="ob_reminders_on" value={state.remindersOn ? "on" : ""} />
      <Field label="Shopify store domain" hint="your-store.myshopify.com">
        <Input
          name="shop"
          placeholder="your-store.myshopify.com"
          required
          value={shop}
          onChange={(e) => setShop(e.target.value)}
        />
      </Field>
      <button type="submit" className="btn-pri justify-center">{submitLabel}</button>
    </form>
  );
}

function StepBusiness({
  state, update, onNext,
}: { state: OnboardingState; update: (p: Partial<OnboardingState>) => void; onNext: () => void }) {
  return (
    <>
      <h1 className="ob-h1">Tell us about your business</h1>
      <div className="card p-[18px]">
        <div className="flex flex-col gap-[14px]">
          <div className="flex flex-col gap-[6px]">
            <span className="field-label">What does your business do?</span>
            <PresetTiles value={state.preset} onPick={(preset) => update({ preset })} columns={2} />
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-[14px]">
            <Field label="Contact email">
              <Input type="email" value={state.email} onChange={(e) => update({ email: e.target.value })} />
            </Field>
            <Field label="Phone number">
              <Input value={state.phone} onChange={(e) => update({ phone: e.target.value })} />
            </Field>
            <Field label="Timezone" hint="e.g. America/New_York">
              <Input value={state.timezone} onChange={(e) => update({ timezone: e.target.value })} placeholder="e.g. America/New_York" />
            </Field>
            <Field label="Team size">
              <select
                value={state.teamSize}
                onChange={(e) => update({ teamSize: e.target.value })}
                className="input cursor-pointer"
              >
                <option value="1">Just me</option>
                <option value="2-5">2–5 people</option>
                <option value="6-20">6–20 people</option>
                <option value="20+">20+ people</option>
              </select>
            </Field>
          </div>
        </div>
      </div>
      <div className="flex justify-end">
        <button type="button" className="btn-pri" onClick={onNext}>Continue</button>
      </div>
    </>
  );
}

function StepSetup({
  state, update, onNext, onBack,
}: { state: OnboardingState; update: (p: Partial<OnboardingState>) => void; onNext: () => void; onBack: () => void }) {
  return (
    <>
      <h1 className="ob-h1">Your setup</h1>
      <PresetScaffold presetId={state.preset} />
      <div className="card p-[18px]">
        <h2 className="card-title mb-3">Add your first {getPreset(state.preset).vocab.resource.toLowerCase()}</h2>
        <Field label="Name" hint="A staff member, room, table or bay — whatever takes your bookings. You can add more later.">
          <Input value={state.resourceName} onChange={(e) => update({ resourceName: e.target.value })} placeholder="e.g. Alex Rivera" />
        </Field>
      </div>
      <div className="flex justify-between">
        <button type="button" className="btn-sec" onClick={onBack}>Back</button>
        <button type="button" className="btn-pri" onClick={onNext}>Continue</button>
      </div>
    </>
  );
}

function StepIntegrations({
  state, onNext, onBack,
}: { state: OnboardingState; onNext: () => void; onBack: () => void }) {
  return (
    <>
      <h1 className="ob-h1">Connect your channels</h1>
      <p className="m-0 -mt-2 text-body text-muted">
        Connecting your store below finishes setup in one step. Everything else can wait.
      </p>
      <div className="flex flex-col gap-[10px]">
        {INTEGRATIONS.map((integ) =>
          integ.id === "shopify" ? (
            <div key={integ.id} className="rounded-card border border-brand-200 bg-surface px-[18px] py-4 shadow-card">
              <div className="mb-3 flex items-center gap-[14px]">
                <span className="integ-logo h-[38px] w-[38px] text-[15px]" style={{ background: integ.tint }}>{integ.initial}</span>
                <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                  <span className="text-[14px] font-semibold tracking-[-0.01em]">{integ.name}</span>
                  <span className="text-meta text-muted text-pretty">{integ.blurb}</span>
                </div>
              </div>
              <ShopifyConnectForm state={state} submitLabel="Connect Shopify" />
            </div>
          ) : (
            <IntegrationRow
              key={integ.id}
              id={integ.id}
              name={integ.name}
              initial={integ.initial}
              tint={integ.tint}
              tag={integ.id === "stripe" ? "Connect your store first" : "Coming soon"}
              blurb={integ.blurb}
              connected={false}
              disabled
            />
          )
        )}
      </div>
      <div className="flex justify-between">
        <button type="button" className="btn-sec" onClick={onBack}>Back</button>
        <button type="button" className="btn-pri" onClick={onNext}>Skip for now</button>
      </div>
    </>
  );
}

function StepGoLive({
  state, update, onBack,
}: { state: OnboardingState; update: (p: Partial<OnboardingState>) => void; onBack: () => void }) {
  return (
    <>
      <h1 className="ob-h1">Go live</h1>
      <div className="card p-[18px]">
        <div className="flex flex-col gap-[14px]">
          <Toggle
            name="remindersOn"
            defaultChecked={state.remindersOn}
            onChange={(checked) => update({ remindersOn: checked })}
            label="Send booking reminders"
          />
          <div className="flex items-center gap-[10px] rounded-[9px] border border-line bg-canvas-alt px-3 py-[11px]">
            <span className="rounded-full bg-neutral-bg px-[7px] py-[2px] text-[11px] font-medium text-neutral">Coming soon</span>
            <span className="text-body font-medium text-muted">Invite your team</span>
          </div>
        </div>
      </div>
      <div className="card p-[18px]">
        <h2 className="card-title mb-3">Finish setup</h2>
        <ShopifyConnectForm state={state} submitLabel="Connect your store & go live" />
      </div>
      <div className="flex justify-start">
        <button type="button" className="btn-sec" onClick={onBack}>Back</button>
      </div>
    </>
  );
}
