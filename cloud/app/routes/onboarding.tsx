import { useEffect, useState, type FormEvent } from "react";
import { redirect, useSearchParams } from "react-router";
import type { Route } from "./+types/onboarding";
import { requireUserSession } from "~/session.server";
import { Field, Input, Toggle, TimezoneSelect } from "~/components/ui";
import { OnboardingShell, PresetTiles, PresetScaffold, IntegrationRow } from "~/components/onboarding";
import { INTEGRATIONS, getPreset, type PresetId } from "~/lib/presets";
import { PHONE_PATTERN, isValidPhone } from "~/lib/validation";
import { Data, Settings, createManualConnection } from "getbooqin-core";

// Two ways to leave this wizard with a working account: connect a real
// Shopify store (ShopifyConnectForm below — answers ride through the OAuth
// state to connect.shopify.callback.tsx, since there's no Connection row to
// attach them to until that store exists), or "Go live without Shopify"
// (this action), which creates a Connection right now against a manual,
// non-Shopify platform and applies everything immediately. Either way,
// nothing here is saved server-side before that point — see the UX audit's
// B1/B3 findings for why a bare sessionStorage-only wizard that could never
// finish without Shopify was the actual bug, not client-side staging itself.
export const meta: Route.MetaFunction = () => [{ title: "Set up your business · GetBooqin" }];

export async function loader({ request }: Route.LoaderArgs) {
  const session = await requireUserSession(request);
  return { userId: session.userId };
}

export async function action({ request }: Route.ActionArgs) {
  const session = await requireUserSession(request);
  const form = await request.formData();

  const connection = await createManualConnection({ userId: session.userId });
  const shop = connection.shop;
  const platform = connection.platform;

  const presetId = String(form.get("preset") || "") || undefined;
  const businessName = String(form.get("business_name") || "") || undefined;
  const businessEmail = String(form.get("business_email") || "") || undefined;
  const businessPhone = String(form.get("business_phone") || "") || undefined;
  const timezone = String(form.get("timezone") || "") || undefined;
  const resourceName = String(form.get("resource_name") || "") || undefined;
  const remindersOn = form.get("reminders_on") === "on";

  const settingsPatch: Record<string, string | boolean> = { reminder_enabled: remindersOn };
  if (businessName) settingsPatch.business_name = businessName;
  if (businessEmail) settingsPatch.business_email = businessEmail;
  if (businessPhone) settingsPatch.business_phone = businessPhone;
  if (timezone) settingsPatch.timezone = timezone;
  await Settings.setSettings(shop, platform, settingsPatch);

  if (presetId) {
    await Settings.applyPreset(shop, platform, presetId);
  }

  if (resourceName) {
    await Data.saveResource(shop, platform, {
      name: resourceName,
      title: "",
      email: "",
      phone: "",
      description: "",
      meeting_link: "",
      timezone: "",
      status: true,
      schedule: [],
      service_ids: [],
    });
  }

  throw redirect(`/dashboard/${connection.id}`);
}

// Namespaced per user so an abandoned signup attempt in the same browser
// tab can never prefill (or overwrite) a different signed-in account's
// wizard state — see the UX audit's B2 finding, where a global key did
// exactly that.
function storageKey(userId: string): string {
  return `gb_onboarding:${userId}`;
}

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

