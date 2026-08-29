-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Connection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'shopify',
    "shop" TEXT NOT NULL,
    "credentials" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopSettings" (
    "shop" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'shopify',
    "data" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopSettings_pkey" PRIMARY KEY ("platform","shop")
);

-- CreateTable
CREATE TABLE "Service" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'shopify',
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT '',
    "description" TEXT,
    "durationMin" INTEGER NOT NULL DEFAULT 30,
    "bufferBeforeMin" INTEGER NOT NULL DEFAULT 0,
    "bufferAfterMin" INTEGER NOT NULL DEFAULT 0,
    "capacity" INTEGER NOT NULL DEFAULT 1,
    "price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "locationType" TEXT NOT NULL DEFAULT 'onsite',
    "paymentRequired" BOOLEAN NOT NULL DEFAULT false,
    "depositPercent" INTEGER NOT NULL DEFAULT 100,
    "color" TEXT NOT NULL DEFAULT '#2563eb',
    "position" INTEGER NOT NULL DEFAULT 0,
    "status" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceProduct" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'shopify',
    "serviceId" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,
    "productHandle" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL DEFAULT '',
    "productImage" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "ServiceProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Resource" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'shopify',
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "description" TEXT,
    "avatarUrl" TEXT NOT NULL DEFAULT '',
    "meetingLink" TEXT NOT NULL DEFAULT '',
    "timezone" TEXT NOT NULL DEFAULT '',
    "position" INTEGER NOT NULL DEFAULT 0,
    "status" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceResource" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'shopify',
    "serviceId" INTEGER NOT NULL,
    "resourceId" INTEGER NOT NULL,
    "priceOverride" DOUBLE PRECISION,
    "durationOverride" INTEGER,

    CONSTRAINT "ServiceResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Addon" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'shopify',
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "durationMin" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,
    "status" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Addon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceAddon" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'shopify',
    "serviceId" INTEGER NOT NULL,
    "addonId" INTEGER NOT NULL,

    CONSTRAINT "ServiceAddon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Schedule" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'shopify',
    "resourceId" INTEGER NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,

    CONSTRAINT "Schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeOff" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'shopify',
    "resourceId" INTEGER NOT NULL DEFAULT 0,
    "startUtc" TIMESTAMP(3) NOT NULL,
    "endUtc" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimeOff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'shopify',
    "firstName" TEXT NOT NULL DEFAULT '',
    "lastName" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL DEFAULT '',
    "timezone" TEXT NOT NULL DEFAULT '',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'shopify',
    "uid" TEXT NOT NULL,
    "serviceId" INTEGER NOT NULL,
    "resourceId" INTEGER NOT NULL,
    "customerId" INTEGER NOT NULL,
    "startUtc" TIMESTAMP(3) NOT NULL,
    "endUtc" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "amountDue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "paymentStatus" TEXT NOT NULL DEFAULT 'not_required',
    "meetingProvider" TEXT NOT NULL DEFAULT '',
    "meetingUrl" TEXT NOT NULL DEFAULT '',
    "meetingId" TEXT NOT NULL DEFAULT '',
    "notes" TEXT,
    "customFields" TEXT,
    "source" TEXT NOT NULL DEFAULT 'form',
    "reminderSent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingAddon" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'shopify',
    "bookingId" INTEGER NOT NULL,
    "addonId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "durationMin" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BookingAddon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'shopify',
    "bookingId" INTEGER NOT NULL,
    "gateway" TEXT NOT NULL DEFAULT '',
    "transactionId" TEXT NOT NULL DEFAULT '',
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "payload" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Faq" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'shopify',
    "question" TEXT NOT NULL,
    "answer" TEXT,
    "keywords" TEXT NOT NULL DEFAULT '',
    "position" INTEGER NOT NULL DEFAULT 0,
    "status" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Faq_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatConversation" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'shopify',
    "uid" TEXT NOT NULL,
    "visitorName" TEXT NOT NULL DEFAULT '',
    "visitorEmail" TEXT NOT NULL DEFAULT '',
    "visitorPhone" TEXT NOT NULL DEFAULT '',
    "state" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "bookingId" INTEGER NOT NULL DEFAULT 0,
    "pageUrl" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" SERIAL NOT NULL,
    "conversationId" INTEGER NOT NULL,
    "sender" TEXT NOT NULL DEFAULT 'bot',
    "body" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Connection_userId_idx" ON "Connection"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Connection_platform_shop_key" ON "Connection"("platform", "shop");

