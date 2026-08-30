-- CreateTable
CREATE TABLE "Waitlist" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'shopify',
    "uid" TEXT NOT NULL,
    "serviceId" INTEGER NOT NULL,
    "resourceId" INTEGER NOT NULL DEFAULT 0,
    "customerId" INTEGER NOT NULL,
    "windowStartUtc" TIMESTAMP(3) NOT NULL,
    "windowEndUtc" TIMESTAMP(3),
    "notes" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "offerToken" TEXT,
    "offeredResourceId" INTEGER,
    "offeredStartUtc" TIMESTAMP(3),
    "offeredEndUtc" TIMESTAMP(3),
    "offerExpiresAt" TIMESTAMP(3),
    "offerCount" INTEGER NOT NULL DEFAULT 0,
    "resultingBookingId" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Waitlist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Waitlist_uid_key" ON "Waitlist"("uid");

-- CreateIndex
CREATE UNIQUE INDEX "Waitlist_offerToken_key" ON "Waitlist"("offerToken");

-- CreateIndex
CREATE INDEX "Waitlist_platform_shop_serviceId_resourceId_status_createdA_idx" ON "Waitlist"("platform", "shop", "serviceId", "resourceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Waitlist_platform_shop_status_offerExpiresAt_idx" ON "Waitlist"("platform", "shop", "status", "offerExpiresAt");

-- CreateIndex
CREATE INDEX "Waitlist_platform_shop_customerId_status_idx" ON "Waitlist"("platform", "shop", "customerId", "status");

-- AddForeignKey
ALTER TABLE "Waitlist" ADD CONSTRAINT "Waitlist_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "ServiceConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Waitlist" ADD CONSTRAINT "Waitlist_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
