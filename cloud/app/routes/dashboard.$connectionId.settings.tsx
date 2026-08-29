import { useState } from "react";
import { Form, redirect, useSearchParams } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.settings";
import { Settings, PaymentManager, FeatureFlags, listUserConnections, disconnectConnection } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { PageHeader, Field, Input, Toggle, Badge, TimezoneSelect } from "~/components/ui";
import { IntegrationRow } from "~/components/onboarding";
import { TemplateConfig, overviewCards, type OverviewCardKey } from "~/components/account";
import { INTEGRATIONS, type PresetId } from "~/lib/presets";
import { PHONE_PATTERN } from "~/lib/validation";

export const meta: Route.MetaFunction = () => [{ title: "Settings · GetBooqin" }];

export async function loader({ request, params }: Route.LoaderArgs) {
  const { userId, connection, shop, platform } = await requireTenant(request, params.connectionId);
  const settings = await Settings.getSettings(shop, platform);
  const connections = await listUserConnections(userId);
  const isManual = platform === "manual";

  const gatewayFields = Object.entries(PaymentManager.gateways()).map(([id, g]) => ({
    id,
    label: g.label({ shop, settings, appProxyBase: "", manageUrl: () => "" }),
    fields: g.settingsFields(),
  }));

  return {
    settings,
    gatewayFields,
    paymentsEnabled: FeatureFlags.PAYMENTS_ENABLED,
    connections,
    currentConnectionId: connection.id,
    isManual,
    shop,
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
      currency: String(form.get("currency") ?? "USD"),
      currency_symbol: String(form.get("currency_symbol") ?? "$"),
      timezone: String(form.get("timezone") ?? "UTC"),
      slot_interval: Number(form.get("slot_interval") ?? 30),
      min_notice_hours: Number(form.get("min_notice_hours") ?? 2),
      max_advance_days: Number(form.get("max_advance_days") ?? 60),
      auto_confirm: form.get("auto_confirm") === "on",
      allow_cancel: form.get("allow_cancel") === "on",
      cancel_cutoff_hours: Number(form.get("cancel_cutoff_hours") ?? 24),
    });
  } else if (section === "template") {
    const preset = String(form.get("preset") ?? "");
    const current = await Settings.getSettings(shop, platform);
    if (preset && preset !== current.preset) {
      await Settings.applyPreset(shop, platform, preset);
    }
    // Checked "cards" are the visible ones; anything in the full card list
    // that didn't come through in this submit was switched off.
    const visible = new Set(form.getAll("cards").map(String));
    const hidden = overviewCards(preset || current.preset)
      .map((c) => c.key)
      .filter((key) => !visible.has(key));
    await Settings.setSettings(shop, platform, { hidden_overview_cards: hidden });
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
  const { settings, gatewayFields, paymentsEnabled, connections, currentConnectionId, isManual, shop } = loaderData;
  // defaultSettings() seeds business_name to the connection's own opaque
  // shop id, so a manual connection that never completed onboarding step 1
  // shows that raw manual-<uuid> string as its "business name" instead of
  // an empty field prompting the owner to set a real one (UX audit's D2
  // finding, same root cause as the sidebar label fix in
  // dashboard.$connectionId.tsx).
  const businessNameValue = isManual && settings.business_name === shop ? "" : settings.business_name;
  const [searchParams] = useSearchParams();
  const tab = searchParams.get("tab") || "general";

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader title="Settings" />

      <div className="card">
        {/* "Integrations" ran 16px past a 389px viewport with nowhere to
            scroll to reach it — the one tab a merchant needs to connect
            Shopify or Stripe (UX audit's M6 finding). overflow-x-auto plus
            shrink-0 on each tab lets it scroll into view instead of
            clipping or wrapping. */}
        <div className="flex overflow-x-auto border-b border-line px-[6px]">
          <a href="?tab=general" className={`tab shrink-0 ${tab === "general" ? "tab-active" : ""}`}>
            General
          </a>
          <a href="?tab=template" className={`tab shrink-0 ${tab === "template" ? "tab-active" : ""}`}>
            Template
          </a>
          <a href="?tab=notifications" className={`tab shrink-0 ${tab === "notifications" ? "tab-active" : ""}`}>
            Notifications
          </a>
          {paymentsEnabled && (
            <a href="?tab=payments" className={`tab shrink-0 ${tab === "payments" ? "tab-active" : ""}`}>
              Payments
            </a>
          )}
          <a href="?tab=integrations" className={`tab shrink-0 ${tab === "integrations" ? "tab-active" : ""}`}>
            Integrations
          </a>
        </div>

        {tab === "general" && (
          <Form method="post">
            <input type="hidden" name="_section" value="general" />
            {/* [&_.field-label]:min-h-[38px] reserves two lines' worth of
                label height on every field here — "Minimum notice (hours)"
                wraps while "Slot interval (minutes)" doesn't, which put the
                two inputs 19px out of vertical alignment in the same row
                (UX audit's M7 finding). Scoped to this grid rather than
                Field globally, since most of the app's fields are single-
                column and don't need the extra reserved space. */}
            <div className="card-body grid grid-cols-2 gap-x-4 gap-y-[14px] [&_.field-label]:min-h-[38px]">
              <div className="col-span-2">
                <Field label="Business name">
                  <Input name="business_name" defaultValue={businessNameValue} placeholder={isManual ? "e.g. Kapsalon Vondel" : undefined} />
                </Field>
              </div>
              <Field label="Business email">
                <Input name="business_email" type="email" defaultValue={settings.business_email} />
              </Field>
              <Field label="Business phone">
                <Input type="tel" name="business_phone" defaultValue={settings.business_phone} pattern={PHONE_PATTERN} />
              </Field>
              <Field label="Currency code">
                <Input name="currency" defaultValue={settings.currency} />
              </Field>
              <Field label="Currency symbol">
                <Input name="currency_symbol" defaultValue={settings.currency_symbol} />
              </Field>
              <div className="col-span-2">
                <Field label="Timezone">
                  <TimezoneSelect defaultValue={settings.timezone} />
                </Field>
              </div>
              <Field label="Slot interval (minutes)" hint="The spacing between bookable start times.">
                <Input type="number" name="slot_interval" min={5} defaultValue={settings.slot_interval} />
              </Field>
              <Field label="Minimum notice (hours)" hint="How soon before a slot someone can still book it.">
                <Input type="number" name="min_notice_hours" min={0} defaultValue={settings.min_notice_hours} />
              </Field>
              <Field label="Max advance booking (days)" hint="How far ahead your calendar opens up.">
                <Input type="number" name="max_advance_days" min={1} defaultValue={settings.max_advance_days} />
              </Field>
              <Field label="Cancellation cutoff (hours before start)" hint="How late a customer can still cancel.">
                <Input type="number" name="cancel_cutoff_hours" min={0} defaultValue={settings.cancel_cutoff_hours} />
              </Field>
              <div className="col-span-2 flex flex-col gap-3">
                <Toggle name="auto_confirm" defaultChecked={settings.auto_confirm} label="Auto-confirm new bookings" />
                <Toggle name="allow_cancel" defaultChecked={settings.allow_cancel} label="Allow customers to cancel" />
              </div>
            </div>
            <div className="card-footer">
              {actionData?.saved && <span className="alert-success">Saved.</span>}
              <button type="submit" className="btn-pri ml-auto">
                Save general settings
              </button>
            </div>
          </Form>
        )}

        {tab === "notifications" && (
          <Form method="post">
            <input type="hidden" name="_section" value="notifications" />
            <div className="card-body flex flex-col gap-[14px]">
              <Toggle name="notify_customer" defaultChecked={settings.notify_customer} label="Email the customer on booking events" />
              <Toggle name="notify_admin" defaultChecked={settings.notify_admin} label="Email the business on booking events" />
              <div className="max-w-[360px]">
                <Field label="Admin notification email">
                  <Input name="admin_email" type="email" defaultValue={settings.admin_email} />
                </Field>
              </div>
              <Toggle name="reminder_enabled" defaultChecked={settings.reminder_enabled} label="Send reminder emails" />
              <div className="max-w-[220px]">
                <Field label="Reminder lead time (hours)">
                  <Input type="number" name="reminder_hours" min={1} defaultValue={settings.reminder_hours} />
                </Field>
              </div>
            </div>
            <div className="card-footer">
              {actionData?.saved && <span className="alert-success">Saved.</span>}
              <button type="submit" className="btn-pri ml-auto">
                Save notification settings
              </button>
            </div>
          </Form>
        )}

        {tab === "payments" && paymentsEnabled && (
          <Form method="post">
            <input type="hidden" name="_section" value="payments" />
            <div className="card-body flex flex-col gap-3">
              {gatewayFields.map((g) => (
                <div key={g.id} className="rounded-[9px] border border-line p-3">
                  <div className="mb-2">
                    <Toggle
                      name="enabled_gateways"
                      value={g.id}
                      defaultChecked={settings.enabled_gateways.includes(g.id)}
                      label={g.label}
                    />
                  </div>
                  {g.fields.map((field) =>
                    field.type === "checkbox" ? (
                      <div key={field.key} className="mb-2">
                        <Toggle
                          name={`gateway_${g.id}_${field.key}`}
                          defaultChecked={Boolean(settings.gateways[g.id]?.[field.key])}
                          label={field.label}
                        />
                      </div>
                    ) : (
                      <div key={field.key} className="mb-2">
                        <Field label={field.label}>
                          <Input
                            type={field.type === "password" ? "password" : "text"}
                            name={`gateway_${g.id}_${field.key}`}
                            defaultValue={settings.gateways[g.id]?.[field.key] as string | undefined}
                          />
                        </Field>
                      </div>
                    )
                  )}
                </div>
              ))}
            </div>
            <div className="card-footer">
              {actionData?.saved && <span className="alert-success">Saved.</span>}
              <button type="submit" className="btn-pri ml-auto">
                Save payment settings
              </button>
            </div>
          </Form>
        )}

        {tab === "integrations" && (
          <div className="flex flex-col">
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
                    tag={integ.tag}
                    blurb={integ.blurb}
                    connected={connected}
                    variant="settings"
                    disabled={!paymentsEnabled}
                    action={
                      paymentsEnabled ? (
                        <a href="?tab=payments" className="btn-sec no-underline hover:no-underline">
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
        )}
      </div>

      {tab === "template" && (
        <Form id="template-form" method="post" className="flex flex-col gap-[14px]">
          <input type="hidden" name="_section" value="template" />
          <TemplateTab presetId={settings.preset} initialHidden={settings.hidden_overview_cards} saved={!!actionData?.saved} />
        </Form>
      )}

      {tab === "integrations" && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Connected stores</h2>
          </div>
          {connections.map((c) => (
            <div key={c.id} className="trow" style={{ gridTemplateColumns: "32px 1fr auto auto" }}>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[11px] font-semibold text-brand-600">
                {c.platform === "manual" ? "M" : c.shop.slice(0, 1).toUpperCase()}
              </span>
              {c.id === currentConnectionId || c.status !== "active" ? (
                <span className="min-w-0 truncate font-medium">
                  {c.platform === "manual" ? "Manual setup (no store connected)" : c.shop}
                </span>
              ) : (
                // The only way to reach a second store used to be pasting its
                // URL — this list showed every connection but none of them,
                // besides the current one, were actually clickable (UX
                // audit's D1 finding: a store created here became invisible
                // and unreachable from the UI the moment a newer one existed).
                <a href={`/dashboard/${c.id}`} className="min-w-0 truncate font-medium text-ink hover:underline">
                  {c.platform === "manual" ? "Manual setup (no store connected)" : c.shop}
                </a>
              )}
              <span className="flex items-center gap-2">
                {c.id === currentConnectionId && <Badge status="confirmed" label="Current" />}
                {c.status !== "active" && <Badge status="cancelled" label={c.status} />}
              </span>
              {c.status === "active" ? (
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
      )}
    </div>
  );
}

// Local controlled state drives TemplateConfig's live renames/cards preview
// on pick/toggle; its inputs are still real named radios/checkboxes so the
// #template-form submit above works whether or not this state ever changes.
function TemplateTab({
  presetId, initialHidden, saved,
}: { presetId: string; initialHidden: string[]; saved: boolean }) {
  const [preset, setPreset] = useState<PresetId>(presetId as PresetId);
  const [hidden, setHidden] = useState<Record<string, boolean>>(
    () => Object.fromEntries(initialHidden.map((key) => [key, true]))
  );

  return (
    <TemplateConfig
      presetId={preset}
      hidden={hidden}
      saved={saved}
      onPick={setPreset}
      onToggle={(key: OverviewCardKey) => setHidden((prev) => ({ ...prev, [key]: !prev[key] }))}
    />
  );
}
