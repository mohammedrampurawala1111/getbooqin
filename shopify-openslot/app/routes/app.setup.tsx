import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData, useActionData, useNavigate, useSubmit } from "react-router";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  FormLayout,
  TextField,
  Select,
  Checkbox,
  Button,
  Text,
  Badge,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { Data, Settings as Backend, Presets } from "getbooqin-core";
import { term } from "getbooqin-core/booking/settingsShared";
import { syncAllProductsFromShopify } from "~/lib/productSync.server";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DEFAULT_SCHEDULE_ENABLED = [false, true, true, true, true, true, false]; // Mon-Fri on
const STEP_LABELS = ["Business", "Team", "Services", "Theme", "Go live"];

function clampStep(raw: string | null): number {
  const n = Number(raw || 1);
  return Number.isFinite(n) && n >= 1 && n <= 5 ? Math.floor(n) : 1;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await Backend.getSettings(shop, "shopify");
  const url = new URL(request.url);
  const step = clampStep(url.searchParams.get("step"));

  const [resourcesCount, servicesCount] = await Promise.all([
    prisma.resource.count({ where: { shop, status: true } }),
    prisma.serviceConfig.count({ where: { shop, status: true } }),
  ]);

  const embedDetectedRecentlyMs = 3 * 24 * 60 * 60 * 1000;
  const embedDetected = settings.embed_last_seen_at
    ? Date.now() - new Date(settings.embed_last_seen_at).getTime() < embedDetectedRecentlyMs
    : false;

  return {
    step,
    settings,
    presets: Presets.presetChoices(),
    resourcesCount,
    servicesCount,
    embedDetected,
    themeEmbedUrl: `https://${shop}/admin/themes/current/editor?context=apps`,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const section = String(form.get("_section"));

  if (section === "skip_all") {
    await Backend.setSettings(shop, "shopify", { onboarding_completed: true });
    return redirect("/app");
  }

  if (section === "business") {
    await Backend.applyPreset(shop, "shopify", String(form.get("preset") || "generic"));
    await Backend.setSettings(shop, "shopify", {
      business_name: String(form.get("business_name") || ""),
      timezone: String(form.get("timezone") || "UTC"),
    });
    return redirect("/app/setup?step=2");
  }

  if (section === "team") {
    const name = String(form.get("name") || "").trim();
    if (name) {
      const schedule: Array<{ day: number; start: string; end: string }> = [];
      for (let day = 0; day < 7; day++) {
        if (form.get(`day_${day}_enabled`) === "true") {
          schedule.push({
            day,
            start: String(form.get(`day_${day}_start`) || "09:00"),
            end: String(form.get(`day_${day}_end`) || "17:00"),
          });
        }
      }
      await Data.saveResource(shop, "shopify", {
        name,
        title: String(form.get("title") || ""),
        schedule,
      });
    }
    return redirect("/app/setup?step=3");
  }

  if (section === "sync_products") {
    const result = await syncAllProductsFromShopify(admin, shop);
    return { ok: true, synced: result };
  }

  if (section === "create_from_products") {
    let products: { id: string; handle: string; title?: string }[] = [];
    try {
      products = JSON.parse(String(form.get("products") || "[]"));
    } catch {
      products = [];
    }
    for (const product of products) {
      await Data.upsertProductCache(shop, "shopify", {
        productId: product.id,
        productHandle: product.handle,
        title: product.title ?? "",
      });
    }
    const { created, skipped } = await Data.createServiceConfigsFromProducts(shop, "shopify", products);
    return { ok: true, created: created.length, skipped };
  }

  if (section === "finish") {
    await Backend.setSettings(shop, "shopify", {
      notify_admin: form.get("notify_admin") === "true",
      notify_customer: form.get("notify_customer") === "true",
      onboarding_completed: true,
    });
    return redirect("/app");
  }

  return redirect("/app/setup?step=1");
}

export default function Onboarding() {
  const { step, settings, presets, resourcesCount, servicesCount, embedDetected, themeEmbedUrl } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigate = useNavigate();
  const submit = useSubmit();

  // Step 1 — business
  const [preset, setPreset] = useState(settings.preset);
  const [businessName, setBusinessName] = useState(settings.business_name);
  const [timezone, setTimezone] = useState(settings.timezone);

  // Step 2 — team
  const [resourceName, setResourceName] = useState("");
  const [resourceTitle, setResourceTitle] = useState("");
  const [schedule, setSchedule] = useState(
    DAY_NAMES.map((_, day) => ({ enabled: DEFAULT_SCHEDULE_ENABLED[day], start: "09:00", end: "17:00" }))
  );
  function updateDay(day: number, patch: Partial<(typeof schedule)[number]>) {
    setSchedule((prev) => prev.map((row, i) => (i === day ? { ...row, ...patch } : row)));
  }

  // Step 5 — go live
  const [notifyAdmin, setNotifyAdmin] = useState(settings.notify_admin);
  const [notifyCustomer, setNotifyCustomer] = useState(settings.notify_customer);

  async function createFromProducts() {
    const shopify = (window as any).shopify;
    if (!shopify?.resourcePicker) return;
    const selected = await shopify.resourcePicker({ type: "product", multiple: true });
    if (!selected || !selected.length) return;
    const products = selected.map((p: any) => ({
      id: String(p.id).split("/").pop() ?? "",
      handle: p.handle ?? "",
      title: p.title ?? "",
    }));
    const form = new FormData();
    form.set("_section", "create_from_products");
    form.set("products", JSON.stringify(products));
    submit(form, { method: "post" });
  }

  function syncAllProducts() {
    const form = new FormData();
    form.set("_section", "sync_products");
    submit(form, { method: "post" });
  }

  function goTo(n: number) {
    navigate(`/app/setup?step=${n}`);
  }

  function skipAll() {
    const form = new FormData();
    form.set("_section", "skip_all");
    submit(form, { method: "post" });
  }

  function submitBusiness() {
    const form = new FormData();
    form.set("_section", "business");
    form.set("preset", preset);
    form.set("business_name", businessName);
    form.set("timezone", timezone);
    submit(form, { method: "post" });
  }

  function submitTeam(skip: boolean) {
    const form = new FormData();
    form.set("_section", "team");
    if (!skip) {
      form.set("name", resourceName);
      form.set("title", resourceTitle);
      schedule.forEach((row, day) => {
        form.set(`day_${day}_enabled`, String(row.enabled));
        form.set(`day_${day}_start`, row.start);
        form.set(`day_${day}_end`, row.end);
      });
    }
    submit(form, { method: "post" });
  }

  function submitFinish() {
    const form = new FormData();
    form.set("_section", "finish");
    form.set("notify_admin", String(notifyAdmin));
    form.set("notify_customer", String(notifyCustomer));
    submit(form, { method: "post" });
  }

  const resourceSingle = term(settings, "resource_single");
  const resourcePlural = term(settings, "resource_plural");
  const serviceSingle = term(settings, "service_single");
  const servicePlural = term(settings, "service_plural");
  const bookingPlural = term(settings, "booking_plural");

  return (
    <Page title="Set up GetBooqin">
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="150">
            {STEP_LABELS.map((label, i) => {
              const n = i + 1;
              const tone = n < step ? "success" : n === step ? "info" : undefined;
              return (
                <Badge key={label} tone={tone}>
                  {`${n}. ${label}`}
                </Badge>
              );
            })}
          </InlineStack>
          <Button variant="plain" onClick={skipAll}>
            Skip setup
          </Button>
        </InlineStack>

        {step === 1 && (
          <Card>
            <BlockStack gap="300">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">Let's get your store ready to take bookings</Text>
                <Text as="p" tone="subdued">Takes about 3 minutes. Change any of this later in Settings.</Text>
              </BlockStack>
              <FormLayout>
                <TextField label="Business name" value={businessName} onChange={setBusinessName} autoComplete="off" />
                <TextField
                  label="Timezone"
                  value={timezone}
                  onChange={setTimezone}
                  autoComplete="off"
                  helpText="IANA timezone, e.g. America/New_York"
                />
                <Select
                  label="What kind of business is this?"
                  value={preset}
                  onChange={setPreset}
                  options={presets.map((p) => ({ label: p.label, value: p.value }))}
                  helpText="Changes the words used throughout the app, e.g. “Doctor” instead of “Staff Member.” It never changes your data."
                />
              </FormLayout>
            </BlockStack>
          </Card>
        )}

        {step === 2 && (
          <Card>
            <BlockStack gap="300">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">Add your first {resourceSingle.toLowerCase()}</Text>
                <Text as="p" tone="subdued">
                  Each {resourceSingle.toLowerCase()} gets their own weekly hours — customers can only book when
                  they're on the clock. Add more anytime from {term(settings, "resource_plural")}.
                </Text>
              </BlockStack>
              <FormLayout>
                <FormLayout.Group>
                  <TextField label="Name" value={resourceName} onChange={setResourceName} autoComplete="off" />
                  <TextField label="Title" value={resourceTitle} onChange={setResourceTitle} autoComplete="off" />
                </FormLayout.Group>
              </FormLayout>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">Weekly hours</Text>
                {DAY_NAMES.map((dayName, day) => (
                  <InlineStack key={dayName} gap="300" blockAlign="center" wrap={false}>
                    <div style={{ width: 110 }}>
                      <Checkbox
                        label={dayName}
                        checked={schedule[day].enabled}
                        onChange={(checked) => updateDay(day, { enabled: checked })}
                      />
                    </div>
                    <TextField
                      label="Start"
                      labelHidden
                      type="time"
                      value={schedule[day].start}
                      onChange={(value) => updateDay(day, { start: value })}
                      disabled={!schedule[day].enabled}
                      autoComplete="off"
                    />
                    <Text as="span">to</Text>
                    <TextField
                      label="End"
                      labelHidden
                      type="time"
                      value={schedule[day].end}
                      onChange={(value) => updateDay(day, { end: value })}
                      disabled={!schedule[day].enabled}
                      autoComplete="off"
                    />
                  </InlineStack>
                ))}
              </BlockStack>
            </BlockStack>
          </Card>
        )}

        {step === 3 && (
          <Card>
            <BlockStack gap="300">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">Add your {servicePlural.toLowerCase()}</Text>
                <Text as="p" tone="subdued">
                  {servicePlural} get their name, price and description from the Shopify product they're linked to.
                </Text>
              </BlockStack>

              {actionData?.synced && (
                <Banner tone="success" title="Synced products from Shopify">
                  <p>
                    {actionData.synced.productsSynced} product{actionData.synced.productsSynced === 1 ? "" : "s"} synced,
                    created {actionData.synced.servicesCreated} new{" "}
                    {actionData.synced.servicesCreated === 1 ? serviceSingle.toLowerCase() : servicePlural.toLowerCase()}.
                  </p>
                </Banner>
              )}
              {actionData?.created !== undefined && (
                <Banner
                  tone="success"
                  title={`Created ${actionData.created} ${actionData.created === 1 ? serviceSingle.toLowerCase() : servicePlural.toLowerCase()}`}
                >
                  <p>
                    Duration defaults to 30 minutes on each — open a {serviceSingle.toLowerCase()} later to adjust
                    duration, buffers, or which {resourcePlural.toLowerCase()} deliver it.
                    {actionData.skipped && actionData.skipped.length > 0
                      ? ` Already configured, skipped: ${actionData.skipped.join(", ")}.`
                      : ""}
                  </p>
                </Banner>
              )}

              <InlineStack gap="200">
                <Button variant="primary" onClick={syncAllProducts}>Sync from your product catalog</Button>
                <Button onClick={createFromProducts}>Choose products</Button>
              </InlineStack>
              <Text as="p" tone="subdued">
                "Sync from your product catalog" creates a {serviceSingle.toLowerCase()} for every product typed
                "Service" in Shopify. Prefer to pick by hand instead? Use "Choose products" — you can select more
                than one.
              </Text>

              <Text as="p" tone="subdued">
                New {servicePlural.toLowerCase()} are available to every active {resourceSingle.toLowerCase()} by
                default — you can restrict this anytime from {servicePlural}.
              </Text>
            </BlockStack>
          </Card>
        )}

        {step === 4 && (
          <Card>
            <BlockStack gap="300">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">Add the booking button to your theme</Text>
                <Text as="p" tone="subdued">One toggle turns on a floating "Book now" button everywhere it's needed.</Text>
              </BlockStack>
              <BlockStack gap="200">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="span" fontWeight="semibold">Storefront button</Text>
                  <Badge tone={embedDetected ? "success" : "new"}>{embedDetected ? "Detected" : "Not detected"}</Badge>
                </InlineStack>
                <Text as="p">
                  Turn this on once and every product linked to a {serviceSingle.toLowerCase()} automatically gets a
                  floating "Book now" button — no block to add, no per-product setup.
                </Text>
                <Text as="p">
                  Step 1: Open the theme editor.
                  <br />
                  Step 2: Turn on "GetBooqin", then press Save.
                </Text>
                <InlineStack>
                  <Button url={themeEmbedUrl} target="_blank" variant="primary">
                    Open theme editor
                  </Button>
                </InlineStack>
              </BlockStack>
              <Text as="p" tone="subdued">
                Prefer exact placement? The "GetBooqin Button" block adds it to one spot on the product page, and the
                "GetBooqin Booking" block adds a dedicated booking page — both optional, from the theme editor.
              </Text>
            </BlockStack>
          </Card>
        )}

        {step === 5 && (
          <Card>
            <BlockStack gap="300">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">You're ready to take {bookingPlural.toLowerCase()}</Text>
                <Text as="p" tone="subdued">Here's what's set up so far.</Text>
              </BlockStack>
              <BlockStack gap="200">
                <InlineStack align="space-between">
                  <Text as="span">Business type</Text>
                  <Badge tone="success">{presets.find((p) => p.value === settings.preset)?.label ?? settings.preset}</Badge>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span">Team</Text>
                  <Badge tone={resourcesCount > 0 ? "success" : "attention"}>
                    {resourcesCount > 0 ? `${resourcesCount} added` : "Not set up yet"}
                  </Badge>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span">{servicePlural}</Text>
                  <Badge tone={servicesCount > 0 ? "success" : "attention"}>
                    {servicesCount > 0 ? `${servicesCount} added` : "Not set up yet"}
                  </Badge>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span">Storefront button</Text>
                  <Badge tone={embedDetected ? "success" : "attention"}>
                    {embedDetected ? "Turned on" : "Not turned on yet"}
                  </Badge>
                </InlineStack>
              </BlockStack>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">Notifications</Text>
                <Checkbox label="Email me when a new booking comes in" checked={notifyAdmin} onChange={setNotifyAdmin} />
                <Checkbox label="Send customers a confirmation email" checked={notifyCustomer} onChange={setNotifyCustomer} />
              </BlockStack>
              <Text as="p" tone="subdued">Payments and video calls can be turned on anytime in Settings.</Text>
            </BlockStack>
          </Card>
        )}

        <InlineStack align="space-between">
          {step > 1 ? <Button onClick={() => goTo(step - 1)}>Back</Button> : <span />}
          <InlineStack gap="200">
            {step === 2 && <Button onClick={() => submitTeam(true)}>Skip for now</Button>}
            {step === 3 && <Button onClick={() => goTo(4)}>Skip for now</Button>}
            {step === 4 && <Button onClick={() => goTo(5)}>Skip for now</Button>}
            {step === 1 && <Button variant="primary" onClick={submitBusiness}>Continue</Button>}
            {step === 2 && <Button variant="primary" onClick={() => submitTeam(false)} disabled={!resourceName.trim()}>Continue</Button>}
            {step === 3 && <Button variant="primary" onClick={() => goTo(4)}>Continue</Button>}
            {step === 4 && <Button variant="primary" onClick={() => goTo(5)}>Continue</Button>}
            {step === 5 && <Button variant="primary" onClick={submitFinish}>Go to my dashboard</Button>}
          </InlineStack>
        </InlineStack>
      </BlockStack>
    </Page>
  );
}
