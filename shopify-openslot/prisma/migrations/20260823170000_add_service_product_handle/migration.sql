-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "productHandle" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Service_shop_productHandle_key" ON "Service"("shop", "productHandle");
