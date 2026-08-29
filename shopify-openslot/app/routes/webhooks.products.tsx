import type { ActionFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "~/shopify.server";
import { Data, ServiceMetafields } from "getbooqin-core";
import { readServiceConfigMetafields } from "~/lib/serviceMetafields.server";

const { diffServiceConfigFields, serviceConfigToFields } = ServiceMetafields;

/**
 * Read-back half of the Prompt 3 catalog refactor. Always refreshes
 * ProductCache from the webhook payload (title/handle/image/price/
 * description/category — all present in the REST payload already, no extra
 * call needed). If the product also has a ServiceConfig, additionally
 * fetches its `getbooqin`-namespace metafields (metafield changes surface as
 * products/update, same topic as any other product edit) and updates only
 * the fields that actually changed — this handler never calls
 * metafieldsSet, so there's no write-triggers-write cycle here; the
 * value-equality check exists only to avoid a redundant DB write on the
 * echo webhook Shopify sends back after GetBooqin's own metafield write
 * (dashboard or the Admin UI Extension).
 *
 * If there's no ServiceConfig yet and the product is typed "Service" (same
 * convention main-product.liquid already checks to hide native buy
 * buttons), auto-creates one with defaults — this is what "configure once"
 * still means here: choosing "Service" in Shopify's own product type field,
 * nothing GetBooqin-specific to click per product.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const id = String((payload as any)?.id ?? "");
  const handle = typeof payload?.handle === "string" ? payload.handle : "";
  if (!id || !handle) return new Response();

  const productType = typeof payload?.product_type === "string" ? payload.product_type : "";
  const title = typeof payload?.title === "string" ? payload.title : "";
  const bodyHtml = typeof (payload as any)?.body_html === "string" ? (payload as any).body_html : "";
  const description = bodyHtml.replace(/<[^>]*>/g, "");
  const images = Array.isArray((payload as any)?.images) ? (payload as any).images : [];
  const image = images[0]?.src ? String(images[0].src) : "";
  const variants = Array.isArray((payload as any)?.variants) ? (payload as any).variants : [];
  const price = variants[0]?.price ? Number(variants[0].price) : 0;
  const updatedAt = typeof (payload as any)?.updated_at === "string" ? (payload as any).updated_at : "";

  await Data.upsertProductCache(shop, "shopify", {
    productId: id,
    productHandle: handle,
    title,
    description,
    category: productType,
    image,
    price,
  });

  try {
    const config = await Data.serviceConfigByProductId(shop, "shopify", id);

    if (!config) {
      if (productType === "Service") {
        await Data.createServiceConfigsFromProducts(shop, "shopify", [{ id, handle, title }]);
      }
      return new Response();
    }

    // Idempotency fast-path: this exact product state has already been
    // processed (duplicate/out-of-order webhook delivery) — skip the extra
    // metafields round-trip entirely.
    if (updatedAt && config.platformUpdatedAt && new Date(updatedAt).getTime() === config.platformUpdatedAt.getTime()) {
      return new Response();
    }

    const { admin } = await unauthenticated.admin(shop);
    const [resourceIds, addonIds] = await Promise.all([
      Data.resourceIdsForService(shop, config.id),
      Data.addonIdsForService(shop, config.id),
    ]);
    const current = serviceConfigToFields(config, resourceIds, addonIds);
    const fromShopify = await readServiceConfigMetafields(admin, id);
    const changed = diffServiceConfigFields(current, fromShopify);

    if (Object.keys(changed).length > 0) {
      await Data.applyServiceConfigMetafieldChanges(shop, config.id, changed);
    }
    if (updatedAt) {
      await Data.stampServiceConfigPlatformUpdatedAt(config.id, new Date(updatedAt));
    }
  } catch (err) {
    console.error(`[getbooqin] service-config read-back failed for shop=${shop} product=${id}:`, err);
  }

  return new Response();
};
