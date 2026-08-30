import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData, useActionData, useNavigate, useSubmit, Form } from "react-router";
import {
  Page,
  Card,
  BlockStack,
  FormLayout,
  TextField,
  Select,
  Checkbox,
  Button,
  InlineStack,
  ChoiceList,
  Thumbnail,
  Text,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import { Data, Settings, ServiceMetafields, GetBooqinError } from "getbooqin-core";
import { term, money } from "getbooqin-core/booking/settingsShared";
import { pushServiceConfigMetafields } from "~/lib/serviceMetafields.server";

type ServiceConfigFields = ServiceMetafields.ServiceConfigFields;

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await Settings.getSettings(shop, "shopify");
  const isNew = params.id === "new";
  const config = isNew ? null : await Data.serviceConfig(shop, Number(params.id));
  const product = config ? await Data.productCacheByProductId(shop, "shopify", config.productId) : null;
  const resources = await Data.resources(shop, "shopify", true);
  const addons = await Data.addons(shop, "shopify", true);
  const assignedIds = isNew || !config ? [] : await Data.resourceIdsForService(shop, config.id);
  const assignedAddonIds = isNew || !config ? [] : await Data.addonIdsForService(shop, config.id);

  return { settings, config, product, resources, addons, assignedIds, assignedAddonIds, isNew };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();

  if (form.get("_action") === "delete") {
    await Data.deleteServiceConfig(shop, Number(params.id));
    return redirect("/app/services");
  }

  const id = params.id === "new" ? 0 : Number(params.id);
  const resourceIds = form.getAll("resource_ids").map(Number);
  const addonIds = form.getAll("addon_ids").map(Number);
  const productId = String(form.get("product_id") || "");
  const productHandle = String(form.get("product_handle") || "");

  if (!productId || !productHandle) {
    return { error: "Link a product before saving." };
  }

  const { diffServiceConfigFields, serviceConfigToFields } = ServiceMetafields;

  const before = id ? await Data.serviceConfig(shop, id) : null;
  const beforeResourceIds = before ? await Data.resourceIdsForService(shop, before.id) : [];
  const beforeAddonIds = before ? await Data.addonIdsForService(shop, before.id) : [];

  let saved;
  try {
    saved = await Data.saveServiceConfig(
      shop,
      "shopify",
      {
        product_id: productId,
        product_handle: productHandle,
        // No `|| 30` fallback: a blank/missing field must fail validation in
        // Data.saveServiceConfig (NaN isn't finite), not silently become the
        // same wrong default that got five services booked at the wrong
        // length in the first place.
        duration_min: Number(form.get("duration_min")),
        buffer_before_min: Number(form.get("buffer_before_min") || 0),
        buffer_after_min: Number(form.get("buffer_after_min") || 0),
        capacity: Number(form.get("capacity") || 1),
        location_type: String(form.get("location_type") || "onsite") as "onsite" | "video" | "phone",
        payment_required: form.get("payment_required") === "true",
        deposit_percent: Number(form.get("deposit_percent") || 100),
        status: form.get("status") === "true",
        color: String(form.get("color") || ""),
        resource_ids: resourceIds,
        addon_ids: addonIds,
      },
      id
    );
  } catch (err) {
    if (err instanceof GetBooqinError) {
      return { error: err.message };
    }
    throw err;
  }

  // Write-through: only push metafields for fields that actually changed,
  // so an unrelated field edit doesn't spam metafieldsSet with a full
  // snapshot, and so the products/update echo webhook has nothing to react
  // to when nothing here actually moved.
  const nextFields: ServiceConfigFields = serviceConfigToFields(saved, resourceIds, addonIds);
  const previousFields: Partial<ServiceConfigFields> = before
    ? serviceConfigToFields(before, beforeResourceIds, beforeAddonIds)
    : {};
  const changed = diffServiceConfigFields(previousFields, nextFields);
  if (Object.keys(changed).length > 0) {
    await pushServiceConfigMetafields(admin, productId, changed);
    await Data.stampServiceConfigPlatformUpdatedAt(saved.id, new Date());
  }

  return redirect("/app/services");
}

