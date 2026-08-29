-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "productId" TEXT,
ADD COLUMN     "productTitle" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "productImage" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE UNIQUE INDEX "Service_shop_productId_key" ON "Service"("shop", "productId");
