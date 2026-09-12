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
import { Settings as Backend } from "getbooqin-core";
import { Mailer } from "getbooqin-core";

function slugify(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "field";
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

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const settings = await Backend.getSettings(session.shop, "shopify");
  return {
    settings,
    templateDefs: Mailer.TEMPLATE_DEFS,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const section = String(form.get("_section"));

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
      waitlist_enabled: form.get("waitlist_enabled") === "true",
      waitlist_offer_window_hours: Number(form.get("waitlist_offer_window_hours") || 4),
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

  return { ok: false };
}

export default function Settings() {
  const {
    settings,
    templateDefs,
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
  const [waitlistEnabled, setWaitlistEnabled] = useState(settings.waitlist_enabled);
  const [waitlistOfferWindow, setWaitlistOfferWindow] = useState(String(settings.waitlist_offer_window_hours));
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
    form.set("waitlist_enabled", String(waitlistEnabled));
    form.set("waitlist_offer_window_hours", waitlistOfferWindow);
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

  const tabs = [
    { id: "general", content: "General" },
    { id: "widget", content: "Widget" },
    { id: "notifications", content: "Notifications" },
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
                      label="Slot interval (minutes)"
                      type="number" value={slotInterval} onChange={setSlotInterval} autoComplete="off"
                    />
                    <TextField
                      label="Minimum notice (hours)"
                      type="number" value={minNotice} onChange={setMinNotice} autoComplete="off"
                    />
                    <TextField
                      label="Booking horizon (days)"
                      type="number" value={maxAdvance} onChange={setMaxAdvance} autoComplete="off"
                    />
                  </FormLayout.Group>
                  <Checkbox
                    label="Auto-confirm new bookings"
                    checked={autoConfirm} onChange={setAutoConfirm}
                  />
                  <Checkbox label="Allow customers to cancel online" checked={allowCancel} onChange={setAllowCancel} />
                  <TextField
                    label="Cancellation cutoff (hours before start)"
                    type="number" value={cancelCutoff} onChange={setCancelCutoff} autoComplete="off"
                  />
                  <Checkbox
                    label="Require a phone number"
                    checked={requirePhone} onChange={setRequirePhone}
                  />
                  <Checkbox
                    label="Offer freed slots to the waitlist"
                    helpText="When a booking is cancelled, declined or marked no-show, offer that slot to the next matching person on the waitlist."
                    checked={waitlistEnabled} onChange={setWaitlistEnabled}
                  />
                  {waitlistEnabled && (
                    <TextField
                      label="Waitlist offer window (hours)"
                      helpText="How long someone has to claim an offered slot before it's offered to the next person."
                      type="number" value={waitlistOfferWindow} onChange={setWaitlistOfferWindow} autoComplete="off"
                    />
                  )}
                  <TextField
                    label="Consent text shown on the booking form"
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

        </BlockStack>
      </div>
      {showSavedToast && <Toast content="Saved" onDismiss={() => setShowSavedToast(false)} />}
    </Page>
  );
}
