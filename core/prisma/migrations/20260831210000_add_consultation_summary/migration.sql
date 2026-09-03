-- CreateTable
CREATE TABLE "ConsultationSummary" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'shopify',
    "bookingId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "transcriptText" TEXT NOT NULL,
    "transcriptSource" TEXT NOT NULL DEFAULT 'paste',
    "outputLanguage" TEXT NOT NULL,
    "detectedLanguage" TEXT,
    "draftJson" TEXT NOT NULL,
    "editedJson" TEXT NOT NULL,
    "reviewFlagsAcknowledged" TEXT NOT NULL DEFAULT '[]',
    "approvedByResourceId" INTEGER,
    "approvedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "revisionOfId" INTEGER,
    "retentionExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsultationSummary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConsultationSummary_platform_shop_bookingId_idx" ON "ConsultationSummary"("platform", "shop", "bookingId");

-- CreateIndex
CREATE INDEX "ConsultationSummary_platform_shop_status_idx" ON "ConsultationSummary"("platform", "shop", "status");

-- CreateIndex
CREATE INDEX "ConsultationSummary_platform_shop_revisionOfId_idx" ON "ConsultationSummary"("platform", "shop", "revisionOfId");

-- AddForeignKey
ALTER TABLE "ConsultationSummary" ADD CONSTRAINT "ConsultationSummary_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsultationSummary" ADD CONSTRAINT "ConsultationSummary_revisionOfId_fkey" FOREIGN KEY ("revisionOfId") REFERENCES "ConsultationSummary"("id") ON DELETE SET NULL ON UPDATE CASCADE;
