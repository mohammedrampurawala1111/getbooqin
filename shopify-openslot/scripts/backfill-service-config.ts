/**
 * One-off migration step for the Prompt 3 catalog refactor. Run once per
 * environment, after the additive migration
 * (20260827120000_add_service_config_and_product_cache) and before the
 * destructive one (20260827120100_finalize_service_config) — see the
 * comments on each migration.sql. Usage: `npm run backfill:service-config`.
 *
 * For every existing Service row (pre-refactor: durationMin/buffers/
 * capacity/etc. with no productId yet), looks up its linked product(s) via
 * the legacy ServiceProduct table (read with $queryRaw — that model no
 * longer exists in schema.prisma, but the physical table is still present
 * at this point in the migration) and:
 *
 *  - First linked product: updates the same Service row in place with
 *    productId/productHandle (1:1 — see the Prompt 3 design note on why a
 *    Service with many products doesn't stay many-to-one).
 *  - Each additional linked product: creates a new ServiceConfig row seeded
 *    with the same duration/buffer/capacity/location/payment/deposit
 *    values and the same resource/addon links, so no product silently loses
 *    its "Book now" button.
 *  - No linked product at all (orphan): per item 8's default ("not valid
 *    going forward"), the row is deactivated and given a synthetic
 *    `orphan-<id>` productId/productHandle rather than deleted outright —
 *    deleting it isn't an option once any Booking references it (no
 *    cascade on Booking.serviceId), and the destructive migration requires
 *    productId to be non-null. It just stops being bookable/editable.
 *
 * For every real (non-orphan) product touched, fetches the live product via
 * the Shopify Admin API to fully seed ProductCache (price/description/
 * category weren't cached by the old ServiceProduct) and writes the initial
 * metafields so Shopify's side and the Admin UI Extension are populated
 * from day one.
 */
import prisma from "../app/db.server";
import { unauthenticated } from "../app/shopify.server";
import { pushServiceConfigMetafields } from "../app/lib/serviceMetafields.server";
import { ServiceMetafields, Data } from "getbooqin-core";

const { serviceConfigToFields } = ServiceMetafields;

interface LegacyServiceProductRow {
  id: number;
  shop: string;
  serviceId: number;
  productId: string;
  productHandle: string;
}

async function legacyProductLinks(serviceId: number): Promise<LegacyServiceProductRow[]> {
  return prisma.$queryRaw<LegacyServiceProductRow[]>`
    SELECT id, shop, "serviceId", "productId", "productHandle"
    FROM "ServiceProduct"
    WHERE "serviceId" = ${serviceId}
    ORDER BY id ASC
  `;
}

interface ShopifyProduct {
  id: string;
  handle: string;
  title: string;
  bodyHtml: string | null;
  productType: string;
  featuredImage: { url: string } | null;
  priceRangeV2: { minVariantPrice: { amount: string } };
}

async function fetchLiveProduct(shop: string, productId: string): Promise<ShopifyProduct | null> {
  const { admin } = await unauthenticated.admin(shop);
  const response = await admin.graphql(
    `#graphql
    query BackfillProduct($id: ID!) {
      product(id: $id) {
        id
        handle
        title
        bodyHtml
        productType
        featuredImage { url }
        priceRangeV2 { minVariantPrice { amount } }
      }
    }`,
    { variables: { id: `gid://shopify/Product/${productId}` } }
  );
  const body = await response.json();
  return body?.data?.product ?? null;
}

async function seedProductAndMetafields(
  shop: string,
  serviceId: number,
  productId: string,
  productHandle: string
) {
  const live = await fetchLiveProduct(shop, productId);
  await Data.upsertProductCache(shop, "shopify", {
    productId,
    productHandle,
    title: live?.title ?? "",
    description: (live?.bodyHtml ?? "").replace(/<[^>]*>/g, ""),
    category: live?.productType ?? "",
    image: live?.featuredImage?.url ?? "",
    price: live?.priceRangeV2?.minVariantPrice?.amount ? Number(live.priceRangeV2.minVariantPrice.amount) : 0,
  });

  const config = await prisma.serviceConfig.findUniqueOrThrow({ where: { id: serviceId } });
  const [resourceIds, addonIds] = await Promise.all([
    Data.resourceIdsForService(shop, serviceId),
    Data.addonIdsForService(shop, serviceId),
  ]);
  const { admin } = await unauthenticated.admin(shop);
  await pushServiceConfigMetafields(admin, productId, serviceConfigToFields(config, resourceIds, addonIds));
}

async function run() {
  const legacyServices = await prisma.$queryRaw<{ id: number; shop: string }[]>`
    SELECT id, shop FROM "Service" WHERE "productId" IS NULL ORDER BY id ASC
  `;

  console.log(`Found ${legacyServices.length} Service row(s) to backfill.`);

  let created = 0;
  let orphaned = 0;

  for (const { id, shop } of legacyServices) {
    const links = await legacyProductLinks(id);

    if (links.length === 0) {
      console.warn(`[orphan] Service ${id} (shop=${shop}) has no linked product — deactivating, not deleting (Booking history may reference it).`);
      await prisma.serviceConfig.update({
        where: { id },
        data: { productId: `orphan-${id}`, productHandle: `orphan-${id}`, status: false },
      });
      orphaned++;
      continue;
    }

    const [primary, ...rest] = links;
    await prisma.serviceConfig.update({
      where: { id },
      data: { productId: primary.productId, productHandle: primary.productHandle },
    });
    await seedProductAndMetafields(shop, id, primary.productId, primary.productHandle);

    for (const link of rest) {
      const source = await prisma.serviceConfig.findUniqueOrThrow({ where: { id } });
      const duplicate = await prisma.serviceConfig.create({
        data: {
          shop,
          productId: link.productId,
          productHandle: link.productHandle,
          durationMin: source.durationMin,
          bufferBeforeMin: source.bufferBeforeMin,
          bufferAfterMin: source.bufferAfterMin,
          capacity: source.capacity,
          locationType: source.locationType,
          paymentRequired: source.paymentRequired,
          depositPercent: source.depositPercent,
          color: source.color,
          position: source.position,
          status: source.status,
        },
      });

      const [resourceIds, addonIds] = await Promise.all([
        Data.resourceIdsForService(shop, id),
        Data.addonIdsForService(shop, id),
      ]);
      if (resourceIds.length) await Data.setServiceResources(shop, duplicate.id, resourceIds);
      if (addonIds.length) await Data.setServiceAddons(shop, duplicate.id, addonIds);

      await seedProductAndMetafields(shop, duplicate.id, link.productId, link.productHandle);
      created++;
      console.log(`[duplicated] Service ${id} -> new ServiceConfig ${duplicate.id} for product ${link.productId} (shop=${shop})`);
    }
  }

  console.log(`Done. ${legacyServices.length} rows processed, ${created} duplicate(s) created for multi-product services, ${orphaned} orphan(s) deactivated.`);
  console.log(`Verify the results, then run the destructive migration: prisma migrate deploy`);
}

run()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
