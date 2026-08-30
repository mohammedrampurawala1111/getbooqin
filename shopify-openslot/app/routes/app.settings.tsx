import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useSubmit, useNavigation } from "react-router";
import {
  Page,
  Card,
  BlockStack,
  FormLayout,
  TextField,
  Checkbox,
  Select,
  Button,
  Tabs,
  InlineStack,
  Text,
  Banner,
  Toast,
  Badge,
} from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import { Settings as Backend, Presets, FeatureFlags } from "getbooqin-core";
import { PaymentManager, MeetingManager, Mailer } from "getbooqin-core";

function slugify(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "field";
}

/* "Preset default" vs "Customized" next to a rule field's label — tells a
   merchant which fields switching "Industry preset" will (and won't)
   touch: applyPreset() (core's settings.ts) skips any key listed in
   settings.customized_fields, so a hand-edit here survives picking a
   different preset later. Mirrors cloud/app/components/settings.tsx's
   PresetFieldBadge. */
function PresetFieldLabel({ text, customized }: { text: string; customized: boolean }) {
  return (
    <InlineStack gap="150" blockAlign="center">
      <span>{text}</span>
      <Badge tone={customized ? "info" : undefined}>{customized ? "Customized" : "Preset default"}</Badge>
    </InlineStack>
  );
}

const INTAKE_FIELD_TYPES = ["text", "phone", "email", "textarea"] as const;

/**
 * Every overridable string in the storefront widget's `t` object
 * (extensions/getbooqin-widgets/assets/booking.js). Defaults here must match
 * the ones there — this is the admin-side editor, not the source of truth;
 * an empty override falls back to booking.js's own default.
 */
const WIDGET_TEXT_DEFS: { key: string; group: string; label: string; default: string }[] = [
  { key: "bookNow", group: "Buttons", label: "Book now button", default: "Book now" },
  { key: "back", group: "Buttons", label: "Go back button", default: "Back" },
  { key: "continueLabel", group: "Buttons", label: "Continue button", default: "Continue" },
  { key: "confirm", group: "Buttons", label: "Confirm booking button", default: "Confirm booking" },
  { key: "send", group: "Buttons", label: "Send button", default: "Send" },

  { key: "chooseService", group: "Steps & headings", label: "Choose a service heading", default: "Choose a service" },
  { key: "chooseStaff", group: "Steps & headings", label: "Choose team member heading", default: "Choose who you would like to see" },
  { key: "anyAvailable", group: "Steps & headings", label: "\"Anyone available\" option", default: "Anyone available" },
  { key: "chooseAddons", group: "Steps & headings", label: "Choose add-ons heading", default: "Anything else you would like to add?" },
  { key: "chooseDate", group: "Steps & headings", label: "Choose date heading", default: "Pick a date" },
  { key: "selectTimeSlot", group: "Steps & headings", label: "Choose time slot heading", default: "Select preferred time slot" },
  { key: "selectTimeHint", group: "Steps & headings", label: "Message when no time slot is selected", default: "Please select a time slot" },
  { key: "pickDatePrompt", group: "Steps & headings", label: "Prompt before a date is picked", default: "Select a date to see available times." },
  { key: "timezoneLabel", group: "Steps & headings", label: "Timezone label", default: "Timezone" },
  { key: "serviceLabel", group: "Steps & headings", label: "Service row label", default: "Service" },
  { key: "teamMemberLabel", group: "Steps & headings", label: "Team member row label", default: "Team Member" },

  { key: "yourDetails", group: "Contact form", label: "Contact details heading", default: "Your details" },
  { key: "firstName", group: "Contact form", label: "First name field", default: "First name" },
  { key: "lastName", group: "Contact form", label: "Last name field", default: "Last name" },
  { key: "email", group: "Contact form", label: "Email field", default: "Email address" },
  { key: "phone", group: "Contact form", label: "Phone field", default: "Phone number" },
  { key: "notes", group: "Contact form", label: "Notes field", default: "Anything we should know?" },

  { key: "booked", group: "Confirmation & manage", label: "Booked heading", default: "You are booked!" },
  { key: "bookedIntro", group: "Confirmation & manage", label: "Booked message", default: "We have emailed you the details." },
  { key: "cancelBooking", group: "Confirmation & manage", label: "Cancel booking button", default: "Cancel this booking" },
  { key: "cancelConfirm", group: "Confirmation & manage", label: "Cancel confirmation prompt", default: "Are you sure you want to cancel?" },
  { key: "cancelled", group: "Confirmation & manage", label: "Cancelled message", default: "This booking has been cancelled." },
  { key: "rescheduleBooking", group: "Confirmation & manage", label: "Reschedule button", default: "Reschedule" },
  { key: "rescheduled", group: "Confirmation & manage", label: "Rescheduled message", default: "Your booking has been moved." },
  { key: "pickNewDate", group: "Confirmation & manage", label: "Pick a new date heading", default: "Pick a new date" },

  { key: "loading", group: "Messages", label: "Loading message", default: "Loading…" },
  { key: "noSlots", group: "Messages", label: "No times available message", default: "No times available on this day." },
  { key: "required", group: "Messages", label: "Missing required fields message", default: "Please fill in the required fields." },
  { key: "genericError", group: "Messages", label: "Generic error message", default: "Something went wrong. Please try again." },
  { key: "close", group: "Messages", label: "Close button", default: "Close" },

  { key: "videoNote", group: "Video calls", label: "Video call note", default: "This is a video call. Your join link is in your confirmation email." },
  { key: "joinCall", group: "Video calls", label: "Join call button", default: "Join the video call" },

  { key: "payNow", group: "Payments", label: "Pay now button", default: "Pay now" },
  { key: "choosePayment", group: "Payments", label: "Choose payment heading", default: "How would you like to pay?" },
  { key: "amountDue", group: "Payments", label: "Amount due label", default: "Amount due" },
  { key: "payLater", group: "Payments", label: "\"Pay later\" option", default: "I will pay later" },
  { key: "paymentDone", group: "Payments", label: "Payment received message", default: "Payment received. Thank you!" },
  { key: "redirecting", group: "Payments", label: "Redirecting message", default: "Taking you to the payment page…" },
];

