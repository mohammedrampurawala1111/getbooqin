-- Step 1 of 2 (Prompt 3 catalog refactor): additive only. Adds ProductCache
-- and the new ServiceConfig columns as nullable, alongside the still-present
-- legacy Service catalog columns (name/slug/category/description/price/color)
-- and the ServiceProduct table. Run scripts/backfill-service-config.ts after
-- this migration and before the follow-up destructive migration that drops
-- the legacy columns/table and tightens productId/productHandle to NOT NULL.

-- CreateTable
CREATE TABLE "ProductCache" (
    "id"            SERIAL NOT NULL,
    "shop"          TEXT NOT NULL,
    "platform"      TEXT NOT NULL DEFAULT 'shopify',
    "productId"     TEXT NOT NULL,
    "productHandle" TEXT NOT NULL,
    "title"         TEXT NOT NULL DEFAULT '',
    "description"   TEXT NOT NULL DEFAULT '',
    "category"      TEXT NOT NULL DEFAULT '',
    "image"         TEXT NOT NULL DEFAULT '',
    "price"         DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductCache_shop_platform_productId_key" ON "ProductCache"("shop", "platform", "productId");

-- CreateIndex
CREATE INDEX "ProductCache_shop_productHandle_idx" ON "ProductCache"("shop", "productHandle");

-- AlterTable: new columns nullable for now — backfill populates productId/
-- productHandle for every existing row before the follow-up migration makes
-- them required.
ALTER TABLE "Service"
  ADD COLUMN "platform"          TEXT NOT NULL DEFAULT 'shopify',
  ADD COLUMN "productId"         TEXT,
  ADD COLUMN "productHandle"     TEXT,
  ADD COLUMN "platformUpdatedAt" TIMESTAMP(3);

-- The generated Prisma client no longer declares `name` (ServiceConfig has
-- no catalog fields), so any row it creates from here on won't supply one —
-- including new rows scripts/backfill-service-config.ts creates for a
-- Service that had more than one linked product. Relax the legacy NOT NULL
-- constraint now so those inserts don't fail; the column itself is dropped
-- in the follow-up migration regardless.
ALTER TABLE "Service" ALTER COLUMN "name" DROP NOT NULL;
