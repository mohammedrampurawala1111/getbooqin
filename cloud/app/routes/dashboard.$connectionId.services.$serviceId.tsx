import { Form, data, redirect } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.services.$serviceId";
import { Data, Settings, ShopifyAdmin, ServiceMetafields, decryptCredentials } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { AlertError, Field, Input, Toggle, CheckCard } from "~/components/ui";

const SWATCHES = ["#b05fc9", "#2563eb", "#0f7a4f", "#92600b", "#b42318", "#545b68"];

export const meta: Route.MetaFunction = ({ data: loaderData }) => [
  { title: `${loaderData?.product?.title || "Service"} · GetBooqin` },
];

export async function loader({ request, params }: Route.LoaderArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  const id = Number(params.serviceId);

  const config = await Data.serviceConfig(shop, id);
  if (!config) throw data("Service not found", { status: 404 });

  const [product, resources, addons, resourceIds, addonIds, settings] = await Promise.all([
    Data.productCacheByProductId(shop, platform, config.productId),
    Data.resources(shop, platform, true),
    Data.addons(shop, platform, true),
    Data.resourceIdsForService(shop, id),
    Data.addonIdsForService(shop, id),
    Settings.getSettings(shop, platform),
  ]);

  return { config, product, resources, addons, resourceIds, addonIds, currencySymbol: settings.currency_symbol };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { shop, platform, connection } = await requireTenant(request, params.connectionId);
  const id = Number(params.serviceId);
  const form = await request.formData();

  const before = await Data.serviceConfig(shop, id);
  if (!before) throw data("Service not found", { status: 404 });
  const [beforeResourceIds, beforeAddonIds] = await Promise.all([
    Data.resourceIdsForService(shop, id),
    Data.addonIdsForService(shop, id),
  ]);

  const resourceIds = form.getAll("resource_ids").map(Number);
  const addonIds = form.getAll("addon_ids").map(Number);

  const saved = await Data.saveServiceConfig(
    shop,
    platform,
    {
      product_id: before.productId,
      product_handle: before.productHandle,
      duration_min: Number(form.get("duration_min") ?? 30),
      buffer_before_min: Number(form.get("buffer_before_min") ?? 0),
      buffer_after_min: Number(form.get("buffer_after_min") ?? 0),
      capacity: Number(form.get("capacity") ?? 1),
      location_type: String(form.get("location_type") ?? "onsite") as "onsite" | "video" | "phone",
      payment_required: form.get("payment_required") === "on",
      deposit_percent: Number(form.get("deposit_percent") ?? 100),
      color: String(form.get("color") ?? before.color),
      status: form.get("status") === "on",
      resource_ids: resourceIds,
      addon_ids: addonIds,
    },
    id
  );

  // Manual connections own their catalogue directly (no external platform
  // product to defer to — see services.new.tsx), so name/price/description
  // are editable right here instead of being a read-only sync target.
  if (platform === "manual") {
    await Data.upsertProductCache(shop, platform, {
      productId: before.productId,
      productHandle: before.productHandle,
      title: String(form.get("title") ?? ""),
      description: String(form.get("description") ?? ""),
      category: String(form.get("category") ?? ""),
      price: Number(form.get("price") ?? 0),
    });
  }

  // Write-through to the connected platform's product metafields, mirroring
  // the embedded admin's app.services_.$id.tsx — only push fields that
  // actually changed, and only for Shopify connections (the only platform
  // with a metafield concept today).
  if (platform === "shopify") {
    try {
      const current = ServiceMetafields.serviceConfigToFields(before, beforeResourceIds, beforeAddonIds);
      const next = ServiceMetafields.serviceConfigToFields(saved, resourceIds, addonIds);
      const changed = ServiceMetafields.diffServiceConfigFields(current, next);
      if (Object.keys(changed).length > 0) {
        const accessToken = decryptCredentials(connection.credentials);
        await ShopifyAdmin.pushServiceConfigMetafields(shop, accessToken, saved.productId, changed);
      }
    } catch (err) {
      return { error: `Saved, but syncing to Shopify failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  return redirect(`/dashboard/${params.connectionId}/services/${id}`);
}

export default function ServiceDetail({ loaderData, actionData, params }: Route.ComponentProps) {
  const { config, product, resources, addons, resourceIds, addonIds, currencySymbol } = loaderData;
  const base = `/dashboard/${params.connectionId}`;
  const swatches = SWATCHES.includes(config.color) ? SWATCHES : [config.color, ...SWATCHES];
  const editable = config.platform === "manual";

  return (
    <div className="flex flex-col gap-[18px]">
      <div>
        <a href={`${base}/services`} className="btn-link">
          &larr; All services
        </a>
      </div>
      <h1 className="page-title">{product?.title || `Service #${config.id}`}</h1>
      {actionData?.error && <AlertError>{actionData.error}</AlertError>}

      <Form method="post" className="flex flex-col gap-[14px]">
        {editable ? (
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Details</h2>
            </div>
            <div className="card-body grid grid-cols-2 gap-x-4 gap-y-[14px]">
              <div className="col-span-2">
                <Field label="Name">
                  <Input name="title" defaultValue={product?.title} required />
                </Field>
              </div>
              <Field label="Price">
                <div className="relative">
                  <span className="pointer-events-none absolute left-[11px] top-1/2 -translate-y-1/2 text-body text-muted">
                    {currencySymbol}
                  </span>
                  <Input type="number" name="price" min={0} step="0.01" defaultValue={product?.price ?? 0} className="pl-[26px]" />
                </div>
              </Field>
              <Field label="Category">
                <Input name="category" defaultValue={product?.category} />
              </Field>
              <div className="col-span-2">
                <Field label="Description">
                  <textarea name="description" rows={3} className="input" defaultValue={product?.description} />
                </Field>
              </div>
            </div>
          </div>
        ) : (
          <div className="readonly-panel">
            <span className="readonly-tag">Read-only</span>
            <div className="kv">
              <span className="kv-key">Name</span>
              <span className="kv-val">{product?.title || "—"} (from the connected store's product)</span>
            </div>
            <div className="kv">
              <span className="kv-key">Price</span>
              <span className="kv-val num">{product && product.price > 0 ? `${currencySymbol}${product.price.toFixed(2)}` : "—"}</span>
            </div>
            <div className="kv">
              <span className="kv-key">Category</span>
              <span className="kv-val">{product?.category || "—"}</span>
            </div>
          </div>
        )}

        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Booking settings</h2>
          </div>
          <div className="card-body grid grid-cols-2 gap-x-4 gap-y-[14px]">
            <Field label="Duration (minutes)" hint="How long this booking takes, start to finish.">
              <Input type="number" name="duration_min" min={5} defaultValue={config.durationMin} />
            </Field>
            <Field label="Capacity" hint="How many customers can book the same slot at once.">
              <Input type="number" name="capacity" min={1} defaultValue={config.capacity} />
            </Field>
            <Field label="Buffer before (min)" hint="How long to leave free before each booking.">
              <Input type="number" name="buffer_before_min" min={0} defaultValue={config.bufferBeforeMin} />
            </Field>
            <Field label="Buffer after (min)" hint="How long to leave free after each booking.">
              <Input type="number" name="buffer_after_min" min={0} defaultValue={config.bufferAfterMin} />
            </Field>
            <Field label="Location">
              <select name="location_type" defaultValue={config.locationType} className="input">
                <option value="onsite">On site</option>
                <option value="video">Video call</option>
                <option value="phone">Phone</option>
              </select>
            </Field>
            <Field label="Deposit (% of price)" hint="What share of the price is due to hold the booking.">
              <Input type="number" name="deposit_percent" min={1} max={100} defaultValue={config.depositPercent} />
            </Field>

            <div className="col-span-2 flex flex-col gap-3">
              <Toggle name="payment_required" defaultChecked={config.paymentRequired} label="Payment required to hold the booking" />
              <Toggle name="status" defaultChecked={config.status} label="Active" />
            </div>

            <div className="col-span-2">
              <span className="field-label mb-[6px] block">Storefront swatch colour</span>
              <div className="flex gap-2">
                {swatches.map((c) => (
                  <label key={c} className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full">
                    <input type="radio" name="color" value={c} defaultChecked={config.color === c} className="peer sr-only" />
                    <span
                      className="h-6 w-6 rounded-full ring-2 ring-transparent ring-offset-2 peer-checked:ring-brand-500"
                      style={{ backgroundColor: c }}
                    />
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Who can deliver this</h2>
          </div>
          <div className="card-body grid grid-cols-2 gap-2">
            {resources.length === 0 ? (
              <p className="col-span-2 m-0 text-body text-muted">
                No resources yet — every active resource can deliver this until you add one.
              </p>
            ) : (
              resources.map((r) => (
                <CheckCard
                  key={r.id}
                  name="resource_ids"
                  value={String(r.id)}
                  label={r.name}
                  defaultChecked={resourceIds.includes(r.id)}
                />
              ))
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Add-ons offered</h2>
          </div>
          <div className="card-body grid grid-cols-2 gap-2">
            {addons.length === 0 ? (
              <p className="col-span-2 m-0 text-body text-muted">No add-ons yet.</p>
            ) : (
              addons.map((a) => (
                <CheckCard key={a.id} name="addon_ids" value={String(a.id)} label={a.name} defaultChecked={addonIds.includes(a.id)} />
              ))
            )}
          </div>
        </div>

        <div>
          <button type="submit" className="btn-pri">
            Save
          </button>
        </div>
      </Form>
    </div>
  );
}