function parseIntakeFields(raw: FormDataEntryValue | null) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((f) => f && typeof f.label === "string" && f.label.trim())
      .map((f) => ({
        key: String(f.key || slugify(f.label)),
        label: String(f.label),
        type: INTAKE_FIELD_TYPES.includes(f.type) ? f.type : "text",
        required: f.required === true,
      }));
  } catch {
    return [];
  }
}

// Real, wired rule fields (see core/src/booking/presets.ts's
// PRESET_CONTROLLED_KEYS) each preset sets, merged over the account-wide
// baseline so "Industry preset" can preview what applying it would actually
// change before a merchant clicks Apply. Computed server-side (this route
// module's top-level imports are shared with its client bundle, and
// core's `Presets`/`Settings` modules pull in Prisma — unlike cloud's
// getbooqin-core/booking/presets subpath import, that's not safe to
// reference from code the component itself executes).
type PresetRulePreview = Pick<
  Backend.Settings,
  "min_notice_hours" | "max_advance_days" | "cancel_cutoff_hours" | "auto_confirm" | "require_phone"
>;

function presetRulePreviews(shop: string): Record<string, PresetRulePreview> {
  const fallback = Backend.defaultSettings(shop, "");
  return Object.fromEntries(
    Object.entries(Presets.PRESETS).map(([id, preset]) => [
      id,
      { ...fallback, ...(preset.defaults as Partial<PresetRulePreview>) },
    ])
  );
}

/* Plain-language summary of a PresetRulePreview, for "Industry preset"'s
   before-you-apply preview. Mirrors cloud/app/lib/presets.ts's ruleChips(). */
