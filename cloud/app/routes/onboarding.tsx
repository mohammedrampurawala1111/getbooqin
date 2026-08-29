import { randomUUID } from "node:crypto";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { redirect, useFetcher, useSearchParams } from "react-router";
import type { Route } from "./+types/onboarding";
import { getClerkClient, requireUserSession } from "~/session.server";
import { AlertError, Field, Input, Toggle, TimezoneSelect } from "~/components/ui";
import { OnboardingShell, PresetTiles, PresetScaffold, IntegrationRow } from "~/components/onboarding";
import { INTEGRATIONS, getPreset, type PresetId } from "~/lib/presets";
import { PHONE_PATTERN, isValidPhone } from "~/lib/validation";
import { CURRENCIES, guessCurrency } from "~/lib/currency";
import { Data, Settings, createManualConnection, getUserConnection, listUserConnections } from "getbooqin-core";

// Two ways to leave this wizard with a working account: connect a real
// Shopify store (ShopifyConnectForm below — answers ride through the OAuth
// state to connect.shopify.callback.tsx, since there's no Connection row to
// attach them to until that store exists), or "Go live without Shopify"
// (handleGoLive below), which applies everything to a manual, non-Shopify
// Connection created back on step 1.
//
// That Connection is created (and saved to) on every step's Continue, not
// just at the end — a re-test found that clicking Continue on step 1 fired
// no network request at all, so a name typed there and never submitted
// could vanish, and cross-account bleed was possible because the only
// record of progress lived in a sessionStorage key (UX audit's B1/B2
// findings). Persisting each step server-side against a real Connection
// closes both: there's nothing left in the browser to leak, and nothing
// entered is lost if the tab closes before step 4.
export const meta: Route.MetaFunction = () => [{ title: "Set up your business · GetBooqin" }];

export async function loader({ request }: Route.LoaderArgs) {
  const session = await requireUserSession(request);
  const url = new URL(request.url);

  // No `cid` means this isn't a draft already in progress — if the account
  // already has a store, this is a stale/bookmarked link or the Back
  // button after finishing, and letting step 1's Continue run again would
  // silently mint a second manual Connection with no way back to the first
  // (UX audit's D1 finding). Same "active connections" definition
  // dashboard.tsx's loader uses, so the two routes agree on what "already
  // set up" means. Deliberately adding another store is Settings ›
  // Integrations' own "+ Connect a Shopify store" flow, not this wizard.
  if (!url.searchParams.get("cid")) {
    const connections = await listUserConnections(session.userId);
    const active = connections.find((c) => c.status === "active");
    if (active) throw redirect(`/dashboard/${active.id}`);
  }

  // Best-effort carry from signup.tsx's own business-name/preset/phone
  // fields (query params, not sessionStorage — a mismatched storage key
  // between signup.tsx and this route used to mean that data never arrived
  // here at all, UX audit's N1 finding). Only read once, on the very first
  // render of step 1; every step past that already has its own Continue
  // saving real values, so there's nothing left to seed from the URL.
  const clerkUser = await getClerkClient().users.getUser(session.userId);
  const email =
    clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId)?.emailAddress ??
    clerkUser.emailAddresses[0]?.emailAddress ??
    "";

  const seed = {
    businessName: url.searchParams.get("business_name") || "",
    preset: (url.searchParams.get("preset") as PresetId) || undefined,
    phone: url.searchParams.get("phone") || "",
    // The account already has this — retyping it two screens after signing
    // up was a regression from an earlier version that did prefill it (UX
    // audit's D3 finding). Still editable: a merchant's booking contact
    // address is often not the login email.
    email,
  };
  return { userId: session.userId, seed };
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "service";
}

type ActionResult = { connectionId?: string; error?: string };

async function handleStep1(userId: string, form: FormData): Promise<ActionResult> {
  const cid = String(form.get("cid") || "");
  let connection = cid ? await getUserConnection(userId, cid) : null;
  if (!connection || connection.platform !== "manual") {
    connection = await createManualConnection({ userId });
  }
  const { shop, platform } = connection;

  const businessName = String(form.get("business_name") || "").trim();
  const businessEmail = String(form.get("business_email") || "").trim();
  const businessPhone = String(form.get("business_phone") || "").trim();
  const timezone = String(form.get("timezone") || "").trim();
  const currency = String(form.get("currency") || "").trim();
  const currencySymbol = String(form.get("currency_symbol") || "").trim();
  const presetId = String(form.get("preset") || "").trim();

  const settingsPatch: Record<string, string> = {};
  if (businessName) settingsPatch.business_name = businessName;
  if (businessEmail) settingsPatch.business_email = businessEmail;
  if (businessPhone) settingsPatch.business_phone = businessPhone;
  if (timezone) settingsPatch.timezone = timezone;
  if (currency) settingsPatch.currency = currency;
  if (currencySymbol) settingsPatch.currency_symbol = currencySymbol;
  if (Object.keys(settingsPatch).length > 0) {
    await Settings.setSettings(shop, platform, settingsPatch);
  }

  if (presetId) {
    await Settings.applyPreset(shop, platform, presetId);

    // Materialize the preset's sample services for real. Previously step 2
    // showed "4 of 4 selected" for these and the dashboard still reported
    // "0 added" — applying a preset only ever wrote vocabulary/scheduling
    // defaults, nothing actually created a bookable service from it (UX
    // audit's N4 finding). Guarded to run once: re-submitting step 1 (e.g.
    // after going Back) shouldn't duplicate services that already exist.
    const existingServices = await Data.catalogServices(shop, platform, false);
    if (existingServices.length === 0) {
      for (const svc of getPreset(presetId).services) {
        const productId = randomUUID();
        const productHandle = `${slugify(svc.name)}-${productId.slice(0, 8)}`;
        await Data.upsertProductCache(shop, platform, {
          productId,
          productHandle,
          title: svc.name,
          description: "",
          category: "",
          price: 0,
        });
        await Data.saveServiceConfig(shop, platform, {
          product_id: productId,
          product_handle: productHandle,
          duration_min: svc.minutes,
        });
      }
    }
  }

  return { connectionId: connection.id };
}

