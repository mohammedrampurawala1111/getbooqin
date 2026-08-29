import { useState } from "react";
import { Form, redirect, useSearchParams } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.settings";
import { Settings, PaymentManager, FeatureFlags, listUserConnections, disconnectConnection } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { getClerkClient } from "~/session.server";
import { Badge, TimezoneSelect, Toggle } from "~/components/ui";
import { IntegrationRow } from "~/components/onboarding";
import { TemplateConfig, overviewCards, type OverviewCardKey } from "~/components/account";
import { SettingsShell, Row, RowInput, ToggleRow, SettingsCard, type SettingsKey } from "~/components/settings";
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

  return {
    settings,
    gatewayFields,
    paymentsEnabled: FeatureFlags.PAYMENTS_ENABLED,
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
  const { settings, gatewayFields, paymentsEnabled, connections, currentConnectionId, isManual, shop, accountEmail } = loaderData;
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
  const page = (searchParams.get("page") || "general") as SettingsKey;
  const savedAt = actionData?.saved ? "just now" : undefined;
  const base = `/dashboard/${currentConnectionId}`;

  return (
    <SettingsShell active={page} base={base} hide={paymentsEnabled ? [] : ["payments"]}>
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
          <TemplateTab presetId={settings.preset} initialHidden={settings.hidden_overview_cards} saved={!!actionData?.saved} />
        </Form>
      )}

      {page === "rules" && (
        <SettingsCard saveLabel="Save booking rules" savedAt={savedAt}>
          <input type="hidden" name="_section" value="rules" />
          <Row label="Slot interval (minutes)" hint="The spacing between bookable start times.">
            <RowInput type="number" name="slot_interval" min={5} defaultValue={settings.slot_interval} cap={140} />
          </Row>
          <Row label="Minimum notice (hours)" hint="How soon before a slot someone can still book it.">
            <RowInput type="number" name="min_notice_hours" min={0} defaultValue={settings.min_notice_hours} cap={140} />
          </Row>
          <Row label="Max advance booking (days)" hint="How far ahead your calendar opens up.">
            <RowInput type="number" name="max_advance_days" min={1} defaultValue={settings.max_advance_days} cap={140} />
          </Row>
          <Row label="Cancellation cutoff (hours before start)" hint="How late a customer can still cancel.">
            <RowInput type="number" name="cancel_cutoff_hours" min={0} defaultValue={settings.cancel_cutoff_hours} cap={140} />
          </Row>
          <ToggleRow name="auto_confirm" label="Auto-confirm new bookings" hint="Skip manual approval for new bookings" defaultChecked={settings.auto_confirm} />
          <ToggleRow name="allow_cancel" label="Allow customers to cancel" hint="Let customers cancel their own bookings" defaultChecked={settings.allow_cancel} />
        </SettingsCard>
      )}

      {page === "notifications" && (
        <SettingsCard saveLabel="Save notification settings" savedAt={savedAt}>
          <input type="hidden" name="_section" value="notifications" />
          <ToggleRow name="notify_customer" label="Email the customer" hint="Sent on booking events" defaultChecked={settings.notify_customer} />
          <ToggleRow name="notify_admin" label="Email the business" hint="Sent on booking events" defaultChecked={settings.notify_admin} />
          <Row label="Admin notification email">
            <RowInput name="admin_email" type="email" defaultValue={adminEmailValue} />
          </Row>
          <ToggleRow name="reminder_enabled" label="Send reminder emails" hint="Cuts no-shows by around a third" defaultChecked={settings.reminder_enabled} />
          <Row label="Reminder lead time (hours)">
            <RowInput type="number" name="reminder_hours" min={1} defaultValue={settings.reminder_hours} cap={140} />
          </Row>
        </SettingsCard>
      )}

      {page === "payments" && paymentsEnabled && (
        <SettingsCard saveLabel="Save payment settings" savedAt={savedAt}>
          <input type="hidden" name="_section" value="payments" />
          {gatewayFields.map((g) => (
            <div key={g.id}>
              <Row label={g.label} hint="Accept payments through this gateway">
                <Toggle name="enabled_gateways" value={g.id} defaultChecked={settings.enabled_gateways.includes(g.id)} label="Enabled" />
              </Row>
              {g.fields.map((field) => (
                <Row key={field.key} label={field.label}>
                  {field.type === "checkbox" ? (
                    <Toggle name={`gateway_${g.id}_${field.key}`} defaultChecked={Boolean(settings.gateways[g.id]?.[field.key])} />
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
                    tag={integ.tag}
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
        </>
      )}

      {page === "team" && (
        <div className="card">
          <div className="flex flex-col items-center gap-2 px-[18px] py-14 text-center">
            <span className="text-[13px] font-medium text-ink-2">Team accounts are coming soon</span>
            <p className="m-0 max-w-[360px] text-meta text-subtle">
              For now, whoever connects a store manages it as the owner. We'll let you invite staff with their own sign-in and permissions here.
            </p>
          </div>
        </div>
      )}
    </SettingsShell>
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
