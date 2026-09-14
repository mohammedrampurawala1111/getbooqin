import { useEffect, useRef, useState, type FormEvent } from "react";
import { redirect, useFetcher, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/onboarding";
import { getClerkClient, requireUserSession, ensureUserRow } from "~/session.server";
import { AlertError, Field, Input, Toggle, TimezoneSelect } from "~/components/ui";
import { OnboardingShell, PresetTiles, PresetScaffold, STEP_NAMES } from "~/components/onboarding";
import { starterTemplate, templateCard, vocabFor, SERVICE_SWATCHES } from "~/lib/presets";
import { PHONE_PATTERN, isValidPhone } from "~/lib/validation";
import { CURRENCIES, guessCurrency } from "~/lib/currency";
// The plan table, not the server-side entitlement machinery — this
// subpath is import-free by design so the pricing copy can render in
// the browser. See core/src/billing/plans.ts.
import { PLANS, PRICES, TRIAL_DAYS, TRIAL_PLAN, billingCurrencyFor, formatPrice, visiblePlans } from "getbooqin-core/billing/plans";
import { getAppUrl } from "~/lib/env.server";
import { Data, Settings, Team, Lifecycle, TestBooking, createManualConnection, getUserConnection, listUserConnections, isGetBooqinError } from "getbooqin-core";

// Two ways to leave this wizard with a working account: connect a real
// Shopify store (answers used to ride through the OAuth
// state to connect.shopify.callback.tsx, since there's no Connection row to
// attach them to until that store exists), or "Go live without Shopify"
// (handleGoLive below), which applies everything to a manual, non-Shopify
// Connection created by the loader below, before step 1 ever renders.
//
// Each step's Continue saves real values against that Connection (not just
// at the end) — a re-test found that clicking Continue on step 1 fired no
// network request at all, so a name typed there and never submitted could
// vanish, and cross-account bleed was possible because the only record of
// progress lived in a sessionStorage key (UX audit's B1/B2 findings).
// Persisting each step server-side closes both: there's nothing left in the
// browser to leak, and nothing entered past step 1 is lost if the tab
// closes early.
//
// The Connection itself used to come from step 1's first successful
// Continue instead of the loader — which meant anyone who left before that
// (the wizard's own "Finish later" link, a closed tab, browser back) had no
// Connection yet, so /dashboard's "no active connection → back to
// onboarding" redirect sent them right back to where they started, reading
// as stuck. Creating it on first render closes that gap for every exit
// point at once, not just "Finish later" specifically.
export const meta: Route.MetaFunction = () => [{ title: "Set up your business · GetBooqin" }];

export async function loader({ request }: Route.LoaderArgs) {
  const session = await requireUserSession(request);
  const url = new URL(request.url);

  // No `cid` means this isn't a draft already in progress — check for an
  // existing active connection first (same "active connections" definition
  // dashboard.tsx's loader uses, so the two routes agree on what "already
  // set up" means) before creating anything, or a stale/bookmarked link or
  // the Back button after finishing would silently mint a second manual
  // Connection with no way back to the first (UX audit's D1 finding).
  // Deliberately adding another store is Settings › Integrations' own
  // "+ Connect a Shopify store" flow, not this wizard.
  if (!url.searchParams.get("cid")) {
    // An invited teammate lands here on their very first authenticated
    // request — either of signup.tsx's own two paths (password or
    // Google), or dashboard.tsx's own "no active connection -> onboarding"
    // redirect — and /signup itself has no concept of invites at all, so
    // this is the one choke point every post-auth path funnels through
    // before a Connection gets created below. Checked first, ahead of even
    // the "already has an active connection" check right after it, so a
    // pending invite always wins over creating a throwaway business
    // (QA report's BUG-1: this used to be unconditional, so an invited
    // email that went through /signup instead of its emailed link ended up
    // owning a brand-new business with the real invite never consumed).
    const clerkUser = await getClerkClient().users.getUser(session.userId);
    const email =
      clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId)?.emailAddress ??
      clerkUser.emailAddresses[0]?.emailAddress ??
      "";
    const pendingInvite = email ? await Team.findPendingInviteForEmail(email) : null;
    if (pendingInvite) throw redirect(`/invite/${pendingInvite.token}`);

    const connections = await listUserConnections(session.userId);
    const active = connections.find((c) => c.status === "active");
    if (active) throw redirect(`/dashboard/${active.id}`);

    // Genuinely nothing yet — create the manual draft right here, before
    // step 1 ever renders, rather than waiting for its first successful
    // Continue (see header comment). Redirecting with `cid` now set means
    // every subsequent render of this route — any step, a rail-jump, a
    // reload — carries it, so this branch can't run twice and mint a
    // second draft for the same visit.
    await ensureUserRow(session.userId);
    const draft = await createManualConnection({ userId: session.userId });
    url.searchParams.set("cid", draft.id);
    throw redirect(`${url.pathname}?${url.searchParams.toString()}`);
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
    preset: url.searchParams.get("preset") || undefined,
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

type ActionResult = {
  connectionId?: string;
  error?: string;
  testBooking?: Awaited<ReturnType<typeof TestBooking.createTestBooking>>;
};

async function handleStep1(userId: string, form: FormData): Promise<ActionResult> {
  const cid = String(form.get("cid") || "");
  let connection = cid ? await getUserConnection(userId, cid) : null;
  if (!connection || connection.platform !== "manual") {
    await ensureUserRow(userId);
    connection = await createManualConnection({ userId });
  }
  const { shop, platform } = connection;

  // Pinned here, at the first save, rather than only at go-live. It is
  // knowable the moment the Connection exists, and every email sent
  // before go-live — a test booking, most obviously — otherwise carries
  // a manage link pointing at `https://manual-<uuid>`, which is
  // defaultSettings()'s guess for a Shopify domain and nowhere at all
  // for a manual account.
  await Settings.setSettings(shop, platform, { booking_page_url: `${getAppUrl()}/book/${connection.id}` });

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
    // The one and only time a starter template is read on this account:
    // its vocabulary and slot interval are copied onto the shop as
    // ordinary settings the merchant can then edit freely, and `preset`
    // is kept as a plain label for analytics (see core's presets.ts).
    const template = starterTemplate(presetId);
    await Settings.setSettings(shop, platform, {
      preset: template.id,
      terms: template.terms,
      slot_interval: template.slotInterval,
    });

    // Materialize the template's sample services for real. Previously
    // step 2 showed "4 of 4 selected" for these and the dashboard still
    // reported "0 added" — applying a preset only ever wrote
    // vocabulary/scheduling defaults, nothing actually created a bookable
    // service from it (UX audit's N4 finding). Guarded to run once:
    // re-submitting step 1 (e.g. after going Back) shouldn't duplicate
    // services that already exist.
    const existingServices = await Data.catalogServices(shop, platform, false);
    if (existingServices.length === 0) {
      const services = template.services;
      for (let i = 0; i < services.length; i++) {
        const svc = services[i];
        // Web Crypto's global `crypto`, not `node:crypto` — see
        // settings.tsx's identical fix for why an explicit node:crypto
        // import here breaks the client bundle.
        const productId = crypto.randomUUID();
        const productHandle = `${slugify(svc.name)}-${productId.slice(0, 8)}`;
        await Data.upsertProductCache(shop, platform, {
          productId,
          productHandle,
          title: svc.name,
          description: "",
          category: "",
          // Unpriced. See StarterTemplate in core's presets.ts — a
          // template can guess a duration, never a price, and the
          // wizard never shows these before the page goes live.
          price: 0,
        });
        await Data.saveServiceConfig(shop, platform, {
          product_id: productId,
          product_handle: productHandle,
          duration_min: svc.minutes,
          location_type: svc.location ?? "onsite",
          color: SERVICE_SWATCHES[i % SERVICE_SWATCHES.length],
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
    // This step just showed the merchant their industry's default business
    // hours a moment earlier, but never carried them into the resource it
    // creates — the resource landed with every day off and 0 bookable
    // hours, so a merchant could finish onboarding, "go live", and have
    // nothing a customer could actually book (UX audit's B1 finding).
    // dashboard.$connectionId.resources.$resourceId.tsx's loader already
    // seeds a brand-new resource's schedule this same way when it's added
    // from the dashboard's own "Add resource" page — this is a separate
    // code path (onboarding saves the resource directly, server-side) that
    // needs the identical seeding, not a shared helper worth extracting for
    // two call sites this small.
    const settings = await Settings.getSettings(connection.shop, connection.platform);
    const template = templateCard(settings.preset);
    const [start, end] = template.range.split("–");
    const schedule: Array<{ day: number; start: string; end: string }> = [];
    for (let day = 0; day < 7; day++) {
      // Schedule.day is Sunday-first (0=Sunday); template.open is Monday-first.
      const templateDay = day === 0 ? 6 : day - 1;
      if (template.open[templateDay]) schedule.push({ day, start, end });
    }

    // Every preset-seeded service from step 1 has no resource assigned yet
    // — nothing existed to assign it to at that point — and this is the
    // first resource the business has, so there's no real choice to make
    // yet either. Assigning it to everything by default (rather than
    // service_ids: []) is what actually makes the preset bookable; a merchant
    // who deliberately wants a narrower assignment can still change it from
    // the resource's own page afterwards (Defect Dossier's BQ-05 finding —
    // the other half of the fix, resourcesForService()'s fallback in
    // core/src/booking/data.ts, means this is now a real default rather
    // than a fallback masking an unset one).
    const existingServices = await Data.catalogServices(connection.shop, connection.platform, false);

    await Data.saveResource(connection.shop, connection.platform, {
      name: resourceName,
      title: "",
      email: "",
      phone: "",
      description: "",
      meeting_link: "",
      timezone: "",
      status: true,
      schedule,
      service_ids: existingServices.map((s) => s.id),
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
    await ensureUserRow(userId);
    connection = await createManualConnection({ userId });
  }

  const remindersOn = form.get("reminders_on") === "on";
  await Settings.setSettings(connection.shop, connection.platform, {
    reminder_enabled: remindersOn,
    onboarding_completed: true,
    // Chose this over connecting Shopify/Stripe here — a deliberate answer,
    // not an unfinished step, so the Overview checklist's "Connect a
    // channel" item shouldn't nag about it forever (UX audit's B1 finding).
    channel_setup_skipped: true,
    // defaultSettings()'s own booking_page_url (`https://${shop}`) is
    // correct for a real Shopify domain but meaningless for a manual
    // connection, whose `shop` is just an opaque manual-<uuid> key — every
    // confirmation/cancel email's manage link (Bookings.manageUrl) was
    // silently pointing at an unreachable URL until this pinned it to the
    // real public booking page instead.
    booking_page_url: `${getAppUrl()}/book/${connection.id}`,
  });

  // After setSettings, because the welcome email hands over the booking
  // link and reads it from settings. Not awaited: a merchant clicking
  // "Go live" should land on their dashboard at SMTP speed or better,
  // and an email that fails to send is not a reason to fail going live
  // — sendWelcome() claims-then-releases, so the next attempt still
  // works.
  void Lifecycle.sendWelcome(connection.id).catch((err) =>
    console.error(`[getbooqin] welcome email failed for connection ${connection.id}:`, err)
  );

  throw redirect(`/dashboard/${connection.id}`);
}

/**
 * Puts a real booking through the real path, addressed to the merchant
 * themselves — see core's testBooking.ts. Returns what happened rather
 * than redirecting: the merchant should stay on this step and watch it
 * work.
 */
async function handleTestBooking(userId: string, form: FormData): Promise<ActionResult> {
  const cid = String(form.get("cid") || "");
  const connection = cid ? await getUserConnection(userId, cid) : null;
  if (!connection) return { error: "Something went wrong — go back to the previous step and try again." };

  const booking = await TestBooking.createTestBooking(connection.id);
  return { testBooking: booking };
}

export async function action({ request }: Route.ActionArgs) {
  const session = await requireUserSession(request);
  const form = await request.formData();
  const intent = String(form.get("_intent") || "");

  // One catch for all three steps rather than three. Onboarding can hit
  // a plan limit for real — a user who already has a business and is
  // creating a second on a one-location plan — and an uncaught
  // GetBooqinError would render that as a 500 in the middle of signup,
  // which is the worst possible place to say "something went wrong"
  // instead of "your plan includes one business".
  try {
    if (intent === "step1") return await handleStep1(session.userId, form);
    if (intent === "step2") return await handleStep2(session.userId, form);
    if (intent === "golive") return await handleGoLive(session.userId, form);
    if (intent === "test_booking") return await handleTestBooking(session.userId, form);
  } catch (err) {
    if (isGetBooqinError(err)) return { error: err.message };
    throw err;
  }
  return { error: "Unknown step." };
}

type OnboardingState = {
  businessName: string;
  preset: string;
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
  const step = Math.min(STEP_NAMES.length, Math.max(1, Number(searchParams.get("step")) || 1));
  const cid = searchParams.get("cid") || "";

  // "UTC"/USD here, not the browser's real timezone/currency: Intl reads the
  // *server's* clock during SSR and the *visitor's* during hydration's first
  // client render, which must match exactly or React throws a hydration
  // mismatch (#418/#425/#423) on this whole page. The effect below swaps in
  // the real detected values right after mount — a plain client-side update,
  // not part of hydration, so it can safely differ from what SSR rendered.
  const [state, setState] = useState<OnboardingState>(() => ({
    businessName: seed.businessName,
    preset: seed.preset ?? "generic",
    email: seed.email,
    phone: seed.phone,
    timezone: "UTC",
    currency: "USD",
    currencySymbol: "$",
    teamSize: "1",
    resourceName: "",
    remindersOn: true,
  }));

  function update(patch: Partial<OnboardingState>) {
    setState((prev) => ({ ...prev, ...patch }));
  }

  useEffect(() => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const guessed = guessCurrency(timezone);
    update({ timezone, currency: guessed.code, currencySymbol: guessed.symbol });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigate = useNavigate();
  const fetcher = useFetcher<ActionResult>();
  const [error, setError] = useState<string | null>(null);
  // What to do once the in-flight step submission comes back: move on to
  // the next step, or ("finish") leave the wizard for /dashboard. Either
  // way the outcome only fires *after* a real save completes — "Finish
  // later" used to be a plain link straight to /dashboard, so anything
  // picked on step 1/2 (business name, preset, timezone, currency,
  // practitioner name) that hadn't already gone through a "Continue" click
  // was silently dropped: nothing had submitStep1/submitStep2's form yet,
  // so the starter template's vocabulary was never written, and the
  // connection was left on whatever defaultSettings() gave it — "generic"
  // — no matter what the wizard visually showed selected. Reported as
  // "business template doesn't persist... resets to generic,"
  // reproducible specifically via Finish later, not via Continue.
  const pendingOutcomeRef = useRef<{ kind: "advance"; step: number } | { kind: "finish" } | null>(null);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || pendingOutcomeRef.current === null) return;
    const result = fetcher.data;
    const outcome = pendingOutcomeRef.current;
    pendingOutcomeRef.current = null;
    if (result.error) {
      setError(result.error);
      return;
    }
    setError(null);
    if (outcome.kind === "finish") {
      navigate("/dashboard");
      return;
    }
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("step", String(outcome.step));
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

  function submitStep1(outcome: { kind: "advance"; step: number } | { kind: "finish" }) {
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
    pendingOutcomeRef.current = outcome;
    fetcher.submit(fd, { method: "post" });
  }

  function submitStep2(outcome: { kind: "advance"; step: number } | { kind: "finish" }) {
    const fd = new FormData();
    fd.set("_intent", "step2");
    fd.set("cid", cid);
    fd.set("resource_name", state.resourceName);
    pendingOutcomeRef.current = outcome;
    fetcher.submit(fd, { method: "post" });
  }

  // Steps 3/4 hold nothing that isn't already persisted the moment it's
  // set (integration connects submit their own forms immediately; Go
  // Live's own submit *is* finishing) — only 1 and 2 have local-only state
  // that needs a real save before it's safe to leave.
  function finishLater() {
    if (step === 1) submitStep1({ kind: "finish" });
    else if (step === 2) submitStep2({ kind: "finish" });
    else navigate("/dashboard");
  }

  return (
    <OnboardingShell step={step} onStep={goToStep} onFinishLater={finishLater}>
      {error && <AlertError className="mb-1">{error}</AlertError>}
      {step === 1 && (
        <StepBusiness state={state} update={update} saving={saving} onNext={() => submitStep1({ kind: "advance", step: 2 })} />
      )}
      {step === 2 && (
        <StepSetup
          state={state}
          update={update}
          saving={saving}
          onNext={() => submitStep2({ kind: "advance", step: 3 })}
          onBack={() => goToStep(1)}
        />
      )}
      {step === 3 && <StepGoLive state={state} cid={cid} update={update} onBack={() => goToStep(2)} />}
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
  const v = vocabFor(starterTemplate(state.preset).terms);

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
        <h2 className="card-title mb-3">Add your first {v.resourceOne}</h2>
        <Field
          label="Name"
          // Genericized to "staff member, room, table or bay" for every
          // industry, even restaurants (whose "resource" is a table, not a
          // person) and clinics (whose auditor expects "Practitioner", not
          // "staff member") — vocabFor's resourceOne/bookingMany already
          // carry the right noun for this preset (UX audit's #5 finding).
          hint={nameMissing ? undefined : `A ${v.resourceOne} — whatever takes your ${v.bookingMany}. You can add more later.`}
          error={nameMissing ? "A booking system needs at least one of these — add a name to continue." : undefined}
        >
          <Input
            value={state.resourceName}
            onChange={(e) => update({ resourceName: e.target.value })}
            // A person's name doesn't fit every industry's resource — an
            // automotive account's first resource is a bay, not someone
            // named Alex Rivera (UX audit's B6 finding).
            placeholder={`e.g. ${v.resourceOne.charAt(0).toUpperCase()}${v.resourceOne.slice(1)} 1`}
          />
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

function StepGoLive({
  state, cid, update, onBack,
}: { state: OnboardingState; cid: string; update: (p: Partial<OnboardingState>) => void; onBack: () => void }) {
  const v = vocabFor(starterTemplate(state.preset).terms);
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
          {/* Team invites ship — roles, invite emails, the accept flow,
              a Settings page. Calling it "coming soon" here meant a
              merchant with staff finished setup believing multi-user
              did not exist, and never opened Settings → Team. The
              landing page sells it on the same day. */}
          <a
            href={`/dashboard/${cid}/settings?page=team`}
            className="flex items-center justify-between gap-[10px] rounded-[9px] border border-line bg-canvas-alt px-3 py-[11px] no-underline hover:border-brand-500 hover:no-underline"
          >
            <span className="flex flex-col">
              <span className="text-body font-medium text-ink">Invite your team</span>
              <span className="text-[12px] text-muted">Add staff with their own login and permissions.</span>
            </span>
            <span className="text-brand-600">&rarr;</span>
          </a>
        </div>
      </div>
      {/* Going live is now the single action. This step used to lead
          with "Connect your store & go live", with going live on its own
          framed as the fallback — which was already backwards for a
          product most of whose accounts have no Shopify store, and is
          simply broken now that Shopify is shipped dark: the primary
          button led straight to a 402. An account that has been granted
          Shopify connects it from Settings → Integrations. */}
      <div className="card p-[18px]">
        <h2 className="card-title mb-3">Finish setup</h2>
        <p className="mb-3 -mt-1 text-meta text-muted">
          Your booking link is ready. Go live and share it — you can add {v.services.toLowerCase()}, hours and
          integrations any time from Settings.
        </p>
        <GoLiveWithoutShopifyForm state={state} cid={cid} submitLabel="Go live" />
      </div>
      <TestBookingCard cid={cid} vocab={v} />
      <PlanStrip currency={state.currency} timezone={state.timezone} />
      <div className="flex justify-start">
        <button type="button" className="btn-sec" onClick={onBack}>Back</button>
      </div>
    </>
  );
}

/**
 * The 30-second proof that the thing works.
 *
 * Its own fetcher, not the step's form: this must not submit the
 * go-live form, and the merchant should be able to press it, read the
 * result, and then go live — in that order, on one screen.
 */
/**
 * What happens after the trial, said before they go live rather than in
 * an email three weeks later.
 *
 * No buttons. Asking someone to choose a plan in the middle of setup,
 * before they have seen the product take a single booking, converts
 * badly and reads as a bait-and-switch; the job here is only to make
 * sure nobody is surprised. The actual choice lives on Settings →
 * Billing, and the trial nudges point at it.
 *
 * Prices are shown in the currency this account will actually be billed
 * in — derived the same way the mandate will derive it, from the
 * currency and timezone picked on step 1, rather than assuming dollars.
 */
function PlanStrip({ currency, timezone }: { currency: string; timezone: string }) {
  const billingCurrency = billingCurrencyFor({ currency, timezone });
  const paid = visiblePlans().filter((plan) => plan.id !== "free");

  return (
    <div className="card p-[18px]">
      <h2 className="card-title mb-1">
        You're on {PLANS[TRIAL_PLAN].name}, free for {TRIAL_DAYS} days
      </h2>
      <p className="m-0 mb-3 text-meta text-muted">
        No card needed now. When the trial ends you can pick a plan or stay on Free — nothing is deleted either
        way, and your booking page keeps working.
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        {paid.map((plan) => {
          const price = PRICES[plan.id as keyof typeof PRICES]?.[billingCurrency]?.monthly;
          const trial = plan.id === TRIAL_PLAN;
          return (
            <div
              key={plan.id}
              className={`rounded-[9px] border px-3 py-[11px] ${trial ? "border-brand-600 bg-brand-50" : "border-line bg-canvas-alt"}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-body font-medium">{plan.name}</span>
                {trial && <span className="text-[11px] font-medium text-brand-600">Your trial</span>}
              </div>
              <span className="num text-[13px] text-muted">
                {price ? `${formatPrice(price.amount, billingCurrency)}/mo` : "—"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TestBookingCard({ cid, vocab }: { cid: string; vocab: ReturnType<typeof vocabFor> }) {
  const fetcher = useFetcher<ActionResult>();
  const sending = fetcher.state !== "idle";
  const result = fetcher.data?.testBooking;
  const error = fetcher.data?.error;

  return (
    <div className="card p-[18px]">
      <h2 className="card-title mb-1">See it work first</h2>
      <p className="mb-3 text-meta text-muted">
        Books you in as if you were a customer — a real {vocab.bookingOne.toLowerCase()}, the real confirmation
        email, in your real calendar. Cancel it afterwards in one click.
      </p>

      {error && <AlertError>{error}</AlertError>}

      {result ? (
        <div className="rounded-[9px] border border-ok bg-ok-bg px-3 py-[11px] text-body">
          <p className="m-0 font-medium">
            {result.status === "pending" ? "Request sent" : "Booked"} — {result.serviceName}
            {result.resourceName ? ` with ${result.resourceName}` : ""}, {result.when}.
          </p>
          <p className="m-0 mt-1 text-meta text-muted">
            {/* Named, because "check your email" is useless if it went
                somewhere they aren't looking. */}
            The confirmation is on its way to {result.email}. It has the appointment attached, so it drops
            straight into a calendar. Your copy of it is in the dashboard once you go live.
          </p>
        </div>
      ) : (
        <fetcher.Form method="post">
          <input type="hidden" name="_intent" value="test_booking" />
          <input type="hidden" name="cid" value={cid} />
          <button type="submit" className="btn-sec" disabled={sending || !cid}>
            {sending ? "Booking…" : `Send yourself a test ${vocab.bookingOne.toLowerCase()}`}
          </button>
        </fetcher.Form>
      )}
    </div>
  );
}