async function handleStep2(userId: string, form: FormData): Promise<ActionResult> {
  const cid = String(form.get("cid") || "");
  const connection = cid ? await getUserConnection(userId, cid) : null;
  if (!connection || connection.platform !== "manual") {
    return { error: "Something went wrong — go back to the previous step and try again." };
  }

  const resourceName = String(form.get("resource_name") || "").trim();
  if (resourceName) {
    await Data.saveResource(connection.shop, connection.platform, {
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

  return { connectionId: connection.id };
}

async function handleGoLive(userId: string, form: FormData) {
  const cid = String(form.get("cid") || "");
  let connection = cid ? await getUserConnection(userId, cid) : null;
  // Defensive fallback only — with JS enabled, step 1's Continue always
  // creates this connection first, so `cid` should already be set by the
  // time this submits.
  if (!connection || connection.platform !== "manual") {
    connection = await createManualConnection({ userId });
  }

  const remindersOn = form.get("reminders_on") === "on";
  await Settings.setSettings(connection.shop, connection.platform, {
    reminder_enabled: remindersOn,
    onboarding_completed: true,
  });

  throw redirect(`/dashboard/${connection.id}`);
}

export async function action({ request }: Route.ActionArgs) {
  const session = await requireUserSession(request);
  const form = await request.formData();
  const intent = String(form.get("_intent") || "");

  if (intent === "step1") return handleStep1(session.userId, form);
  if (intent === "step2") return handleStep2(session.userId, form);
  if (intent === "golive") return handleGoLive(session.userId, form);
  return { error: "Unknown step." };
}

type OnboardingState = {
  businessName: string;
  preset: PresetId;
  email: string;
  phone: string;
  timezone: string;
  currency: string;
  currencySymbol: string;
  teamSize: string;
  resourceName: string;
  remindersOn: boolean;
};

export default function Onboarding({ loaderData }: Route.ComponentProps) {
  const { seed } = loaderData;
  const [searchParams, setSearchParams] = useSearchParams();
  const step = Math.min(4, Math.max(1, Number(searchParams.get("step")) || 1));
  const cid = searchParams.get("cid") || "";

  const [state, setState] = useState<OnboardingState>(() => {
    const timezone = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";
    const guessed = guessCurrency(timezone);
    return {
      businessName: seed.businessName,
      preset: seed.preset ?? "generic",
      email: seed.email,
      phone: seed.phone,
      timezone,
      currency: guessed.code,
      currencySymbol: guessed.symbol,
      teamSize: "1",
      resourceName: "",
      remindersOn: true,
    };
  });

  function update(patch: Partial<OnboardingState>) {
    setState((prev) => ({ ...prev, ...patch }));
  }

  const fetcher = useFetcher<ActionResult>();
  const [error, setError] = useState<string | null>(null);
  const pendingStepRef = useRef<number | null>(null);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || pendingStepRef.current === null) return;
    const result = fetcher.data;
    const toStep = pendingStepRef.current;
    pendingStepRef.current = null;
    if (result.error) {
      setError(result.error);
      return;
    }
    setError(null);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("step", String(toStep));
      if (result.connectionId) next.set("cid", result.connectionId);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const saving = fetcher.state !== "idle";

  function goToStep(n: number) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("step", String(n));
      return next;
    });
  }

  function submitStep1(toStep: number) {
    const fd = new FormData();
    fd.set("_intent", "step1");
    if (cid) fd.set("cid", cid);
    fd.set("business_name", state.businessName);
    fd.set("preset", state.preset);
    fd.set("business_email", state.email);
    fd.set("business_phone", state.phone);
    fd.set("timezone", state.timezone);
    fd.set("currency", state.currency);
    fd.set("currency_symbol", state.currencySymbol);
    pendingStepRef.current = toStep;
    fetcher.submit(fd, { method: "post" });
  }

  function submitStep2(toStep: number) {
    const fd = new FormData();
    fd.set("_intent", "step2");
    fd.set("cid", cid);
    fd.set("resource_name", state.resourceName);
    pendingStepRef.current = toStep;
    fetcher.submit(fd, { method: "post" });
  }

  return (
    <OnboardingShell step={step} onStep={goToStep} finishLaterHref="/connect/shopify">
      {error && <AlertError className="mb-1">{error}</AlertError>}
      {step === 1 && (
        <StepBusiness state={state} update={update} saving={saving} onNext={() => submitStep1(2)} />
      )}
      {step === 2 && (
        <StepSetup
          state={state}
          update={update}
          saving={saving}
          onNext={() => submitStep2(3)}
          onBack={() => goToStep(1)}
        />
      )}
      {step === 3 && (
        <StepIntegrations state={state} cid={cid} onNext={() => goToStep(4)} onBack={() => goToStep(2)} />
      )}
      {step === 4 && <StepGoLive state={state} cid={cid} update={update} onBack={() => goToStep(3)} />}
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
   finding) — now it never leaves this screen. `cid`, when set, is the
   manual draft Connection step 1 already created — carried through so the
   callback can delete it once a real Shopify Connection exists instead. */
