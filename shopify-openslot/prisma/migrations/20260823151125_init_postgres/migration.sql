-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopSettings" (
    "shop" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopSettings_pkey" PRIMARY KEY ("shop")
);

-- CreateTable
CREATE TABLE "Service" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
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
CREATE TABLE "Resource" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
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
    "serviceId" INTEGER NOT NULL,
    "addonId" INTEGER NOT NULL,

    CONSTRAINT "ServiceAddon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Schedule" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
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
CREATE INDEX "Service_shop_status_position_idx" ON "Service"("shop", "status", "position");

-- CreateIndex
CREATE INDEX "Service_shop_slug_idx" ON "Service"("shop", "slug");

-- CreateIndex
CREATE INDEX "Resource_shop_status_position_idx" ON "Resource"("shop", "status", "position");

-- CreateIndex
CREATE INDEX "ServiceResource_shop_resourceId_idx" ON "ServiceResource"("shop", "resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceResource_serviceId_resourceId_key" ON "ServiceResource"("serviceId", "resourceId");

-- CreateIndex
CREATE INDEX "Addon_shop_status_position_idx" ON "Addon"("shop", "status", "position");

-- CreateIndex
CREATE INDEX "ServiceAddon_shop_addonId_idx" ON "ServiceAddon"("shop", "addonId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceAddon_serviceId_addonId_key" ON "ServiceAddon"("serviceId", "addonId");

-- CreateIndex
CREATE INDEX "Schedule_shop_resourceId_dayOfWeek_idx" ON "Schedule"("shop", "resourceId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "TimeOff_shop_resourceId_startUtc_endUtc_idx" ON "TimeOff"("shop", "resourceId", "startUtc", "endUtc");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_shop_email_key" ON "Customer"("shop", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_uid_key" ON "Booking"("uid");

-- CreateIndex
CREATE INDEX "Booking_shop_resourceId_startUtc_status_idx" ON "Booking"("shop", "resourceId", "startUtc", "status");

-- CreateIndex
CREATE INDEX "Booking_shop_customerId_startUtc_idx" ON "Booking"("shop", "customerId", "startUtc");

-- CreateIndex
CREATE INDEX "Booking_shop_status_startUtc_idx" ON "Booking"("shop", "status", "startUtc");

-- CreateIndex
CREATE INDEX "Booking_shop_reminderSent_startUtc_idx" ON "Booking"("shop", "reminderSent", "startUtc");

-- CreateIndex
CREATE INDEX "Booking_shop_paymentStatus_idx" ON "Booking"("shop", "paymentStatus");

-- CreateIndex
CREATE INDEX "BookingAddon_shop_bookingId_idx" ON "BookingAddon"("shop", "bookingId");

-- CreateIndex
CREATE INDEX "Payment_shop_bookingId_idx" ON "Payment"("shop", "bookingId");

-- CreateIndex
CREATE INDEX "Payment_shop_status_idx" ON "Payment"("shop", "status");

-- CreateIndex
CREATE INDEX "Payment_shop_gateway_transactionId_idx" ON "Payment"("shop", "gateway", "transactionId");

-- CreateIndex
CREATE INDEX "Faq_shop_status_position_idx" ON "Faq"("shop", "status", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ChatConversation_uid_key" ON "ChatConversation"("uid");

-- CreateIndex
CREATE INDEX "ChatConversation_shop_status_updatedAt_idx" ON "ChatConversation"("shop", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "ChatMessage_conversationId_id_idx" ON "ChatMessage"("conversationId", "id");

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
