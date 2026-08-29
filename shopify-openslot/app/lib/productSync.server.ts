/**
 * "Sync all products" for the embedded admin — same query shape and
 * ProductCache/ServiceConfig-creation logic as core's ShopifyAdmin.
 * syncProductsFromShopify, but driven by the live session's admin.graphql()
 * instead of a raw offline access token (core's version is explicitly the
 * standalone-dashboard client — see that file's header comment — so this
 * exists as its embedded-admin counterpart, same pattern as
 * serviceMetafields.server.ts).
 */
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { Data } from "getbooqin-core";

interface ShopifyProductNode {
  id: string;
  handle: string;
  title: string;
  descriptionHtml: string | null;
  productType: string;
  featuredImage: { url: string } | null;
  variants: { nodes: { price: string }[] };
}

export async function syncAllProductsFromShopify(
  admin: AdminApiContext,
  shop: string
): Promise<{ productsSynced: number; servicesCreated: number }> {
  let productsSynced = 0;
  let servicesCreated = 0;
  let cursor: string | null = null;

  do {
    const response = await admin.graphql(
      `#graphql
      query SyncProducts($cursor: String) {
        products(first: 50, after: $cursor) {
          nodes {
            id
            handle
            title
            descriptionHtml
            productType
            featuredImage { url }
            variants(first: 1) { nodes { price } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { variables: { cursor } }
    );
    const body = await response.json();
    const data: { products: { nodes: ShopifyProductNode[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } = body.data;

    for (const node of data.products.nodes) {
      const productId = node.id.split("/").pop() ?? node.id;
      await Data.upsertProductCache(shop, "shopify", {
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
        const existing = await Data.serviceConfigByProductId(shop, "shopify", productId);
        if (!existing) {
          await Data.createServiceConfigsFromProducts(shop, "shopify", [{ id: productId, handle: node.handle, title: node.title }]);
          servicesCreated += 1;
        }
      }
    }

    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);

  return { productsSynced, servicesCreated };
}