function ruleChips(rules: PresetRulePreview): string[] {
  return [
    rules.auto_confirm ? "Confirms bookings automatically" : "New bookings need approval first",
    `At least ${rules.min_notice_hours}h notice required to book`,
    `Customers can cancel up to ${rules.cancel_cutoff_hours}h before`,
    rules.require_phone ? "Phone number required at booking" : "Phone number optional",
  ];
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const settings = await Backend.getSettings(session.shop, "shopify");
  return {
    settings,
    presetRules: presetRulePreviews(session.shop),
    gatewayFields: Object.entries(PaymentManager.gateways()).map(([id, g]) => ({
      id,
      label: g.label({ shop: session.shop, settings, appProxyBase: "", manageUrl: () => "" }),
      fields: g.settingsFields(),
    })),
    videoFields: Object.entries(MeetingManager.providers()).map(([id, p]) => ({
      id,
      label: p.label(),
      fields: p.settingsFields(),
    })),
    presets: Presets.presetChoices(),
    templateDefs: Mailer.TEMPLATE_DEFS,
    paymentsEnabled: FeatureFlags.PAYMENTS_ENABLED,
    chatEnabled: FeatureFlags.CHAT_ENABLED,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const section = String(form.get("_section"));

  if (section === "preset") {
    await Backend.applyPreset(shop, "shopify", String(form.get("preset")));
    return { ok: true };
  }

  if (section === "general") {
    await Backend.setSettings(shop, "shopify", {
      business_name: String(form.get("business_name") || ""),
      business_email: String(form.get("business_email") || ""),
      business_phone: String(form.get("business_phone") || ""),
      currency: String(form.get("currency") || "USD"),
      currency_symbol: String(form.get("currency_symbol") || "$"),
      timezone: String(form.get("timezone") || "UTC"),
      booking_page_url: String(form.get("booking_page_url") || ""),
      slot_interval: Number(form.get("slot_interval") || 30),
      min_notice_hours: Number(form.get("min_notice_hours") || 2),
      max_advance_days: Number(form.get("max_advance_days") || 60),
      auto_confirm: form.get("auto_confirm") === "true",
      allow_cancel: form.get("allow_cancel") === "true",
      cancel_cutoff_hours: Number(form.get("cancel_cutoff_hours") || 24),
      require_phone: form.get("require_phone") === "true",
      consent_text: String(form.get("consent_text") || ""),
      intake_fields: parseIntakeFields(form.get("intake_fields")),
    });
    return { ok: true };
  }

  if (section === "notifications") {
    await Backend.setSettings(shop, "shopify", {
      notify_customer: form.get("notify_customer") === "true",
      notify_admin: form.get("notify_admin") === "true",
      admin_email: String(form.get("admin_email") || ""),
      reminder_enabled: form.get("reminder_enabled") === "true",
      reminder_hours: Number(form.get("reminder_hours") || 24),
    });
    return { ok: true };
  }

  if (section === "templates") {
    const templates: Record<string, string> = {};
    const templateEnabled: Record<string, boolean> = {};
    for (const def of Mailer.TEMPLATE_DEFS) {
      const subject = form.get(`tpl_${def.key}_subject`);
      const body = form.get(`tpl_${def.key}_body`);
      if (subject != null) templates[`${def.key}_subject`] = String(subject);
      if (body != null) templates[`${def.key}_body`] = String(body);
      templateEnabled[def.key] = form.get(`tpl_${def.key}_enabled`) === "true";
    }
    await Backend.setSettings(shop, "shopify", { templates, template_enabled: templateEnabled });
    return { ok: true };
  }

  if (section === "widget") {
    const widgetText: Record<string, string> = {};
    for (const def of WIDGET_TEXT_DEFS) {
      const value = form.get(`wt_${def.key}`);
      if (value != null) widgetText[def.key] = String(value);
    }
    await Backend.setSettings(shop, "shopify", { widget_text: widgetText });
    return { ok: true };
  }

  if (section === "chat") {
    if (!FeatureFlags.CHAT_ENABLED) return { ok: false };
    await Backend.setSettings(shop, "shopify", {
      chat_enabled: form.get("chat_enabled") === "true",
      chat_position: (form.get("chat_position") === "left" ? "left" : "right") as "left" | "right",
      chat_color: String(form.get("chat_color") || "#2563eb"),
      chat_title: String(form.get("chat_title") || ""),
      chat_subtitle: String(form.get("chat_subtitle") || ""),
      chat_greeting: String(form.get("chat_greeting") || ""),
      chat_show_faq: form.get("chat_show_faq") === "true",
      chat_show_booking: form.get("chat_show_booking") === "true",
      chat_show_message: form.get("chat_show_message") === "true",
      chat_offline_note: String(form.get("chat_offline_note") || ""),
      chat_launcher_text: String(form.get("chat_launcher_text") || ""),
    });
    return { ok: true };
  }

  if (section === "payments") {
    if (!FeatureFlags.PAYMENTS_ENABLED) return { ok: false };
    const enabled = form.getAll("enabled_gateways").map(String);
    await Backend.setSettings(shop, "shopify", { enabled_gateways: enabled });

    for (const [id, g] of Object.entries(PaymentManager.gateways())) {
      const values: Record<string, string | boolean> = {};
      for (const field of g.settingsFields()) {
        const key = `gw_${id}_${field.key}`;
        values[field.key] = field.type === "checkbox" ? form.get(key) === "true" : String(form.get(key) || "");
      }
      if (Object.keys(values).length) await PaymentManager.saveGatewaySettings(shop, "shopify", id, values);
    }
    return { ok: true };
  }

  if (section === "video") {
    const settings = await Backend.getSettings(shop, "shopify");
    const video = { ...settings.video };
    for (const [id, p] of Object.entries(MeetingManager.providers())) {
      const values: Record<string, string> = {};
      for (const field of p.settingsFields()) {
        values[field.key] = String(form.get(`video_${id}_${field.key}`) || "");
      }
      video[id] = { ...video[id], ...values };
    }
    await Backend.setSettings(shop, "shopify", { video_provider: String(form.get("video_provider") || "jitsi"), video, video_join_window: Number(form.get("video_join_window") || 15) });
    return { ok: true };
  }

  return { ok: false };
}

export default function Settings() {
  const {
    settings,
    presetRules,
    gatewayFields,
    videoFields,
    presets,
    templateDefs,
    paymentsEnabled: paymentsFeatureEnabled,
    chatEnabled: chatFeatureEnabled,
  } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const actionData = useActionData<typeof action>();
  const saving = navigation.state === "submitting";
  const [tab, setTab] = useState(0);
  const [showSavedToast, setShowSavedToast] = useState(false);

  useEffect(() => {
    if (actionData?.ok) setShowSavedToast(true);
  }, [actionData]);

  const [preset, setPreset] = useState(settings.preset);
  const [businessName, setBusinessName] = useState(settings.business_name);
  const [businessEmail, setBusinessEmail] = useState(settings.business_email);
  const [businessPhone, setBusinessPhone] = useState(settings.business_phone);
  const [currency, setCurrency] = useState(settings.currency);
  const [currencySymbol, setCurrencySymbol] = useState(settings.currency_symbol);
  const [timezone, setTimezone] = useState(settings.timezone);
  const [bookingPageUrl, setBookingPageUrl] = useState(settings.booking_page_url);
  const [slotInterval, setSlotInterval] = useState(String(settings.slot_interval));
  const [minNotice, setMinNotice] = useState(String(settings.min_notice_hours));
  const [maxAdvance, setMaxAdvance] = useState(String(settings.max_advance_days));
  const [autoConfirm, setAutoConfirm] = useState(settings.auto_confirm);
  const [allowCancel, setAllowCancel] = useState(settings.allow_cancel);
  const [cancelCutoff, setCancelCutoff] = useState(String(settings.cancel_cutoff_hours));
  const [requirePhone, setRequirePhone] = useState(settings.require_phone);
  const [consentText, setConsentText] = useState(settings.consent_text);
  const [intakeFields, setIntakeFields] = useState(settings.intake_fields);

  const [notifyCustomer, setNotifyCustomer] = useState(settings.notify_customer);
  const [notifyAdmin, setNotifyAdmin] = useState(settings.notify_admin);
  const [adminEmail, setAdminEmail] = useState(settings.admin_email);
  const [reminderEnabled, setReminderEnabled] = useState(settings.reminder_enabled);
  const [reminderHours, setReminderHours] = useState(String(settings.reminder_hours));

  const [templateValues, setTemplateValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const def of templateDefs) {
      initial[`${def.key}_subject`] = settings.templates[`${def.key}_subject`] ?? def.subject;
      initial[`${def.key}_body`] = settings.templates[`${def.key}_body`] ?? def.body;
    }
    return initial;
  });
  const [templateActive, setTemplateActive] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const def of templateDefs) initial[def.key] = settings.template_enabled[def.key] !== false;
    return initial;
  });
  const [expandedTemplates, setExpandedTemplates] = useState<Record<string, boolean>>({});

  const [widgetValues, setWidgetValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const def of WIDGET_TEXT_DEFS) initial[def.key] = settings.widget_text[def.key] ?? "";
    return initial;
  });

  const [chatEnabled, setChatEnabled] = useState(settings.chat_enabled);
  const [chatPosition, setChatPosition] = useState(settings.chat_position);
  const [chatColor, setChatColor] = useState(settings.chat_color);
  const [chatTitle, setChatTitle] = useState(settings.chat_title);
  const [chatSubtitle, setChatSubtitle] = useState(settings.chat_subtitle);
  const [chatGreeting, setChatGreeting] = useState(settings.chat_greeting);
  const [chatShowFaq, setChatShowFaq] = useState(settings.chat_show_faq);
  const [chatShowBooking, setChatShowBooking] = useState(settings.chat_show_booking);
  const [chatShowMessage, setChatShowMessage] = useState(settings.chat_show_message);
  const [chatOfflineNote, setChatOfflineNote] = useState(settings.chat_offline_note);
  const [chatLauncherText, setChatLauncherText] = useState(settings.chat_launcher_text);

  const [enabledGateways, setEnabledGateways] = useState<string[]>(settings.enabled_gateways);
  const [gatewayValues, setGatewayValues] = useState<Record<string, Record<string, string>>>(
    Object.fromEntries(gatewayFields.map((g) => [g.id, { ...(settings.gateways[g.id] as Record<string, string>) }]))
  );

  const [videoProvider, setVideoProvider] = useState(settings.video_provider);
  const [videoJoinWindow, setVideoJoinWindow] = useState(String(settings.video_join_window));
  const [videoValues, setVideoValues] = useState<Record<string, Record<string, string>>>(
    Object.fromEntries(videoFields.map((v) => [v.id, { ...(settings.video[v.id] as Record<string, string>) }]))
  );

  function savePreset() {
    const form = new FormData();
    form.set("_section", "preset");
    form.set("preset", preset);
    submit(form, { method: "post" });
  }

  function saveGeneral() {
    const form = new FormData();
    form.set("_section", "general");
    form.set("business_name", businessName);
    form.set("business_email", businessEmail);
    form.set("business_phone", businessPhone);
    form.set("currency", currency);
    form.set("currency_symbol", currencySymbol);
    form.set("timezone", timezone);
    form.set("booking_page_url", bookingPageUrl);
    form.set("slot_interval", slotInterval);
    form.set("min_notice_hours", minNotice);
    form.set("max_advance_days", maxAdvance);
    form.set("auto_confirm", String(autoConfirm));
    form.set("allow_cancel", String(allowCancel));
    form.set("cancel_cutoff_hours", cancelCutoff);
    form.set("require_phone", String(requirePhone));
    form.set("consent_text", consentText);
    form.set(
      "intake_fields",
      JSON.stringify(
        intakeFields
          .filter((f) => f.label.trim())
          .map((f) => ({ ...f, key: slugify(f.label) }))
      )
    );
    submit(form, { method: "post" });
  }

  function addIntakeField() {
    setIntakeFields((prev) => [...prev, { key: "", label: "", type: "text", required: false }]);
  }

  function updateIntakeField(index: number, patch: Partial<(typeof intakeFields)[number]>) {
    setIntakeFields((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  }

  function removeIntakeField(index: number) {
    setIntakeFields((prev) => prev.filter((_, i) => i !== index));
  }

  function saveNotifications() {
    const form = new FormData();
    form.set("_section", "notifications");
    form.set("notify_customer", String(notifyCustomer));
    form.set("notify_admin", String(notifyAdmin));
    form.set("admin_email", adminEmail);
    form.set("reminder_enabled", String(reminderEnabled));
    form.set("reminder_hours", reminderHours);
    submit(form, { method: "post" });
  }

  function saveTemplates() {
    const form = new FormData();
    form.set("_section", "templates");
    for (const def of templateDefs) {
      form.set(`tpl_${def.key}_subject`, templateValues[`${def.key}_subject`] ?? "");
      form.set(`tpl_${def.key}_body`, templateValues[`${def.key}_body`] ?? "");
      form.set(`tpl_${def.key}_enabled`, String(templateActive[def.key] !== false));
    }
    submit(form, { method: "post" });
  }

  function saveWidget() {
    const form = new FormData();
    form.set("_section", "widget");
    for (const def of WIDGET_TEXT_DEFS) {
      form.set(`wt_${def.key}`, widgetValues[def.key] ?? "");
    }
    submit(form, { method: "post" });
  }

  function saveChat() {
    const form = new FormData();
    form.set("_section", "chat");
    form.set("chat_enabled", String(chatEnabled));
    form.set("chat_position", chatPosition);
    form.set("chat_color", chatColor);
    form.set("chat_title", chatTitle);
    form.set("chat_subtitle", chatSubtitle);
    form.set("chat_greeting", chatGreeting);
    form.set("chat_show_faq", String(chatShowFaq));
    form.set("chat_show_booking", String(chatShowBooking));
    form.set("chat_show_message", String(chatShowMessage));
    form.set("chat_offline_note", chatOfflineNote);
    form.set("chat_launcher_text", chatLauncherText);
    submit(form, { method: "post" });
  }

  function savePayments() {
    const form = new FormData();
    form.set("_section", "payments");
    enabledGateways.forEach((id) => form.append("enabled_gateways", id));
    for (const g of gatewayFields) {
      for (const field of g.fields) {
        form.set(`gw_${g.id}_${field.key}`, gatewayValues[g.id]?.[field.key] ?? "");
      }
    }
    submit(form, { method: "post" });
  }

  function saveVideo() {
    const form = new FormData();
    form.set("_section", "video");
    form.set("video_provider", videoProvider);
    form.set("video_join_window", videoJoinWindow);
    for (const v of videoFields) {
      for (const field of v.fields) {
        form.set(`video_${v.id}_${field.key}`, videoValues[v.id]?.[field.key] ?? "");
      }
    }
    submit(form, { method: "post" });
  }

  const tabs = [
    { id: "general", content: "General" },
    { id: "widget", content: "Widget" },
    ...(paymentsFeatureEnabled ? [{ id: "payments", content: "Payments" }] : []),
    { id: "video", content: "Video calls" },
    { id: "notifications", content: "Notifications" },
    ...(chatFeatureEnabled ? [{ id: "chat", content: "Chat widget" }] : []),
  ];
  const selectedTab = tabs[tab]?.id ?? "general";

  return (
    <Page title="Settings">
      <Tabs tabs={tabs} selected={tab} onSelect={setTab} />
      <div style={{ marginTop: 16 }}>
        <BlockStack gap="400">
          {selectedTab === "general" && (
            <>
              <Card>
                <FormLayout>
                  <Select label="Industry preset" value={preset} onChange={setPreset} options={presets.map((p) => ({ label: p.label, value: p.value }))} />
                  <InlineStack align="end">
                    <Button onClick={savePreset}>Apply preset</Button>
                  </InlineStack>
                  <Text as="p" tone="subdued">
                    Applying a preset changes the words used throughout the app (e.g. "Doctor" instead of "Staff
                    Member") and sets the booking rules below to sensible defaults for that industry — anything
                    you've already customized there is left as you set it.
                  </Text>
                  <InlineStack gap="150" wrap>
                    {ruleChips(presetRules[preset] ?? presetRules.generic).map((chip) => (
                      <Badge key={chip}>{chip}</Badge>
                    ))}
                  </InlineStack>
                </FormLayout>
              </Card>
              <Card>
                <FormLayout>
                  <TextField label="Business name" value={businessName} onChange={setBusinessName} autoComplete="off" />
                  <FormLayout.Group>
                    <TextField label="Business email" type="email" value={businessEmail} onChange={setBusinessEmail} autoComplete="off" />
                    <TextField label="Business phone" value={businessPhone} onChange={setBusinessPhone} autoComplete="off" />
                  </FormLayout.Group>
                  <FormLayout.Group>
                    <TextField label="Currency code" value={currency} onChange={setCurrency} autoComplete="off" helpText="e.g. USD" />
                    <TextField label="Currency symbol" value={currencySymbol} onChange={setCurrencySymbol} autoComplete="off" />
                  </FormLayout.Group>
                  <TextField label="Timezone" value={timezone} onChange={setTimezone} autoComplete="off" helpText="IANA timezone, e.g. America/New_York" />
                  <TextField
                    label="Booking page URL"
                    value={bookingPageUrl}
                    onChange={setBookingPageUrl}
                    autoComplete="off"
                    helpText="The storefront page holding the GetBooqin Booking block. Used to build manage/cancel links in emails."
                  />
                  <FormLayout.Group>
                    <TextField
                      label={<PresetFieldLabel text="Slot interval (minutes)" customized={settings.customized_fields.includes("slot_interval")} />}
                      type="number" value={slotInterval} onChange={setSlotInterval} autoComplete="off"
                    />
                    <TextField
                      label={<PresetFieldLabel text="Minimum notice (hours)" customized={settings.customized_fields.includes("min_notice_hours")} />}
                      type="number" value={minNotice} onChange={setMinNotice} autoComplete="off"
                    />
                    <TextField
                      label={<PresetFieldLabel text="Booking horizon (days)" customized={settings.customized_fields.includes("max_advance_days")} />}
                      type="number" value={maxAdvance} onChange={setMaxAdvance} autoComplete="off"
                    />
                  </FormLayout.Group>
                  <Checkbox
                    label={<PresetFieldLabel text="Auto-confirm new bookings" customized={settings.customized_fields.includes("auto_confirm")} />}
                    checked={autoConfirm} onChange={setAutoConfirm}
                  />
                  <Checkbox label="Allow customers to cancel online" checked={allowCancel} onChange={setAllowCancel} />
                  <TextField
                    label={<PresetFieldLabel text="Cancellation cutoff (hours before start)" customized={settings.customized_fields.includes("cancel_cutoff_hours")} />}
                    type="number" value={cancelCutoff} onChange={setCancelCutoff} autoComplete="off"
                  />
                  <Checkbox
                    label={<PresetFieldLabel text="Require a phone number" customized={settings.customized_fields.includes("require_phone")} />}
                    checked={requirePhone} onChange={setRequirePhone}
                  />
                  <TextField
                    label={<PresetFieldLabel text="Consent text shown on the booking form" customized={settings.customized_fields.includes("consent_text")} />}
                    value={consentText} onChange={setConsentText} multiline={2} autoComplete="off"
                  />
                  <InlineStack align="end">
                    <Button variant="primary" loading={saving} onClick={saveGeneral}>Save</Button>
                  </InlineStack>
                </FormLayout>
              </Card>
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Custom intake fields</Text>
                  <Text as="p" tone="subdued">
                    Extra fields collected on the storefront booking form, alongside name, email and (if required above) phone.
                  </Text>
                  {intakeFields.map((field, i) => (
                    <InlineStack key={i} gap="200" blockAlign="end" wrap={false}>
                      <div style={{ flex: 2 }}>
                        <TextField
                          label="Label"
                          value={field.label}
                          onChange={(v) => updateIntakeField(i, { label: v })}
                          autoComplete="off"
                        />
                      </div>
                      <div style={{ flex: 1 }}>
                        <Select
                          label="Type"
                          value={field.type}
                          onChange={(v) => updateIntakeField(i, { type: v as typeof field.type })}
                          options={[
                            { label: "Text", value: "text" },
                            { label: "Phone", value: "phone" },
                            { label: "Email", value: "email" },
                            { label: "Multi-line", value: "textarea" },
                          ]}
                        />
                      </div>
                      <Checkbox label="Required" checked={field.required} onChange={(v) => updateIntakeField(i, { required: v })} />
                      <Button onClick={() => removeIntakeField(i)}>Remove</Button>
                    </InlineStack>
                  ))}
                  <InlineStack align="space-between">
                    <Button onClick={addIntakeField}>Add field</Button>
                    <Button variant="primary" loading={saving} onClick={saveGeneral}>Save</Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            </>
          )}

          {selectedTab === "widget" && (
            <Card>
              <BlockStack gap="400">
                <Text as="p" tone="subdued">
                  Customize the wording shown in the storefront booking widget. Leave a field blank to keep the
                  built-in default.
                </Text>
                <FormLayout>
                  {WIDGET_TEXT_DEFS.map((def, i) => (
                    <div key={def.key}>
                      {(i === 0 || WIDGET_TEXT_DEFS[i - 1].group !== def.group) && (
                        <div style={{ marginBottom: 8, marginTop: i === 0 ? 0 : 16 }}>
                          <Text as="h3" variant="headingSm">{def.group}</Text>
                        </div>
                      )}
                      <TextField
                        label={def.label}
                        placeholder={def.default}
                        value={widgetValues[def.key] ?? ""}
                        onChange={(value) => setWidgetValues((prev) => ({ ...prev, [def.key]: value }))}
                        autoComplete="off"
                      />
                    </div>
                  ))}
                  <InlineStack align="end">
                    <Button variant="primary" loading={saving} onClick={saveWidget}>Save</Button>
                  </InlineStack>
                </FormLayout>
              </BlockStack>
            </Card>
          )}

          {selectedTab === "payments" && (
            <Card>
              <BlockStack gap="400">
                <Banner tone="info">
                  Every payment is verified server-side before a booking is marked paid — a browser can never mark itself paid.
                </Banner>
                <FormLayout>
                  {gatewayFields.map((g) => (
                    <Card key={g.id}>
                      <BlockStack gap="200">
                        <Checkbox
                          label={g.label}
                          checked={enabledGateways.includes(g.id)}
                          onChange={(checked) =>
                            setEnabledGateways((prev) => (checked ? [...prev, g.id] : prev.filter((id) => id !== g.id)))
                          }
                        />
                        {g.fields.map((field) => (
                          <TextField
                            key={field.key}
                            label={field.label}
                            type={field.type === "password" ? "password" : "text"}
                            multiline={field.type === "textarea" ? 2 : undefined}
                            helpText={field.description}
                            value={gatewayValues[g.id]?.[field.key] ?? ""}
                            onChange={(value) =>
                              setGatewayValues((prev) => ({ ...prev, [g.id]: { ...prev[g.id], [field.key]: value } }))
                            }
                            autoComplete="off"
                          />
                        ))}
                      </BlockStack>
                    </Card>
                  ))}
                  <InlineStack align="end">
                    <Button variant="primary" loading={saving} onClick={savePayments}>Save</Button>
                  </InlineStack>
                </FormLayout>
              </BlockStack>
            </Card>
          )}

          {selectedTab === "video" && (
            <Card>
              <FormLayout>
                <Select
                  label="Video provider"
                  value={videoProvider}
                  onChange={setVideoProvider}
                  options={videoFields.map((v) => ({ label: v.label, value: v.id }))}
                />
                <TextField label="Join button appears (minutes before start)" type="number" value={videoJoinWindow} onChange={setVideoJoinWindow} autoComplete="off" />
                {videoFields.map((v) => (
                  <Card key={v.id}>
                    <BlockStack gap="200">
                      <Text as="h3" variant="headingSm">{v.label}</Text>
                      {v.fields.map((field) => (
                        <TextField
                          key={field.key}
                          label={field.label}
                          type={field.type === "password" ? "password" : "text"}
                          helpText={field.description}
                          value={videoValues[v.id]?.[field.key] ?? ""}
                          onChange={(value) => setVideoValues((prev) => ({ ...prev, [v.id]: { ...prev[v.id], [field.key]: value } }))}
                          autoComplete="off"
                        />
                      ))}
                    </BlockStack>
                  </Card>
                ))}
                <InlineStack align="end">
                  <Button variant="primary" loading={saving} onClick={saveVideo}>Save</Button>
                </InlineStack>
              </FormLayout>
            </Card>
          )}

          {selectedTab === "notifications" && (
            <>
            <Card>
              <FormLayout>
                <Checkbox label="Notify the customer" checked={notifyCustomer} onChange={setNotifyCustomer} />
                <Checkbox label="Notify the business" checked={notifyAdmin} onChange={setNotifyAdmin} />
                <TextField label="Notification email" type="email" value={adminEmail} onChange={setAdminEmail} autoComplete="off" />
                <Checkbox label="Send reminders" checked={reminderEnabled} onChange={setReminderEnabled} />
                <TextField label="Send reminder this many hours before start" type="number" value={reminderHours} onChange={setReminderHours} autoComplete="off" />
                <Banner tone="info">
                  Reminders are sent by an external scheduler hitting <code>/cron/reminders</code> — see DEVELOPERS.md.
                </Banner>
                <InlineStack align="end">
                  <Button variant="primary" loading={saving} onClick={saveNotifications}>Save</Button>
                </InlineStack>
              </FormLayout>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Email templates</Text>
                <Text as="p" tone="subdued">
                  {"Customize the subject and body of every automated email. Leave a field as-is to keep the default. " +
                    "Available tokens: {{customer_name}}, {{service}}, {{resource}}, {{date}}, {{time}}, {{timezone}}, " +
                    "{{business_name}}, {{manage_url}}, {{price}}, {{amount_due}}, {{payment_line}}, {{meeting_line}}, {{notes}}."}
                </Text>
                <BlockStack gap="300">
                  {templateDefs.map((def, i) => {
                    const active = templateActive[def.key] !== false;
                    const expanded = !!expandedTemplates[def.key];
                    return (
                      <BlockStack key={def.key} gap="200">
                        {(i === 0 || templateDefs[i - 1].group !== def.group) && (
                          <Text as="h3" variant="headingSm">{def.group}</Text>
                        )}
                        <Card>
                          <BlockStack gap="200">
                            <InlineStack align="space-between" blockAlign="start">
                              <BlockStack gap="050">
                                <Text as="p" fontWeight="medium">{def.label}</Text>
                                <Text as="p" tone="subdued" variant="bodySm">{def.description}</Text>
                              </BlockStack>
                              <Checkbox
                                label={active ? "Active" : "Paused"}
                                checked={active}
                                onChange={(checked) => setTemplateActive((prev) => ({ ...prev, [def.key]: checked }))}
                              />
                            </InlineStack>
                            <InlineStack>
                              <Button
                                variant="plain"
                                onClick={() => setExpandedTemplates((prev) => ({ ...prev, [def.key]: !expanded }))}
                              >
                                {expanded ? "Hide template" : "Customize template"}
                              </Button>
                            </InlineStack>
                            {expanded && (
                              <BlockStack gap="200">
                                <TextField
                                  label="Subject"
                                  value={templateValues[`${def.key}_subject`] ?? ""}
                                  onChange={(value) => setTemplateValues((prev) => ({ ...prev, [`${def.key}_subject`]: value }))}
                                  autoComplete="off"
                                />
                                <TextField
                                  label="Body"
                                  value={templateValues[`${def.key}_body`] ?? ""}
                                  onChange={(value) => setTemplateValues((prev) => ({ ...prev, [`${def.key}_body`]: value }))}
                                  multiline={4}
                                  autoComplete="off"
                                />
                              </BlockStack>
                            )}
                          </BlockStack>
                        </Card>
                      </BlockStack>
                    );
                  })}
                  <InlineStack align="end">
                    <Button variant="primary" loading={saving} onClick={saveTemplates}>Save templates</Button>
                  </InlineStack>
                </BlockStack>
              </BlockStack>
            </Card>
            </>
          )}

          {selectedTab === "chat" && (
            <Card>
              <FormLayout>
                <Checkbox label="Enable the chat widget" checked={chatEnabled} onChange={setChatEnabled} />
                <Select label="Position" value={chatPosition} onChange={(v) => setChatPosition(v as "left" | "right")} options={[{ label: "Right", value: "right" }, { label: "Left", value: "left" }]} />
                <TextField label="Accent colour" value={chatColor} onChange={setChatColor} autoComplete="off" />
                <TextField label="Title" value={chatTitle} onChange={setChatTitle} autoComplete="off" />
                <TextField label="Subtitle" value={chatSubtitle} onChange={setChatSubtitle} autoComplete="off" />
                <TextField label="Greeting message" value={chatGreeting} onChange={setChatGreeting} autoComplete="off" />
                <TextField label="Launcher button text" value={chatLauncherText} onChange={setChatLauncherText} autoComplete="off" />
                <Checkbox label="Show 'Ask a question' (FAQ)" checked={chatShowFaq} onChange={setChatShowFaq} />
                <Checkbox label={`Show "Book"`} checked={chatShowBooking} onChange={setChatShowBooking} />
                <Checkbox label="Show 'Leave a message'" checked={chatShowMessage} onChange={setChatShowMessage} />
                <TextField label="Offline note shown before leaving a message" value={chatOfflineNote} onChange={setChatOfflineNote} multiline={2} autoComplete="off" />
                <InlineStack align="end">
                  <Button variant="primary" loading={saving} onClick={saveChat}>Save</Button>
                </InlineStack>
              </FormLayout>
            </Card>
          )}
        </BlockStack>
      </div>
      {showSavedToast && <Toast content="Saved" onDismiss={() => setShowSavedToast(false)} />}
    </Page>
  );
}
