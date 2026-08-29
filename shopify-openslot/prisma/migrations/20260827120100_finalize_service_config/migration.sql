-- Step 2 of 2 (Prompt 3 catalog refactor). Do not run this until
-- scripts/backfill-service-config.ts has been run against this environment
-- and every Service row has a non-null productId/productHandle — this
-- migration drops the legacy catalog columns and the ServiceProduct table
-- outright, and there is no going back from that.

-- Drop ServiceProduct now that ServiceConfig.productId/productHandle (1:1)
-- has superseded it.
DROP TABLE "ServiceProduct";

-- Legacy catalog fields — name/price/category/description are now read
-- from the Shopify product (ProductCache), never stored here as editable
-- state. slug was only ever used to render the old catalog UI. `color`
-- (the storefront services-grid swatch) is kept — it's a GetBooqin-only
-- display preference with no Shopify product equivalent, not a catalog
-- field this refactor migrates.
ALTER TABLE "Service"
  DROP COLUMN "name",
  DROP COLUMN "slug",
  DROP COLUMN "category",
  DROP COLUMN "description",
  DROP COLUMN "price";

-- productId/productHandle are backfilled by scripts/backfill-service-config.ts
-- by this point — safe to require them going forward.
ALTER TABLE "Service"
  ALTER COLUMN "productId" SET NOT NULL,
  ALTER COLUMN "productHandle" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Service_shop_productId_key" ON "Service"("shop", "productId");

-- CreateIndex
CREATE INDEX "Service_shop_productHandle_idx" ON "Service"("shop", "productHandle");