export default function ServiceConfigForm() {
  const { settings, config, product, resources, addons, assignedIds, assignedAddonIds, isNew } =
    useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const submit = useSubmit();

  const [productId, setProductId] = useState(config?.productId ?? "");
  const [productHandle, setProductHandle] = useState(config?.productHandle ?? "");
  const [productTitle, setProductTitle] = useState(product?.title ?? "");
  const [productImage, setProductImage] = useState(product?.image ?? "");

  const [duration, setDuration] = useState(String(config?.durationMin ?? 30));
  const [bufferBefore, setBufferBefore] = useState(String(config?.bufferBeforeMin ?? 0));
  const [bufferAfter, setBufferAfter] = useState(String(config?.bufferAfterMin ?? 0));
  const [capacity, setCapacity] = useState(String(config?.capacity ?? 1));
  const [locationType, setLocationType] = useState(config?.locationType ?? "onsite");
  const [paymentRequired, setPaymentRequired] = useState(config?.paymentRequired ?? false);
  const [depositPercent, setDepositPercent] = useState(String(config?.depositPercent ?? 100));
  const [color, setColor] = useState(config?.color ?? "#2563eb");
  const [status, setStatus] = useState(config?.status ?? true);
  const [selectedResources, setSelectedResources] = useState<string[]>(assignedIds.map(String));
  const [selectedAddons, setSelectedAddons] = useState<string[]>(assignedAddonIds.map(String));

  async function pickProduct() {
    const shopify = (window as any).shopify;
    if (!shopify?.resourcePicker) return;
    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: false,
      selectionIds: productId ? [{ id: `gid://shopify/Product/${productId}` }] : undefined,
    });
    if (!selected || !selected.length) return;
    const picked = selected[0] as any;
    setProductId(String(picked.id).split("/").pop() ?? "");
    setProductHandle(picked.handle ?? "");
    setProductTitle(picked.title ?? "");
    setProductImage(picked.images?.[0]?.originalSrc ?? picked.images?.[0]?.src ?? picked.image?.originalSrc ?? "");
  }

  function handleSubmit() {
    const form = new FormData();
    form.set("product_id", productId);
    form.set("product_handle", productHandle);
    form.set("duration_min", duration);
    form.set("buffer_before_min", bufferBefore);
    form.set("buffer_after_min", bufferAfter);
    form.set("capacity", capacity);
    form.set("location_type", locationType);
    form.set("payment_required", String(paymentRequired));
    form.set("deposit_percent", depositPercent);
    form.set("color", color);
    form.set("status", String(status));
    selectedResources.forEach((id) => form.append("resource_ids", id));
    selectedAddons.forEach((id) => form.append("addon_ids", id));
    submit(form, { method: "post" });
  }

  return (
    <Page
      title={isNew ? `Add ${term(settings, "service_single").toLowerCase()}` : productTitle || `Product ${productId}`}
      backAction={{ content: "Services", onAction: () => navigate("/app/services") }}
      primaryAction={{ content: "Save", onAction: handleSubmit, disabled: !productId }}
      secondaryActions={
        isNew
          ? []
          : [
              {
                content: "Delete",
                destructive: true,
                onAction: () => {
                  const form = new FormData();
                  form.set("_action", "delete");
                  submit(form, { method: "post" });
                },
              },
            ]
      }
    >
      <Form method="post">
        <BlockStack gap="400">
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">Product</Text>
              <Text as="p" tone="subdued">
                {term(settings, "service_single")} name, price, and description always come from the linked Shopify
                product — edit those in Shopify. Everything below is booking config, editable here or from the
                product's admin page.
              </Text>
              {productId ? (
                <InlineStack gap="300" blockAlign="center">
                  {productImage && <Thumbnail source={productImage} alt={productTitle} size="small" />}
                  <Text as="span" fontWeight="semibold">{productTitle || `Product ${productId}`}</Text>
                  {product && <Text as="span" tone="subdued">{product.price > 0 ? money(settings, product.price) : "Free"}</Text>}
                  <Button onClick={pickProduct}>Change product</Button>
                </InlineStack>
              ) : (
                <InlineStack>
                  <Button onClick={pickProduct}>Link a product</Button>
                </InlineStack>
              )}
            </BlockStack>
          </Card>

          <Card>
            <FormLayout>
              <FormLayout.Group>
                <TextField label="Duration (minutes)" type="number" value={duration} onChange={setDuration} autoComplete="off" />
                <TextField label="Buffer before (minutes)" type="number" value={bufferBefore} onChange={setBufferBefore} autoComplete="off" />
                <TextField label="Buffer after (minutes)" type="number" value={bufferAfter} onChange={setBufferAfter} autoComplete="off" />
              </FormLayout.Group>
              <TextField label="Capacity" type="number" value={capacity} onChange={setCapacity} autoComplete="off" />
              <Select
                label="Location"
                value={locationType}
                onChange={setLocationType}
                options={[
                  { label: "On site", value: "onsite" },
                  { label: "Video call", value: "video" },
                  { label: "Phone", value: "phone" },
                ]}
              />
              <Checkbox label="Payment required to hold the booking" checked={paymentRequired} onChange={setPaymentRequired} />
              <TextField
                label="Charge online (% of price, as a deposit)"
                type="number"
                value={depositPercent}
                onChange={setDepositPercent}
                autoComplete="off"
                suffix="%"
              />
              <TextField
                label="Storefront swatch colour"
                helpText="Shown as a dot next to this service in the storefront services grid."
                value={color}
                onChange={setColor}
                autoComplete="off"
              />
              <Checkbox label="Active" checked={status} onChange={setStatus} />
            </FormLayout>
          </Card>

          <Card>
            <BlockStack gap="200">
              <ChoiceList
                title={`${term(settings, "resource_plural")} who can deliver this`}
                allowMultiple
                choices={resources.map((r) => ({ label: r.name, value: String(r.id) }))}
                selected={selectedResources}
                onChange={setSelectedResources}
              />
              {resources.length === 0 && <p>No {term(settings, "resource_plural").toLowerCase()} yet. Leaving this empty allows any active one to deliver it.</p>}
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="200">
              <ChoiceList
                title="Add-ons offered for this service"
                allowMultiple
                choices={addons.map((a) => ({ label: a.name, value: String(a.id) }))}
                selected={selectedAddons}
                onChange={setSelectedAddons}
              />
              {addons.length === 0 && <p>No add-ons yet. Create one under Add-ons, then attach it here.</p>}
            </BlockStack>
          </Card>

          <InlineStack align="end">
            <Button variant="primary" onClick={handleSubmit} disabled={!productId}>Save</Button>
          </InlineStack>
        </BlockStack>
      </Form>
    </Page>
  );
}
