import { Form, redirect, useSearchParams } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.settings";
import { Settings, PaymentManager, FeatureFlags, Presets, listUserConnections, disconnectConnection } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { PageHeader, Field, Input, Toggle, Badge } from "~/components/ui";
import { IntegrationRow } from "~/components/onboarding";
import { INTEGRATIONS } from "~/lib/presets";

export async function loader({ request, params }: Route.LoaderArgs) {
  const { userId, connection, shop, platform } = await requireTenant(request, params.connectionId);
  const settings = await Settings.getSettings(shop, platform);
  const connections = await listUserConnections(userId);

  const gatewayFields = Object.entries(PaymentManager.gateways()).map(([id, g]) => ({
    id,
    label: g.label({ shop, settings, appProxyBase: "", manageUrl: () => "" }),
    fields: g.settingsFields(),
  }));

  return {
    settings,
    gatewayFields,
    paymentsEnabled: FeatureFlags.PAYMENTS_ENABLED,
    presetChoices: Presets.presetChoices(),
    connections,
    currentConnectionId: connection.id,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { userId, shop, platform } = await requireTenant(request, params.connectionId);
  const form = await request.formData();
  const section = String(form.get("_section") ?? "");

  if (section === "general") {
    const preset = String(form.get("preset") ?? "");
    const current = await Settings.getSettings(shop, platform);
    if (preset && preset !== current.preset) {
      await Settings.applyPreset(shop, platform, preset);
    }
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
  const { settings, gatewayFields, paymentsEnabled, presetChoices, connections, currentConnectionId } = loaderData;
  const [searchParams] = useSearchParams();
  const tab = searchParams.get("tab") || "general";

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader title="Settings" />

      <div className="card">
        <div className="flex border-b border-line px-[6px]">
          <a href="?tab=general" className={`tab ${tab === "general" ? "tab-active" : ""}`}>
            General
          </a>
          <a href="?tab=notifications" className={`tab ${tab === "notifications" ? "tab-active" : ""}`}>
            Notifications
          </a>
          {paymentsEnabled && (
            <a href="?tab=payments" className={`tab ${tab === "payments" ? "tab-active" : ""}`}>
              Payments
            </a>
          )}
          <a href="?tab=integrations" className={`tab ${tab === "integrations" ? "tab-active" : ""}`}>
            Integrations
          </a>
        </div>

        {tab === "general" && (
          <Form method="post">
            <input type="hidden" name="_section" value="general" />
            <div className="card-body grid grid-cols-2 gap-x-4 gap-y-[14px]">
              <div className="col-span-2">
                <Field label="Business name">
                  <Input name="business_name" defaultValue={settings.business_name} />
                </Field>
              </div>
              <div className="col-span-2">
                <Field label="Industry preset" hint="Changing this resets your terminology and scheduling defaults to that industry's.">
                  <select name="preset" defaultValue={settings.preset} className="input cursor-pointer">
                    {presetChoices.map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="Business email">
                <Input name="business_email" type="email" defaultValue={settings.business_email} />
              </Field>
              <Field label="Business phone">
                <Input name="business_phone" defaultValue={settings.business_phone} />
              </Field>
              <Field label="Currency code">
                <Input name="currency" defaultValue={settings.currency} />
              </Field>
              <Field label="Currency symbol">
                <Input name="currency_symbol" defaultValue={settings.currency_symbol} />
              </Field>
              <div className="col-span-2">
                <Field label="Timezone">
                  <Input name="timezone" defaultValue={settings.timezone} />
                </Field>
              </div>
              <Field label="Slot interval (minutes)">
                <Input type="number" name="slot_interval" min={5} defaultValue={settings.slot_interval} />
              </Field>
              <Field label="Minimum notice (hours)">
                <Input type="number" name="min_notice_hours" min={0} defaultValue={settings.min_notice_hours} />
              </Field>
              <Field label="Max advance booking (days)">
                <Input type="number" name="max_advance_days" min={1} defaultValue={settings.max_advance_days} />
              </Field>
              <Field label="Cancellation cutoff (hours before start)">
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
                    detail={settings.business_name || undefined}
                    connected
                    variant="settings"
                    action={<span className="btn-sec pointer-events-none opacity-60">Connected</span>}
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

      {tab === "integrations" && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Connected Shopify stores</h2>
          </div>
          {connections.map((c) => (
            <div key={c.id} className="trow" style={{ gridTemplateColumns: "32px 1fr auto auto" }}>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[11px] font-semibold text-brand-600">
                {c.shop.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 truncate font-medium">{c.shop}</span>
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
              + Connect another store
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