-- CreateIndex
CREATE INDEX "Service_platform_shop_status_position_idx" ON "Service"("platform", "shop", "status", "position");

-- CreateIndex
CREATE INDEX "Service_platform_shop_slug_idx" ON "Service"("platform", "shop", "slug");

-- CreateIndex
CREATE INDEX "ServiceProduct_platform_shop_serviceId_idx" ON "ServiceProduct"("platform", "shop", "serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceProduct_platform_shop_productHandle_key" ON "ServiceProduct"("platform", "shop", "productHandle");

-- CreateIndex
CREATE INDEX "Resource_platform_shop_status_position_idx" ON "Resource"("platform", "shop", "status", "position");

-- CreateIndex
CREATE INDEX "ServiceResource_platform_shop_resourceId_idx" ON "ServiceResource"("platform", "shop", "resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceResource_serviceId_resourceId_key" ON "ServiceResource"("serviceId", "resourceId");

-- CreateIndex
CREATE INDEX "Addon_platform_shop_status_position_idx" ON "Addon"("platform", "shop", "status", "position");

-- CreateIndex
CREATE INDEX "ServiceAddon_platform_shop_addonId_idx" ON "ServiceAddon"("platform", "shop", "addonId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceAddon_serviceId_addonId_key" ON "ServiceAddon"("serviceId", "addonId");

-- CreateIndex
CREATE INDEX "Schedule_platform_shop_resourceId_dayOfWeek_idx" ON "Schedule"("platform", "shop", "resourceId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "TimeOff_platform_shop_resourceId_startUtc_endUtc_idx" ON "TimeOff"("platform", "shop", "resourceId", "startUtc", "endUtc");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_platform_shop_email_key" ON "Customer"("platform", "shop", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_uid_key" ON "Booking"("uid");

-- CreateIndex
CREATE INDEX "Booking_platform_shop_resourceId_startUtc_status_idx" ON "Booking"("platform", "shop", "resourceId", "startUtc", "status");

-- CreateIndex
CREATE INDEX "Booking_platform_shop_customerId_startUtc_idx" ON "Booking"("platform", "shop", "customerId", "startUtc");

-- CreateIndex
CREATE INDEX "Booking_platform_shop_status_startUtc_idx" ON "Booking"("platform", "shop", "status", "startUtc");

-- CreateIndex
CREATE INDEX "Booking_platform_shop_reminderSent_startUtc_idx" ON "Booking"("platform", "shop", "reminderSent", "startUtc");

-- CreateIndex
CREATE INDEX "Booking_platform_shop_paymentStatus_idx" ON "Booking"("platform", "shop", "paymentStatus");

-- CreateIndex
CREATE INDEX "BookingAddon_platform_shop_bookingId_idx" ON "BookingAddon"("platform", "shop", "bookingId");

-- CreateIndex
CREATE INDEX "Payment_platform_shop_bookingId_idx" ON "Payment"("platform", "shop", "bookingId");

-- CreateIndex
CREATE INDEX "Payment_platform_shop_status_idx" ON "Payment"("platform", "shop", "status");

-- CreateIndex
CREATE INDEX "Payment_platform_shop_gateway_transactionId_idx" ON "Payment"("platform", "shop", "gateway", "transactionId");

-- CreateIndex
CREATE INDEX "Faq_platform_shop_status_position_idx" ON "Faq"("platform", "shop", "status", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ChatConversation_uid_key" ON "ChatConversation"("uid");

-- CreateIndex
CREATE INDEX "ChatConversation_platform_shop_status_updatedAt_idx" ON "ChatConversation"("platform", "shop", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "ChatMessage_conversationId_id_idx" ON "ChatMessage"("conversationId", "id");

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceProduct" ADD CONSTRAINT "ServiceProduct_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceResource" ADD CONSTRAINT "ServiceResource_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceResource" ADD CONSTRAINT "ServiceResource_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAddon" ADD CONSTRAINT "ServiceAddon_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAddon" ADD CONSTRAINT "ServiceAddon_addonId_fkey" FOREIGN KEY ("addonId") REFERENCES "Addon"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingAddon" ADD CONSTRAINT "BookingAddon_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingAddon" ADD CONSTRAINT "BookingAddon_addonId_fkey" FOREIGN KEY ("addonId") REFERENCES "Addon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
