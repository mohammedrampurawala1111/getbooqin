import { randomUUID } from "node:crypto";
import { useEffect, useRef, useState } from "react";
import { Form, redirect, useFetcher, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.settings";
import { Settings, Data, Mailer, PaymentManager, FeatureFlags, listUserConnections, disconnectConnection } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { getClerkClient } from "~/session.server";
import { Badge, TimezoneSelect, Toggle, useToast } from "~/components/ui";
import { IntegrationRow } from "~/components/onboarding";
import { TemplateConfig, overviewCards, type OverviewCardKey } from "~/components/account";
import { SettingsShell, Row, RowInput, RowTextarea, ToggleRow, Segmented, ValueRow, SettingsCard, isSettingsPage, PresetFieldBadge, hiddenSettingsNavKeys } from "~/components/settings";
import { INTEGRATIONS, getPreset, useVocabulary, SERVICE_SWATCHES, type PresetId, type PresetRules } from "~/lib/presets";
import { PHONE_PATTERN } from "~/lib/validation";

export const meta: Route.MetaFunction = () => [{ title: "Settings · GetBooqin" }];

export async function loader({ request, params }: Route.LoaderArgs) {
  const url = new URL(request.url);
  // Settings moved off tab-nav onto the ?page= rail; a bookmarked or
  // linked ?tab=... URL from before that migration used to silently land
  // on General instead of the section it named (UX audit's #7 finding,
  // second half — the dashboard._index.tsx empty-state hrefs already
  // worked around this same gap by never emitting a ?tab= link in the
  // first place, but an old external link still can). Only rewrites when
  // ?page= isn't already present, so a modern link that happens to also
  // carry a stray ?tab= isn't clobbered.
  if (url.searchParams.has("tab") && !url.searchParams.has("page")) {
    url.searchParams.set("page", url.searchParams.get("tab")!);
    url.searchParams.delete("tab");
    throw redirect(url.pathname + url.search);
  }

  const { userId, connection, shop, platform } = await requireTenant(request, params.connectionId);
  const settings = await Settings.getSettings(shop, platform);
  const connections = await listUserConnections(userId);
  const isManual = platform === "manual";

  const gatewayFields = Object.entries(PaymentManager.gateways()).map(([id, g]) => ({
    id,
    label: g.label({ shop, settings, appProxyBase: "", manageUrl: () => "" }),
    fields: g.settingsFields(),
  }));

  // getSettings() always seeds business_email/admin_email blank (core's
  // defaultSettings() has no way to know the account's real address at
  // read time) even though the account holding this connection already
  // has one — a fresh account showed two empty email fields it had no
  // reason to (UX audit's D3 finding). Presentation-layer prefill only,
  // same as businessNameValue below — doesn't touch stored settings, so a
  // merchant who deliberately wants a different notification address
  // still just types over it and saves.
  const clerkUser = await getClerkClient().users.getUser(userId);
  const accountEmail =
    clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId)?.emailAddress ??
    clerkUser.emailAddresses[0]?.emailAddress ??
    "";

  // Every notification the system actually sends, with a per-message on/off
  // switch and editable subject/body — the page previously exposed four
  // blanket switches and nothing about what was actually going out (Defect
  // Dossier's BQ-34 finding). Resolved and preview-rendered here, server-
  // side, rather than shipping the raw TEMPLATE_DEFS registry + a token
  // renderer to the client — there are only ~16 of these, cheap to
  // precompute all at once.
  const previewTokens = Mailer.previewTokens(settings);
  const visitSummariesVisibleForMessages = FeatureFlags.VISIT_SUMMARIES_ENABLED && settings.preset === "clinic";
  // A "Payment received" message enabled on a product that can't yet take
  // payment advertised a capability the business doesn't have (Defect
  // Dossier's R2-09 finding) — same gate as the Payment column/Deposit
  // field elsewhere (BQ-30).
  const paymentsAvailableForMessages = FeatureFlags.PAYMENTS_ENABLED && settings.enabled_gateways.length > 0;
  // settings.chat_enabled defaults to true for every shop (ported from
  // shopify-openslot, which had a real chat widget) and there is no
  // dashboard control that ever turns it off — the standalone product has
  // no chat widget at all, so a filter keyed on it was never actually
  // gating anything (Defect Dossier's R3-02 finding). FeatureFlags.CHAT_ENABLED
  // is the real switch: off unless ENABLE_CHAT is explicitly set, same
  // convention as every other unbuilt-capability flag.
  const notificationMessages = Mailer.visibleTemplateDefs({
    chat: FeatureFlags.CHAT_ENABLED,
    payments: paymentsAvailableForMessages,
    visitSummary: visitSummariesVisibleForMessages,
  }).map((def) => {
    const subject = Settings.template(settings, `${def.key}_subject`, def.subject);
    const body = Settings.template(settings, `${def.key}_body`, def.body);
    return {
      key: def.key,
      group: def.group,
      label: def.label,
      description: def.description,
      enabled: settings.template_enabled?.[def.key] !== false,
      subject,
      body,
      isCustomized: !!settings.templates?.[`${def.key}_subject`] || !!settings.templates?.[`${def.key}_body`],
      previewSubject: Mailer.renderTemplate(subject, previewTokens),
      previewBody: Mailer.renderTemplate(body, previewTokens),
    };
  });

  return {
    settings,
    gatewayFields,
    paymentsEnabled: FeatureFlags.PAYMENTS_ENABLED,
    // Two-layer gate (docs/patient-summary-cloud-integration-plan.md Part 3
    // §6 / Part 5): this env flag plus the shop's own preset decide whether
    // the "Visit summaries" nav entry and page even render below — the
    // per-clinic visit_summaries_enabled toggle inside that page is the
    // second layer, and stays off (opt-in) regardless of this flag.
    visitSummariesEnabled: FeatureFlags.VISIT_SUMMARIES_ENABLED,
    notificationMessages,
    connections,
    currentConnectionId: connection.id,
    isManual,
    shop,
    accountEmail,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { userId, shop, platform } = await requireTenant(request, params.connectionId);
  const form = await request.formData();
  const section = String(form.get("_section") ?? "");

  if (section === "general") {
    await Settings.setSettings(shop, platform, {
      business_name: String(form.get("business_name") ?? ""),
      business_email: String(form.get("business_email") ?? ""),
      business_phone: String(form.get("business_phone") ?? ""),
      business_description: String(form.get("business_description") ?? ""),
      business_address: String(form.get("business_address") ?? ""),
      currency: String(form.get("currency") ?? "USD"),
      currency_symbol: String(form.get("currency_symbol") ?? "$"),
      timezone: String(form.get("timezone") ?? "UTC"),
    });
  } else if (section === "rules") {
    await Settings.setSettings(shop, platform, {
      slot_interval: Number(form.get("slot_interval") ?? 30),
      min_notice_hours: Number(form.get("min_notice_hours") ?? 2),
      max_advance_days: Number(form.get("max_advance_days") ?? 60),
      auto_confirm: form.get("auto_confirm") === "on",
      allow_cancel: form.get("allow_cancel") === "on",
      cancel_cutoff_hours: Number(form.get("cancel_cutoff_hours") ?? 24),
      require_phone: form.get("require_phone") === "on",
      waitlist_enabled: form.get("waitlist_enabled") === "on",
      waitlist_offer_window_hours: Number(form.get("waitlist_offer_window_hours") ?? 4),
    });
  } else if (section === "template") {
    const preset = String(form.get("preset") ?? "");
    const current = await Settings.getSettings(shop, platform);
    let seededCount = 0;
    if (preset && preset !== current.preset) {
      await Settings.applyPreset(shop, platform, preset);
      // The "Default {services}" panel promises "Added if missing", but
      // applyPreset() only ever wrote vocabulary/rule settings — switching
      // Legal -> Clinic kept only the four legal services, none of
      // Clinic's own (Defect Dossier's BQ-20 finding). Seeded inactive so
      // nothing appears on the public page unreviewed; name-matched so
      // switching back and forth doesn't accumulate duplicates.
      const existingServices = await Data.catalogServices(shop, platform, false);
      const existingNames = new Set(existingServices.map((s) => s.name.toLowerCase()));
      const toSeed = getPreset(preset).services.filter((s) => !existingNames.has(s.name.toLowerCase()));
      // Assigned to every currently-active resource up front, same as
      // onboarding's own resource-creation step already does — otherwise a
      // template-switch-seeded service sits unconfigured (not "assigned to
      // nobody", just never decided) until someone visits its own page,
      // which is exactly the ambiguous state two otherwise-identical
      // services could silently differ on (Defect Dossier's R2-04 finding).
      const activeResourceIds = (await Data.resources(shop, platform, true)).map((r) => r.id);
      for (let i = 0; i < toSeed.length; i++) {
        const svc = toSeed[i];
        const productId = randomUUID();
        const productHandle = `${svc.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "service"}-${productId.slice(0, 8)}`;
        await Data.upsertProductCache(shop, platform, { productId, productHandle, title: svc.name, price: svc.price });
        await Data.saveServiceConfig(shop, platform, {
          product_id: productId,
          product_handle: productHandle,
          duration_min: svc.minutes,
          location_type: svc.location ?? "onsite",
          color: SERVICE_SWATCHES[i % SERVICE_SWATCHES.length],
          status: false,
          // Only when there's someone to assign — passing an empty array
          // here would mark the service as *explicitly* assigned to
          // nobody, which is a different (and wrong) claim from "no
          // resources exist yet to assign."
          ...(activeResourceIds.length > 0 ? { resource_ids: activeResourceIds } : {}),
        });
      }
      seededCount = toSeed.length;
    }
    // Checked "cards" are the visible ones; anything in the full card list
    // that didn't come through in this submit was switched off.
    const visible = new Set(form.getAll("cards").map(String));
    const hidden = overviewCards(preset || current.preset)
      .map((c) => c.key)
      .filter((key) => !visible.has(key));
    await Settings.setSettings(shop, platform, { hidden_overview_cards: hidden });
    return { saved: true, seededCount };
  } else if (section === "disconnect_store") {
    const targetId = String(form.get("connection_id") ?? "");
    await disconnectConnection(userId, targetId);
    // Disconnecting the store currently being viewed leaves this dashboard
    // unreachable (tenant.server.ts's requireTenant 404s non-active
    // connections) — bounce through /dashboard, which redirects to whatever
    // active store is left, or onboarding if none is.
    if (targetId === params.connectionId) {
      throw redirect("/dashboard");
    }
    return { saved: true };
  } else if (section === "notifications") {
    await Settings.setSettings(shop, platform, {
      notify_customer: form.get("notify_customer") === "on",
      notify_admin: form.get("notify_admin") === "on",
      admin_email: String(form.get("admin_email") ?? ""),
      reminder_enabled: form.get("reminder_enabled") === "on",
      reminder_hours: Number(form.get("reminder_hours") ?? 24),
    });
  } else if (section === "notification_template") {
    // Each message row is its own tiny form (on/off toggle, or the
    // subject/body editor), independent of the blanket switches above —
    // the "reuse that mechanism" piece of BQ-34: TEMPLATE_DEFS/
    // Settings.template() already carry a per-key override and an
    // industry-appropriate default (via applyPreset() writing a preset's
    // own text into settings.templates), this just adds the save path
    // that was missing.
    const key = String(form.get("key") ?? "");
    const intent = String(form.get("_action") ?? "");
    const current = await Settings.getSettings(shop, platform);
    if (intent === "toggle") {
      await Settings.setSettings(shop, platform, {
        template_enabled: { ...current.template_enabled, [key]: form.get("enabled") === "on" },
      });
    } else if (intent === "reset") {
      const templates = { ...current.templates };
      delete templates[`${key}_subject`];
      delete templates[`${key}_body`];
      await Settings.setSettings(shop, platform, { templates });
    } else {
      await Settings.setSettings(shop, platform, {
        templates: {
          ...current.templates,
          [`${key}_subject`]: String(form.get("subject") ?? ""),
          [`${key}_body`]: String(form.get("body") ?? ""),
        },
      });
    }
    return { saved: true, savedKey: key };
  } else if (section === "visit_summaries" && FeatureFlags.VISIT_SUMMARIES_ENABLED) {
    // Preset re-checked server-side (not just trusted from the hidden nav) —
    // same defense-in-depth as the client-side gate below; a non-clinic shop
    // posting this section directly shouldn't be able to persist these keys.
    const current = await Settings.getSettings(shop, platform);
    if (current.preset === "clinic") {
      const rawLanguage = String(form.get("visit_summary_default_language") ?? "auto");
      await Settings.setSettings(shop, platform, {
        visit_summaries_enabled: form.get("visit_summaries_enabled") === "on",
        visit_summary_default_language: rawLanguage === "nl" || rawLanguage === "en" ? rawLanguage : "auto",
        visit_summary_consent_line: String(form.get("visit_summary_consent_line") ?? ""),
      });
    }
  } else if (section === "payments" && FeatureFlags.PAYMENTS_ENABLED) {
    const enabled = form.getAll("enabled_gateways").map(String);
    await Settings.setSettings(shop, platform, { enabled_gateways: enabled });
    for (const [id, gateway] of Object.entries(PaymentManager.gateways())) {
      const values: Record<string, string | boolean> = {};
      for (const field of gateway.settingsFields()) {
        const raw = form.get(`gateway_${id}_${field.key}`);
        values[field.key] = field.type === "checkbox" ? raw === "on" : String(raw ?? "");
      }
      if (Object.keys(values).length) await PaymentManager.saveGatewaySettings(shop, platform, id, values);
    }
  }

  return { saved: true };
}

export default function SettingsPage({ loaderData, actionData }: Route.ComponentProps) {
  const { settings, gatewayFields, paymentsEnabled, visitSummariesEnabled, notificationMessages, connections, currentConnectionId, isManual, shop, accountEmail } = loaderData;
  const v = useVocabulary();
  // defaultSettings() seeds business_name to the connection's own opaque
  // shop id, so a manual connection that never completed onboarding step 1
  // shows that raw manual-<uuid> string as its "business name" instead of
  // an empty field prompting the owner to set a real one (UX audit's D2
  // finding, same root cause as the sidebar label fix in
  // dashboard.$connectionId.tsx).
  const businessNameValue = isManual && settings.business_name === shop ? "" : settings.business_name;
  const businessEmailValue = settings.business_email || accountEmail;
  const adminEmailValue = settings.admin_email || accountEmail;
  const [searchParams] = useSearchParams();
  const rawPage = searchParams.get("page");
  // An unknown ?page= value already fell back to General correctly — but
  // "payments" is a *known* slug that renders a heading and nav highlight
  // with zero form fields whenever the feature flag is off, since nothing
  // upstream of this line knew to reject it (UX audit's C4 finding). Same
  // fallback, just extended to a slug that's real but not buildable yet.
  // Same fallback shape as the payments carve-out above, extended for the
  // second gated page: "visit_summaries" is a real slug but only buildable
  // when both the global rollout flag and this shop's preset allow it
  // (docs/patient-summary-cloud-integration-plan.md Part 3 §6).
  const visitSummariesVisible = visitSummariesEnabled && settings.preset === "clinic";
  const page = isSettingsPage(rawPage)
    && (rawPage !== "payments" || paymentsEnabled)
    && (rawPage !== "visit_summaries" || visitSummariesVisible)
    ? rawPage : "general";
  const savedAt = actionData?.saved ? "just now" : undefined;
  const base = `/dashboard/${currentConnectionId}`;
  const hiddenNavKeys = hiddenSettingsNavKeys({ paymentsEnabled, visitSummariesEnabled, preset: settings.preset });

  return (
    <SettingsShell active={page} base={base} hide={hiddenNavKeys}>
      {page === "general" && (
        <SettingsCard saveLabel="Save changes" savedAt={savedAt}>
          <input type="hidden" name="_section" value="general" />
          <Row label="Business name">
            <RowInput name="business_name" defaultValue={businessNameValue} placeholder={isManual ? "e.g. Kapsalon Vondel" : undefined} cap={9999} />
          </Row>
          <Row label="Business email">
            <RowInput name="business_email" type="email" defaultValue={businessEmailValue} />
          </Row>
          <Row label="Business phone">
            <RowInput type="tel" name="business_phone" defaultValue={settings.business_phone} pattern={PHONE_PATTERN} />
          </Row>
          {/* Shown on the public booking page's business header — it used
              to give a prospective client only a name and a bare list of
              service durations, with none of this already-collected
              context reaching the page (Defect Dossier's BQ-33 finding). */}
          <Row label="Description" hint="One line, shown on your booking page">
            <RowInput name="business_description" defaultValue={settings.business_description} cap={160} />
          </Row>
          <Row label="Address" hint="Shown on your booking page">
            <RowInput name="business_address" defaultValue={settings.business_address} cap={9999} />
          </Row>
          <Row label="Currency code">
            <RowInput name="currency" defaultValue={settings.currency} cap={120} />
          </Row>
          <Row label="Currency symbol">
            <RowInput name="currency_symbol" defaultValue={settings.currency_symbol} cap={120} />
          </Row>
          <Row label="Timezone" hint="All times shown in this zone">
            <TimezoneSelect defaultValue={settings.timezone} />
          </Row>
        </SettingsCard>
      )}

      {page === "template" && (
        <Form id="template-form" method="post" className="flex flex-col gap-[14px]">
          <input type="hidden" name="_section" value="template" />
          <TemplateTab
            presetId={settings.preset}
            initialHidden={settings.hidden_overview_cards}
            saved={!!actionData?.saved}
            currentRules={{
              slot_interval: settings.slot_interval,
              min_notice_hours: settings.min_notice_hours,
              max_advance_days: settings.max_advance_days,
              cancel_cutoff_hours: settings.cancel_cutoff_hours,
              auto_confirm: settings.auto_confirm,
              require_phone: settings.require_phone,
              waitlist_enabled: settings.waitlist_enabled,
              waitlist_offer_window_hours: settings.waitlist_offer_window_hours,
            }}
            customizedFields={settings.customized_fields}
            seededCount={actionData && "seededCount" in actionData ? actionData.seededCount ?? 0 : 0}
            paymentsAvailable={paymentsEnabled && settings.enabled_gateways.length > 0}
          />
        </Form>
      )}

      {page === "rules" && (
        <SettingsCard saveLabel="Save booking rules" savedAt={savedAt}>
          <input type="hidden" name="_section" value="rules" />
          <Row label="Slot interval (minutes)" hint="The spacing between bookable start times."
            badge={<PresetFieldBadge customized={settings.customized_fields.includes("slot_interval")} />}>
            <RowInput type="number" name="slot_interval" min={5} defaultValue={settings.slot_interval} cap={140} />
          </Row>
          <Row label="Minimum notice (hours)" hint="How soon before a slot someone can still book it."
            badge={<PresetFieldBadge customized={settings.customized_fields.includes("min_notice_hours")} />}>
            <RowInput type="number" name="min_notice_hours" min={0} defaultValue={settings.min_notice_hours} cap={140} />
          </Row>
          <Row label="Max advance booking (days)" hint="How far ahead your calendar opens up."
            badge={<PresetFieldBadge customized={settings.customized_fields.includes("max_advance_days")} />}>
            <RowInput type="number" name="max_advance_days" min={1} defaultValue={settings.max_advance_days} cap={140} />
          </Row>
          <Row label="Cancellation cutoff (hours before start)" hint="How late a customer can still cancel."
            badge={<PresetFieldBadge customized={settings.customized_fields.includes("cancel_cutoff_hours")} />}>
            <RowInput type="number" name="cancel_cutoff_hours" min={0} defaultValue={settings.cancel_cutoff_hours} cap={140} />
          </Row>
          <ToggleRow name="auto_confirm" label="Auto-confirm new bookings" hint="Skip manual approval for new bookings" defaultChecked={settings.auto_confirm}
            badge={<PresetFieldBadge customized={settings.customized_fields.includes("auto_confirm")} />} />
          <ToggleRow name="require_phone" label="Require a phone number" hint="Ask for a phone number when booking" defaultChecked={settings.require_phone}
            badge={<PresetFieldBadge customized={settings.customized_fields.includes("require_phone")} />} />
          <ToggleRow name="waitlist_enabled" label="Offer freed slots to the waitlist" hint="Cancelled, declined or no-show bookings get offered to the next matching waitlist entry" defaultChecked={settings.waitlist_enabled}
            badge={<PresetFieldBadge customized={settings.customized_fields.includes("waitlist_enabled")} />} />
          <Row label="Waitlist offer window (hours)" hint="How long someone has to claim an offered slot before it moves to the next person."
            badge={<PresetFieldBadge customized={settings.customized_fields.includes("waitlist_offer_window_hours")} />}>
            <RowInput type="number" name="waitlist_offer_window_hours" min={0.25} step={0.25} defaultValue={settings.waitlist_offer_window_hours} cap={140} />
          </Row>
          <ToggleRow name="allow_cancel" label="Allow customers to cancel" hint="Let customers cancel their own bookings" defaultChecked={settings.allow_cancel} />
        </SettingsCard>
      )}

      {page === "notifications" && (
        <div className="flex flex-col gap-[14px]">
          <SettingsCard saveLabel="Save notification settings" savedAt={savedAt}>
            <input type="hidden" name="_section" value="notifications" />
            <ToggleRow
              name="notify_customer"
              label={`Email the ${v.customerOne}`}
              hint={`Sent on ${v.bookingOne} events`}
              defaultChecked={settings.notify_customer}
            />
            <ToggleRow name="notify_admin" label="Email the business" hint={`Sent on ${v.bookingOne} events`} defaultChecked={settings.notify_admin} />
            <Row label="Admin notification email">
              <RowInput name="admin_email" type="email" defaultValue={adminEmailValue} />
            </Row>
            {/* "Cuts no-shows by around a third" was an unsourced claim with
                nothing behind it (Defect Dossier's BQ-34 finding, item 5) —
                the hint now just says what the setting does. New copy
                added alongside that fix bypassed the vocabulary helper
                entirely (Defect Dossier's R2-05 finding). */}
            <ToggleRow
              name="reminder_enabled"
              label="Send reminder emails"
              hint={`Sent automatically before the ${v.bookingOne}`}
              defaultChecked={settings.reminder_enabled}
            />
            <Row label="Reminder lead time (hours)">
              <RowInput type="number" name="reminder_hours" min={1} defaultValue={settings.reminder_hours} cap={140} />
            </Row>
            {/* A reminder can only be "ahead of" a booking that itself had
                to be made with at least this much notice — set the lead
                time at or past the minimum notice and every booking made at
                the earliest permitted moment has its reminder due on
                arrival (Defect Dossier's BQ-34 finding, item 4; the sweep
                below now sends it right away rather than dropping it, but
                the setting combination itself is still worth a merchant's
                attention). */}
            {settings.reminder_enabled && settings.reminder_hours >= settings.min_notice_hours && (
              <p className="m-0 rounded-[8px] bg-warn-bg px-3 py-2 text-[12.5px] text-warn">
                Reminder lead time ({settings.reminder_hours}h) is at or past your minimum {v.bookingOne} notice (
                {settings.min_notice_hours}h) — the earliest allowed {v.bookingOne} will have its reminder sent
                right away instead of ahead of time.
              </p>
            )}
          </SettingsCard>

          <NotificationMessagesCard messages={notificationMessages} vocab={v} />
        </div>
      )}

      {page === "payments" && paymentsEnabled && (
        <SettingsCard saveLabel="Save payment settings" savedAt={savedAt}>
          <input type="hidden" name="_section" value="payments" />
          {gatewayFields.map((g) => (
            <div key={g.id}>
              {/* as="div": Toggle already renders its own <label> around its
                  checkbox + "Enabled" text — Row wrapping that in a second
                  <label> would nest labels, which is invalid HTML and
                  breaks the association for both. */}
              <Row as="div" label={g.label} hint="Accept payments through this gateway">
                <Toggle name="enabled_gateways" value={g.id} defaultChecked={settings.enabled_gateways.includes(g.id)} label="Enabled" />
              </Row>
              {g.fields.map((field) => (
                <Row key={field.key} as={field.type === "checkbox" ? "div" : "label"} label={field.label}>
                  {field.type === "checkbox" ? (
                    // No wrapping label here (see as="div" above), so this
                    // Toggle needs its own label text to have any
                    // accessible name at all.
                    <Toggle name={`gateway_${g.id}_${field.key}`} defaultChecked={Boolean(settings.gateways[g.id]?.[field.key])} label={field.label} />
                  ) : (
                    <RowInput
                      type={field.type === "password" ? "password" : "text"}
                      name={`gateway_${g.id}_${field.key}`}
                      defaultValue={settings.gateways[g.id]?.[field.key] as string | undefined}
                    />
                  )}
                </Row>
              ))}
            </div>
          ))}
        </SettingsCard>
      )}

      {page === "visit_summaries" && visitSummariesVisible && (
        <SettingsCard saveLabel="Save visit summary settings" savedAt={savedAt}>
          <input type="hidden" name="_section" value="visit_summaries" />
          <ToggleRow
            name="visit_summaries_enabled"
            label="Enable visit summaries"
            hint="Let staff turn consultation transcripts into patient-friendly summaries for review and approval."
            defaultChecked={settings.visit_summaries_enabled}
          />
          {/* There's no plan, allowance or billing anywhere in the product
              to back a "Clinic plan... monthly allowance" claim — replaced
              with what's actually true today rather than an unenforceable
              commercial term (Defect Dossier's BQ-38 finding). Add a real
              usage counter here once an allowance actually exists. */}
          <ValueRow label="Pricing" value="Included while this feature is in preview." />
          <Row label="Default summary language" hint="Pre-fills the language selector when staff start a new visit summary. Still changeable per summary.">
            <Segmented
              name="visit_summary_default_language"
              value={settings.visit_summary_default_language}
              options={["auto", "nl", "en"]}
              labels={{ auto: "Detect automatically", nl: "Nederlands", en: "English" }}
            />
          </Row>
          <Row label="Consultation consent notice" align="start">
            <div className="flex flex-col gap-[6px]">
              <RowTextarea
                name="visit_summary_consent_line"
                defaultValue={settings.visit_summary_consent_line}
                placeholder="Ahead of your visit: your doctor may use an AI-assisted tool to help prepare a plain-language written summary of today's consultation for you to keep. A clinician always reviews and approves the summary before it is sent — the AI never sends anything to you directly, and nothing is shared outside our practice. If you have questions, or would prefer we don't prepare a summary this way, please tell our front desk before your appointment."
              />
              <p className="m-0 text-meta text-subtle">
                Shown to patients ahead of a visit that may be summarized with AI assistance. This is not
                legal advice — have your legal/compliance advisor review this wording, especially around
                GDPR and medical-record consent, before enabling this for real patients.
              </p>
            </div>
          </Row>
        </SettingsCard>
      )}

      {page === "integrations" && (
        <>
          <div className="card">
            {INTEGRATIONS.map((integ) => {
              if (integ.id === "shopify") {
                return (
                  <IntegrationRow
                    key={integ.id}
                    id={integ.id}
                    name={integ.name}
                    initial={integ.initial}
                    tint={integ.tint}
                    tag={integ.tag}
                    blurb={integ.blurb}
                    detail={isManual ? undefined : settings.business_name || undefined}
                    connected={!isManual}
                    variant="settings"
                    action={
                      isManual ? (
                        <a href="/connect/shopify" className="btn-sec no-underline hover:no-underline">Connect</a>
                      ) : (
                        <span className="btn-sec pointer-events-none opacity-60">Connected</span>
                      )
                    }
                  />
                );
              }
              if (integ.id === "stripe") {
                const connected = paymentsEnabled && settings.enabled_gateways.includes("stripe");
                return (
                  <IntegrationRow
                    key={integ.id}
                    id={integ.id}
                    name={integ.name}
                    initial={integ.initial}
                    tint={integ.tint}
                    // Disabled kept rendering a live-looking "Payments" tag
                    // with no explanation — the same "Coming soon" the
                    // other not-yet-buildable integrations already carry
                    // (Defect Dossier's BQ-30 finding).
                    tag={paymentsEnabled ? integ.tag : "Coming soon"}
                    blurb={integ.blurb}
                    connected={connected}
                    variant="settings"
                    disabled={!paymentsEnabled}
                    action={
                      paymentsEnabled ? (
                        <a href="?page=payments" className="btn-sec no-underline hover:no-underline">
                          {connected ? "Manage" : "Configure"}
                        </a>
                      ) : undefined
                    }
                  />
                );
              }
              return (
                <IntegrationRow
                  key={integ.id}
                  id={integ.id}
                  name={integ.name}
                  initial={integ.initial}
                  tint={integ.tint}
                  tag="Coming soon"
                  blurb={integ.blurb}
                  connected={false}
                  variant="settings"
                  disabled
                />
              );
            })}
          </div>

          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Sales channels</h2>
            </div>
            {connections.map((c) => (
              <div key={c.id} className="trow" style={{ gridTemplateColumns: "32px 1fr auto auto" }}>
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[11px] font-semibold text-brand-600">
                  {c.platform === "manual" ? "M" : c.shop.slice(0, 1).toUpperCase()}
                </span>
                {c.id === currentConnectionId || c.status !== "active" ? (
                  <span className="min-w-0 truncate font-medium">
                    {/* Manual mode is the *absence* of a store, not a store
                        — "no store connected" instead of a label implying
                        there's a connection here to manage (Defect Dossier's
                        BQ-12 finding). */}
                    {c.platform === "manual" ? "No store connected — bookings run through your GetBooqin booking link" : c.shop}
                  </span>
                ) : (
                  // The only way to reach a second store used to be pasting its
                  // URL — this list showed every connection but none of them,
                  // besides the current one, were actually clickable (UX
                  // audit's D1 finding: a store created here became invisible
                  // and unreachable from the UI the moment a newer one existed).
                  <a href={`/dashboard/${c.id}`} className="min-w-0 truncate font-medium text-ink hover:underline">
                    {c.shop}
                  </a>
                )}
                <span className="flex items-center gap-2">
                  {c.id === currentConnectionId && <Badge status="confirmed" label="Current" />}
                  {c.status !== "active" && <Badge status="cancelled" label={c.status} />}
                </span>
                {/* Disconnecting nothing isn't a coherent action — a manual
                    connection never gets the destructive button at all, not
                    just a disabled one (same finding). */}
                {c.status === "active" && c.platform !== "manual" ? (
                  <Form method="post">
                    <input type="hidden" name="_section" value="disconnect_store" />
                    <input type="hidden" name="connection_id" value={c.id} />
                    <button type="submit" className="btn-del">Disconnect</button>
                  </Form>
                ) : (
                  <span />
                )}
              </div>
            ))}
            <div className="card-footer">
              <a href="/connect/shopify" className="btn-sec no-underline hover:no-underline">
                + Connect a Shopify store
              </a>
            </div>
          </div>
        </>
      )}

      {page === "team" && (
        <div className="card">
          <div className="flex flex-col items-center gap-2 px-[18px] py-14 text-center">
            <span className="text-[13px] font-medium text-ink-2">Team accounts are coming soon</span>
            {/* Shopify is an optional integration, not how ownership is
                established — this used to say "whoever connects a store",
                which reads as "you don't own this account" to a business
                that will never connect one (Defect Dossier's BQ-11
                finding). */}
            <p className="m-0 max-w-[360px] text-meta text-subtle">
              For now, the person who created this business is the owner. Soon you'll be able to invite staff here, each with their own sign-in and permissions.
            </p>
          </div>
        </div>
      )}
    </SettingsShell>
  );
}

type NotificationMessage = {
  key: string;
  group: string;
  label: string;
  description: string;
  enabled: boolean;
  subject: string;
  body: string;
  isCustomized: boolean;
  previewSubject: string;
  previewBody: string;
};

// Every notification the app actually sends, listed with a per-message
// on/off switch, an editable subject/body, and a live preview rendered
// against sample data — Settings > Notifications used to be four blanket
// switches with no visibility into what was actually going out (Defect
// Dossier's BQ-34 finding). Grouped by TEMPLATE_DEFS' own `group` field
// (Booking received, Confirmed, Cancelled, Reminder, Waitlist, ...).
function NotificationMessagesCard({ messages, vocab }: { messages: NotificationMessage[]; vocab: ReturnType<typeof useVocabulary> }) {
  const groups: { group: string; messages: NotificationMessage[] }[] = [];
  for (const m of messages) {
    const last = groups[groups.length - 1];
    if (last && last.group === m.group) last.messages.push(m);
    else groups.push({ group: m.group, messages: [m] });
  }

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">Email templates</h2>
      </div>
      <div className="card-body flex flex-col gap-[18px]">
        {groups.map((g) => (
          <div key={g.group} className="flex flex-col gap-[8px]">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-subtle">{vocabizeLabel(g.group, vocab)}</span>
            <div className="flex flex-col gap-[8px]">
              {g.messages.map((m) => (
                <MessageRow key={m.key} message={m} vocab={vocab} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// TEMPLATE_DEFS' labels ("Booking confirmed", "Upcoming booking reminder",
// "Notify the customer") are plain, preset-agnostic English written in
// core, which has no concept of a shop's vocabulary — bypassing the
// vocabulary helper the same way the rest of the new copy in this pass did
// (Defect Dossier's R2-05 finding). Word-boundary substitution here instead
// of hand-maintaining a per-message-key override list, so any future
// TEMPLATE_DEFS entry that reuses one of these words is covered for free.
function vocabizeLabel(text: string, vocab: ReturnType<typeof useVocabulary>): string {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return text
    .replace(/\bBookings\b/g, cap(vocab.bookingMany))
    .replace(/\bbookings\b/g, vocab.bookingMany)
    .replace(/\bBooking\b/g, cap(vocab.bookingOne))
    .replace(/\bbooking\b/g, vocab.bookingOne)
    .replace(/\bCustomers\b/g, cap(vocab.customers))
    .replace(/\bcustomers\b/g, vocab.customers.toLowerCase())
    .replace(/\bCustomer\b/g, cap(vocab.customerOne))
    .replace(/\bcustomer\b/g, vocab.customerOne);
}

// "Sent to {the customer|the business}" derived from the key's own prefix
// rather than baking it into every one of TEMPLATE_DEFS' description
// strings by hand — the recipient-facing word still comes from the shop's
// real vocabulary either way (Defect Dossier's BQ-34 finding, item 1).
function recipientLabel(key: string, vocab: ReturnType<typeof useVocabulary>): string {
  if (key.startsWith("customer_") || key.startsWith("waitlist_")) return `Sent to the ${vocab.customerOne}`;
  if (key.startsWith("admin_")) return "Sent to your team";
  return "";
}

function MessageRow({ message, vocab }: { message: NotificationMessage; vocab: ReturnType<typeof useVocabulary> }) {
  const [expanded, setExpanded] = useState<"none" | "preview" | "edit">("none");
  const toggleFetcher = useFetcher();
  const editFetcher = useFetcher();
  const resetFetcher = useFetcher();

  // toggleFetcher.formData reflects the in-flight submission optimistically
  // — a merchant flipping the switch sees it move immediately rather than
  // waiting on the round trip.
  const enabled =
    toggleFetcher.formData ? toggleFetcher.formData.get("enabled") === "on" : message.enabled;
  const label = vocabizeLabel(message.label, vocab);

  return (
    <div className="rounded-[9px] border border-line">
      <div className="flex items-center gap-3 px-3 py-[10px]">
        <toggleFetcher.Form method="post" onChange={(e) => toggleFetcher.submit(e.currentTarget)}>
          <input type="hidden" name="_section" value="notification_template" />
          <input type="hidden" name="_action" value="toggle" />
          <input type="hidden" name="key" value={message.key} />
          <Toggle name="enabled" defaultChecked={message.enabled} ariaLabel={`Send "${label}"`} />
        </toggleFetcher.Form>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-[2px]">
            <span className="text-body font-medium">{label}</span>
            {message.isCustomized && <span className="badge-neutral">Customized</span>}
          </div>
          <span className="text-[12px] text-muted">
            {recipientLabel(message.key, vocab) || message.description}
          </span>
        </div>
        <button type="button" className="btn-link shrink-0" onClick={() => setExpanded(expanded === "preview" ? "none" : "preview")}>
          {expanded === "preview" ? "Hide preview" : "Preview"}
        </button>
        <button type="button" className="btn-link shrink-0" onClick={() => setExpanded(expanded === "edit" ? "none" : "edit")}>
          {expanded === "edit" ? "Cancel" : "Edit"}
        </button>
      </div>

      {!enabled && (
        <p className="m-0 border-t border-line bg-canvas px-3 py-2 text-[12px] text-subtle">
          Turned off — this message won't be sent.
        </p>
      )}

      {expanded === "preview" && (
        <div className="flex flex-col gap-[6px] border-t border-line bg-canvas px-3 py-3">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-subtle">Preview with sample data</span>
          <span className="text-body font-medium">{message.previewSubject}</span>
          <p className="m-0 whitespace-pre-wrap text-[13px] text-muted">{message.previewBody}</p>
        </div>
      )}

      {expanded === "edit" && (
        // Two sibling forms, not one nested inside the other — nesting
        // <form> is invalid HTML, and the browser silently mis-parses it on
        // hydration (the outer form closes early at the inner form's start
        // tag), which is what made "Reset to default" post correctly but
        // never actually take effect.
        <div className="flex flex-col gap-[10px] border-t border-line px-3 py-3">
          <editFetcher.Form method="post" className="flex flex-col gap-[10px]" onSubmit={() => setExpanded("none")}>
            <input type="hidden" name="_section" value="notification_template" />
            <input type="hidden" name="key" value={message.key} />
            <Row label="Subject">
              <RowInput name="subject" defaultValue={message.subject} cap={9999} />
            </Row>
            <Row label="Body">
              <RowTextarea name="body" defaultValue={message.body} rows={7} cap={9999} />
            </Row>
            <p className="m-0 text-[12px] text-subtle">
              Tokens like {"{{customer_name}}"}, {"{{date}}"}, {"{{time}}"} and {"{{manage_url}}"} are filled in when it's sent.
            </p>
            <div className="flex justify-end">
              <button type="submit" className="btn-pri" disabled={editFetcher.state !== "idle"}>
                {editFetcher.state !== "idle" ? "Saving…" : "Save message"}
              </button>
            </div>
          </editFetcher.Form>
          {message.isCustomized && (
            <resetFetcher.Form method="post" className="flex justify-end">
              <input type="hidden" name="_section" value="notification_template" />
              <input type="hidden" name="_action" value="reset" />
              <input type="hidden" name="key" value={message.key} />
              <button type="submit" className="btn-sec" disabled={resetFetcher.state !== "idle"}>
                Reset to default
              </button>
            </resetFetcher.Form>
          )}
        </div>
      )}
    </div>
  );
}

// Local controlled state drives TemplateConfig's live renames/cards preview
// on pick/toggle; its inputs are still real named radios/checkboxes so the
// #template-form submit above works whether or not this state ever changes.
function TemplateTab({
  presetId, initialHidden, saved, currentRules, customizedFields, seededCount, paymentsAvailable,
}: { presetId: string; initialHidden: string[]; saved: boolean; currentRules: PresetRules; customizedFields: string[]; seededCount: number; paymentsAvailable: boolean }) {
  const [preset, setPreset] = useState<PresetId>(presetId as PresetId);
  const [hidden, setHidden] = useState<Record<string, boolean>>(
    () => Object.fromEntries(initialHidden.map((key) => [key, true]))
  );
  const toast = useToast();
  const v = useVocabulary();
  const navigation = useNavigation();

  // The confirm dialog's own button submits the real #template-form
  // navigation (not a fetcher), so nothing ever told it the save had
  // finished — it saved correctly and sat open over its own "Saved."
  // message regardless (Defect Dossier's R3-01 finding, the same shape as
  // BQ-02 but on a real Form instead of a fetcher). Close it and report
  // success as a toast once the submitting -> idle round trip completes.
  const wasSubmitting = useRef(false);
  const presetBeforeSubmit = useRef(presetId);
  useEffect(() => {
    if (navigation.state === "submitting") {
      wasSubmitting.current = true;
      return;
    }
    if (navigation.state !== "idle" || !wasSubmitting.current) return;
    wasSubmitting.current = false;
    if (saved) {
      (document.getElementById("template") as HTMLDialogElement | null)?.close();
      const switched = presetBeforeSubmit.current !== presetId;
      toast(
        switched
          ? `Business template switched to ${getPreset(presetId).label}${seededCount > 0 ? ` — ${seededCount} ${v.services.toLowerCase()} added as inactive` : ""}`
          : "Dashboard layout saved."
      );
    }
    presetBeforeSubmit.current = presetId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation.state]);

  return (
    <TemplateConfig
      presetId={preset}
      currentPresetId={presetId}
      hidden={hidden}
      saved={saved}
      currentRules={currentRules}
      customizedFields={customizedFields}
      onPick={setPreset}
      onToggle={(key: OverviewCardKey) => setHidden((prev) => ({ ...prev, [key]: !prev[key] }))}
      pending={navigation.state !== "idle"}
      paymentsAvailable={paymentsAvailable}
    />
  );
}
