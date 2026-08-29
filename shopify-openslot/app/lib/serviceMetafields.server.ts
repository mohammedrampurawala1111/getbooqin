/**
 * The two functions that actually call Shopify's `admin.graphql` for
 * ServiceConfig's `getbooqin`-namespace metafields — the embedded-admin-only
 * half of the Prompt 3 catalog refactor. Everything else (shape,
 * serialize/deserialize, diffing) lives in core/src/booking/serviceMetafields.ts
 * now, since it needs no live session — only these two need the embedded
 * app's session-scoped admin client, which only this app has (core's
 * ShopifyAdmin module is a different thing: a raw-access-token client for
 * the standalone dashboard, not a substitute for this).
 */
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { ServiceMetafields } from "getbooqin-core";

const { METAFIELD_NAMESPACE, METAFIELD_TYPES, METAFIELD_KEYS, serialize, deserialize, productGid } = ServiceMetafields;
type ServiceConfigFields = ServiceMetafields.ServiceConfigFields;
type MetafieldKey = ServiceMetafields.MetafieldKey;

export async function pushServiceConfigMetafields(
  admin: AdminApiContext,
  productId: string,
  changed: Partial<ServiceConfigFields>
): Promise<void> {
  const keys = Object.keys(changed) as MetafieldKey[];
  if (keys.length === 0) return;

  const metafields = keys.map((key) => ({
    ownerId: productGid(productId),
    namespace: METAFIELD_NAMESPACE,
    key: METAFIELD_KEYS[key],
    type: METAFIELD_TYPES[key],
    value: serialize(key, changed[key]),
  }));

  const response = await admin.graphql(
    `#graphql
    mutation SetServiceConfigMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }`,
    { variables: { metafields } }
  );
  const body = await response.json();
  const userErrors = body?.data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(`metafieldsSet failed for product ${productId}: ${userErrors.map((e: { message: string }) => e.message).join("; ")}`);
  }
}

/** Reads the product's getbooqin-namespace metafields back — used by
 * webhooks.products.tsx's read-back path and the backfill script's initial
 * seed-check. Returns only the keys actually present on the product; a
 * product neither side has ever configured simply has none yet. */
export async function readServiceConfigMetafields(
  admin: AdminApiContext,
  productId: string
): Promise<Partial<ServiceConfigFields>> {
  const response = await admin.graphql(
    `#graphql
    query ServiceConfigMetafields($id: ID!, $namespace: String!) {
      product(id: $id) {
        metafields(namespace: $namespace, first: 20) {
          nodes { key value }
        }
      }
    }`,
    { variables: { id: productGid(productId), namespace: METAFIELD_NAMESPACE } }
  );
  const body = await response.json();
  const nodes: { key: string; value: string }[] = body?.data?.product?.metafields?.nodes ?? [];
  const byKey = new Map(nodes.map((n) => [n.key, n.value]));

  const result: Partial<ServiceConfigFields> = {};
  for (const key of Object.keys(METAFIELD_KEYS) as MetafieldKey[]) {
    const raw = byKey.get(METAFIELD_KEYS[key]);
    if (raw !== undefined) (result as Record<string, unknown>)[key] = deserialize(key, raw);
  }
  return result;
}