function loadSeed(userId: string): OnboardingState {
  if (typeof window === "undefined") return DEFAULT_STATE;
  try {
    const raw = sessionStorage.getItem(storageKey(userId));
    return raw
      ? { ...DEFAULT_STATE, ...JSON.parse(raw) }
      : { ...DEFAULT_STATE, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  } catch {
    return DEFAULT_STATE;
  }
}

export default function Onboarding({ loaderData }: Route.ComponentProps) {
  const { userId } = loaderData;
  const [searchParams, setSearchParams] = useSearchParams();
  const step = Math.min(4, Math.max(1, Number(searchParams.get("step")) || 1));
  const [state, setState] = useState<OnboardingState>(DEFAULT_STATE);

  // Seed from sessionStorage on mount only (not SSR — nothing here is
  // stored server-side until a Connection exists, and this route never
  // renders on the server with meaningful data anyway).
  useEffect(() => {
    setState(loadSeed(userId));
  }, [userId]);

  function update(patch: Partial<OnboardingState>) {
    setState((prev) => {
      const next = { ...prev, ...patch };
      try {
        sessionStorage.setItem(storageKey(userId), JSON.stringify(next));
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

// Mirrors core's isValidShopDomain() — duplicated rather than imported
// because that one lives server-side (core/src/platforms/shopify.ts) and
// this needs to run client-side before the browser ever leaves the wizard.
const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

/* Carries the full accumulated payload to the real connect flow — a plain
   <Form>, not a fetcher, so the browser can follow the action's redirect to
   Shopify's real (cross-origin) authorize URL. Reused by steps 3 and 4.
   Validates the domain client-side first: a typo used to submit straight
   to /connect/shopify, which discarded everything typed here and stranded
   the user on that standalone page with no way back (UX audit's R5
   finding) — now it never leaves this screen. */
function ShopifyConnectForm({ state, submitLabel }: { state: OnboardingState; submitLabel: string }) {
  const [shop, setShop] = useState("");
  const [touched, setTouched] = useState(false);
  const invalid = touched && shop.length > 0 && !SHOP_DOMAIN_RE.test(shop);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    if (!SHOP_DOMAIN_RE.test(shop)) {
      e.preventDefault();
      setTouched(true);
    }
  }

  return (
    <form method="post" action="/connect/shopify" className="flex flex-col gap-3" onSubmit={handleSubmit}>
      <input type="hidden" name="ob_preset" value={state.preset} />
      {state.businessName && <input type="hidden" name="ob_business_name" value={state.businessName} />}
      {state.email && <input type="hidden" name="ob_business_email" value={state.email} />}
      {state.phone && <input type="hidden" name="ob_business_phone" value={state.phone} />}
      {state.timezone && <input type="hidden" name="ob_timezone" value={state.timezone} />}
      {state.resourceName && <input type="hidden" name="ob_resource_name" value={state.resourceName} />}
      <input type="hidden" name="ob_reminders_on" value={state.remindersOn ? "on" : ""} />
      <Field label="Shopify store domain" error={invalid ? "Enter a valid *.myshopify.com domain." : undefined}>
        <Input
          name="shop"
          placeholder="your-store.myshopify.com"
          required
          value={shop}
          onChange={(e) => setShop(e.target.value)}
          onBlur={() => setTouched(true)}
        />
      </Field>
      <button type="submit" className="btn-pri w-full justify-center">{submitLabel}</button>
    </form>
  );
}

/* The non-Shopify exit: posts straight to this route's own action, which
   creates a manual Connection and applies everything gathered so far right
   away (see the module header comment — this is what makes B1/B3 fixable at
   all without Shopify). */
function GoLiveWithoutShopifyForm({ state, submitLabel }: { state: OnboardingState; submitLabel: string }) {
  return (
    <form method="post" className="flex flex-col gap-3">
      <input type="hidden" name="preset" value={state.preset} />
      <input type="hidden" name="business_name" value={state.businessName} />
      <input type="hidden" name="business_email" value={state.email} />
      <input type="hidden" name="business_phone" value={state.phone} />
      <input type="hidden" name="timezone" value={state.timezone} />
      <input type="hidden" name="resource_name" value={state.resourceName} />
      <input type="hidden" name="reminders_on" value={state.remindersOn ? "on" : ""} />
      <button type="submit" className="btn-sec w-full justify-center">{submitLabel}</button>
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
            <Field
              label="Phone number"
              error={state.phone && !isValidPhone(state.phone) ? "Enter a valid phone number." : undefined}
            >
              <Input
                type="tel"
                value={state.phone}
                onChange={(e) => update({ phone: e.target.value })}
                placeholder="+1 555 0100"
                pattern={PHONE_PATTERN}
                autoComplete="tel"
              />
            </Field>
            <Field label="Timezone">
              <TimezoneSelect value={state.timezone} onChange={(timezone) => update({ timezone })} />
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
  const [touched, setTouched] = useState(false);
  const nameMissing = touched && !state.resourceName.trim();

  function handleNext() {
    if (!state.resourceName.trim()) {
      setTouched(true);
      return;
    }
    onNext();
  }

  return (
    <>
      <h1 className="ob-h1">Your setup</h1>
      <PresetScaffold presetId={state.preset} />
      <div className="card p-[18px]">
        <h2 className="card-title mb-3">Add your first {getPreset(state.preset).vocab.resource.toLowerCase()}</h2>
        <Field
          label="Name"
          hint={nameMissing ? undefined : "A staff member, room, table or bay — whatever takes your bookings. You can add more later."}
          error={nameMissing ? "A booking system needs at least one of these — add a name to continue." : undefined}
        >
          <Input value={state.resourceName} onChange={(e) => update({ resourceName: e.target.value })} placeholder="e.g. Alex Rivera" />
        </Field>
      </div>
      <div className="flex justify-between">
        <button type="button" className="btn-sec" onClick={onBack}>Back</button>
        <button type="button" className="btn-pri" onClick={handleNext}>Continue</button>
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
            <span className="text-body font-medium text-muted">Invite your team</span>
            <span className="rounded-full bg-neutral-bg px-[7px] py-[2px] text-[11px] font-medium text-neutral">Coming soon</span>
          </div>
        </div>
      </div>
      <div className="card p-[18px]">
        <h2 className="card-title mb-3">Finish setup</h2>
        <p className="mb-3 -mt-1 text-meta text-muted">
          Connect Shopify to sync your product catalogue as bookable services, or go live now and connect a
          store later from Settings.
        </p>
        <ShopifyConnectForm state={state} submitLabel="Connect your store & go live" />
        <div className="my-4 flex items-center gap-3 text-meta text-muted">
          <span className="h-px flex-1 bg-line" />
          or
          <span className="h-px flex-1 bg-line" />
        </div>
        <GoLiveWithoutShopifyForm state={state} submitLabel="Go live without Shopify" />
      </div>
      <div className="flex justify-start">
        <button type="button" className="btn-sec" onClick={onBack}>Back</button>
      </div>
    </>
  );
}