function ShopifyConnectForm({ state, cid, submitLabel }: { state: OnboardingState; cid: string; submitLabel: string }) {
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
      {cid && <input type="hidden" name="ob_draft_connection_id" value={cid} />}
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

/* The non-Shopify exit: posts to this route's own action (intent=golive),
   which finalizes the manual Connection step 1 already created. */
function GoLiveWithoutShopifyForm({
  state, cid, submitLabel,
}: { state: OnboardingState; cid: string; submitLabel: string }) {
  return (
    <form method="post" className="flex flex-col gap-3">
      <input type="hidden" name="_intent" value="golive" />
      <input type="hidden" name="cid" value={cid} />
      <input type="hidden" name="reminders_on" value={state.remindersOn ? "on" : ""} />
      <button type="submit" className="btn-sec w-full justify-center">{submitLabel}</button>
    </form>
  );
}

function StepBusiness({
  state, update, saving, onNext,
}: {
  state: OnboardingState;
  update: (p: Partial<OnboardingState>) => void;
  saving: boolean;
  onNext: () => void;
}) {
  return (
    <>
      <h1 className="ob-h1">Tell us about your business</h1>
      <div className="card p-[18px]">
        <div className="flex flex-col gap-[14px]">
          <div className="flex flex-col gap-[6px]">
            <span className="field-label">What does your business do?</span>
            <PresetTiles value={state.preset} onPick={(preset) => update({ preset })} columns={2} />
          </div>
          <Field label="Business name">
            <Input value={state.businessName} onChange={(e) => update({ businessName: e.target.value })} />
          </Field>
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
            <Field label="Currency">
              <select
                value={state.currency}
                onChange={(e) => {
                  const currency = CURRENCIES.find((c) => c.code === e.target.value);
                  update({ currency: e.target.value, currencySymbol: currency?.symbol ?? state.currencySymbol });
                }}
                className="input cursor-pointer"
              >
                {CURRENCIES.map((c) => (
                  <option key={c.code} value={c.code}>{c.label}</option>
                ))}
              </select>
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
        <button type="button" className="btn-pri" onClick={onNext} disabled={saving}>
          {saving ? "Saving…" : "Continue"}
        </button>
      </div>
    </>
  );
}

function StepSetup({
  state, update, saving, onNext, onBack,
}: {
  state: OnboardingState;
  update: (p: Partial<OnboardingState>) => void;
  saving: boolean;
  onNext: () => void;
  onBack: () => void;
}) {
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
        <button type="button" className="btn-sec" onClick={onBack} disabled={saving}>Back</button>
        <button type="button" className="btn-pri" onClick={handleNext} disabled={saving}>
          {saving ? "Saving…" : "Continue"}
        </button>
      </div>
    </>
  );
}

function StepIntegrations({
  state, cid, onNext, onBack,
}: { state: OnboardingState; cid: string; onNext: () => void; onBack: () => void }) {
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
              <ShopifyConnectForm state={state} cid={cid} submitLabel="Connect Shopify" />
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
  state, cid, update, onBack,
}: { state: OnboardingState; cid: string; update: (p: Partial<OnboardingState>) => void; onBack: () => void }) {
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
        <ShopifyConnectForm state={state} cid={cid} submitLabel="Connect your store & go live" />
        <div className="my-4 flex items-center gap-3 text-meta text-muted">
          <span className="h-px flex-1 bg-line" />
          or
          <span className="h-px flex-1 bg-line" />
        </div>
        <GoLiveWithoutShopifyForm state={state} cid={cid} submitLabel="Go live without Shopify" />
      </div>
      <div className="flex justify-start">
        <button type="button" className="btn-sec" onClick={onBack}>Back</button>
      </div>
    </>
  );
}
