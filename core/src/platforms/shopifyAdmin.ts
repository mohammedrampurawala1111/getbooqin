/**
 * Raw-token Shopify Admin API client — the standalone-app complement to
 * shopify-openslot's embedded `admin.graphql()` (which only exists inside a
 * live Shopify-authenticated request). Here there is no such request: the
 * caller already has the shop's offline access token from `Connection.
 * credentials` (decrypted via ../auth/encryption.ts), so this talks to
 * Shopify directly with it.
 *
 * Two jobs, both pre-cutover necessities (see docs/plan's Prompt 4 section):
 * 1. `syncProductsFromShopify` populates `ProductCache`/auto-creates
 *    `ServiceConfig` rows — the only way core's cache gets seeded at all
 *    before shopify-openslot's webhooks are repointed at core.
 * 2. `pushServiceConfigMetafields`/`readServiceConfigMetafields` mirror
 *    shopify-openslot/app/lib/serviceMetafields.server.ts's write-through/
 *    read-back, so editing booking config from the standalone dashboard
 *    stays in sync with the same `getbooqin`-namespace metafields the
 *    embedded admin and its Admin UI Extension use.
 */
import * as Data from "../booking/data.js";
import {
  METAFIELD_NAMESPACE,
  METAFIELD_KEYS,
  METAFIELD_TYPES,
  deserialize,
  productGid,
  serialize,
  type MetafieldKey,
  type ServiceConfigFields,
} from "../booking/serviceMetafields.js";

const API_VERSION = "2026-01";

async function shopifyAdminGraphQL<T>(
  shop: string,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const response = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new Error(`Shopify Admin API request failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) {
    throw new Error(`Shopify Admin API returned errors: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  return body.data as T;
}

export async function pushServiceConfigMetafields(
  shop: string,
  accessToken: string,
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

  const data = await shopifyAdminGraphQL<{ metafieldsSet: { userErrors: { field: string[]; message: string }[] } }>(
    shop,
    accessToken,
    `#graphql
    mutation SetServiceConfigMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }`,
    { metafields }
  );

  const userErrors = data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(`metafieldsSet failed for product ${productId}: ${userErrors.map((e) => e.message).join("; ")}`);
  }
}

export async function readServiceConfigMetafields(
  shop: string,
  accessToken: string,
  productId: string
): Promise<Partial<ServiceConfigFields>> {
  const data = await shopifyAdminGraphQL<{ product: { metafields: { nodes: { key: string; value: string }[] } } | null }>(
    shop,
    accessToken,
    `#graphql
    query ServiceConfigMetafields($id: ID!, $namespace: String!) {
      product(id: $id) {
        metafields(namespace: $namespace, first: 20) {
          nodes { key value }
        }
      }
    }`,
    { id: productGid(productId), namespace: METAFIELD_NAMESPACE }
  );

  const nodes = data?.product?.metafields?.nodes ?? [];
  const byKey = new Map(nodes.map((n) => [n.key, n.value]));

  const result: Partial<ServiceConfigFields> = {};
  for (const key of Object.keys(METAFIELD_KEYS) as MetafieldKey[]) {
    const raw = byKey.get(METAFIELD_KEYS[key]);
    if (raw !== undefined) (result as Record<string, unknown>)[key] = deserialize(key, raw);
  }
  return result;
}

interface ShopifyProductNode {
  id: string;
  handle: string;
  title: string;
  descriptionHtml: string | null;
  productType: string;
  updatedAt: string;
  featuredImage: { url: string } | null;
  variants: { nodes: { price: string }[] };
}

/**
 * Pulls every product from Shopify and upserts ProductCache, auto-creating a
 * ServiceConfig for any product typed "Service" that doesn't have one yet —
 * the same convention shopify-openslot's webhooks.products.tsx uses. This is
 * how core's cache gets populated at all before shopify-openslot's own
 * webhooks are repointed here (see the Prompt 4 phased-cutover note).
 */
export async function syncProductsFromShopify(
  shop: string,
  platform: string,
  accessToken: string
): Promise<{ productsSynced: number; servicesCreated: number }> {
  let productsSynced = 0;
  let servicesCreated = 0;
  let cursor: string | null = null;

  do {
    const data: { products: { nodes: ShopifyProductNode[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } =
      await shopifyAdminGraphQL(
        shop,
        accessToken,
        `#graphql
      query SyncProducts($cursor: String) {
        products(first: 50, after: $cursor) {
          nodes {
            id
            handle
            title
            descriptionHtml
            productType
            updatedAt
            featuredImage { url }
            variants(first: 1) { nodes { price } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
        { cursor }
      );

    for (const node of data.products.nodes) {
      const productId = node.id.split("/").pop() ?? node.id;
      await Data.upsertProductCache(shop, platform, {
        productId,
        productHandle: node.handle,
        title: node.title,
        description: (node.descriptionHtml ?? "").replace(/<[^>]*>/g, ""),
        category: node.productType,
        image: node.featuredImage?.url ?? "",
        price: Number(node.variants.nodes[0]?.price ?? 0),
      });
      productsSynced += 1;

      if (node.productType === "Service") {
        const existing = await Data.serviceConfigByProductId(shop, platform, productId);
        if (!existing) {
          await Data.createServiceConfigsFromProducts(shop, platform, [{ id: productId, handle: node.handle, title: node.title }]);
          servicesCreated += 1;
        }
      }
    }

    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);

  return { productsSynced, servicesCreated };
}
