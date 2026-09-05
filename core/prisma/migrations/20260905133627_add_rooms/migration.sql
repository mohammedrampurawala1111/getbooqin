-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "roomId" INTEGER;

-- AlterTable
ALTER TABLE "Resource" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'practitioner';

-- AlterTable
ALTER TABLE "ServiceConfig" ADD COLUMN     "requiresRoom" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Booking_platform_shop_roomId_startUtc_status_idx" ON "Booking"("platform", "shop", "roomId", "startUtc", "status");

-- CreateIndex
CREATE INDEX "Resource_platform_shop_kind_status_position_idx" ON "Resource"("platform", "shop", "kind", "status", "position");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Resource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
