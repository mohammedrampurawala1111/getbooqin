/*
  Warnings:

  - You are about to drop the `Service` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ServiceProduct` table. If the table is not empty, all the data it contains will be lost.

  Prompt 4 catalog catch-up: this assumes `Service`/`ServiceProduct`/`Booking`
  in this environment's `getbooqin_core` database are still empty (the
  standalone dashboard has only ever been a placeholder, so nothing has
  written booking data here yet). Confirm row counts are zero in whatever
  environment you're applying this to before running it — if real rows
  exist, do NOT run this as-is; write a Prompt-3-style additive-then-
  backfill-then-destructive migration instead.
*/
-- DropForeignKey
ALTER TABLE "Booking" DROP CONSTRAINT "Booking_serviceId_fkey";

-- DropForeignKey
ALTER TABLE "ServiceAddon" DROP CONSTRAINT "ServiceAddon_serviceId_fkey";

-- DropForeignKey
ALTER TABLE "ServiceProduct" DROP CONSTRAINT "ServiceProduct_serviceId_fkey";

-- DropForeignKey
ALTER TABLE "ServiceResource" DROP CONSTRAINT "ServiceResource_serviceId_fkey";

-- DropTable
DROP TABLE "Service";

-- DropTable
DROP TABLE "ServiceProduct";

-- CreateTable
CREATE TABLE "ServiceConfig" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'shopify',
    "productId" TEXT NOT NULL,
    "productHandle" TEXT NOT NULL,
    "durationMin" INTEGER NOT NULL DEFAULT 30,
    "bufferBeforeMin" INTEGER NOT NULL DEFAULT 0,
    "bufferAfterMin" INTEGER NOT NULL DEFAULT 0,
    "capacity" INTEGER NOT NULL DEFAULT 1,
    "locationType" TEXT NOT NULL DEFAULT 'onsite',
    "paymentRequired" BOOLEAN NOT NULL DEFAULT false,
    "depositPercent" INTEGER NOT NULL DEFAULT 100,
    "color" TEXT NOT NULL DEFAULT '#2563eb',
    "position" INTEGER NOT NULL DEFAULT 0,
    "status" BOOLEAN NOT NULL DEFAULT true,
    "platformUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductCache" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'shopify',
    "productId" TEXT NOT NULL,
    "productHandle" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT '',
    "image" TEXT NOT NULL DEFAULT '',
    "price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServiceConfig_platform_shop_status_position_idx" ON "ServiceConfig"("platform", "shop", "status", "position");

-- CreateIndex
CREATE INDEX "ServiceConfig_platform_shop_productHandle_idx" ON "ServiceConfig"("platform", "shop", "productHandle");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceConfig_platform_shop_productId_key" ON "ServiceConfig"("platform", "shop", "productId");

-- CreateIndex
CREATE INDEX "ProductCache_platform_shop_productHandle_idx" ON "ProductCache"("platform", "shop", "productHandle");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCache_platform_shop_productId_key" ON "ProductCache"("platform", "shop", "productId");

-- AddForeignKey
ALTER TABLE "ServiceResource" ADD CONSTRAINT "ServiceResource_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "ServiceConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAddon" ADD CONSTRAINT "ServiceAddon_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "ServiceConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "ServiceConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
