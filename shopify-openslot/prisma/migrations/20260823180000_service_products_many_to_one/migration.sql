-- DropIndex
DROP INDEX "Service_shop_productId_key";

-- DropIndex
DROP INDEX "Service_shop_productHandle_key";

-- AlterTable
ALTER TABLE "Service" DROP COLUMN "productId",
DROP COLUMN "productHandle",
DROP COLUMN "productTitle",
DROP COLUMN "productImage";

-- CreateTable
CREATE TABLE "ServiceProduct" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "serviceId" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,
    "productHandle" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL DEFAULT '',
    "productImage" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "ServiceProduct_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceProduct_shop_productHandle_key" ON "ServiceProduct"("shop", "productHandle");

-- CreateIndex
CREATE INDEX "ServiceProduct_shop_serviceId_idx" ON "ServiceProduct"("shop", "serviceId");

-- AddForeignKey
ALTER TABLE "ServiceProduct" ADD CONSTRAINT "ServiceProduct_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
