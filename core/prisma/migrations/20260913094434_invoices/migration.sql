-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "series" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sellerName" TEXT NOT NULL,
    "sellerAddress" TEXT NOT NULL,
    "sellerGstin" TEXT NOT NULL DEFAULT '',
    "sellerCountry" TEXT NOT NULL DEFAULT 'IN',
    "buyerName" TEXT NOT NULL,
    "buyerEmail" TEXT NOT NULL,
    "buyerTaxId" TEXT NOT NULL DEFAULT '',
    "buyerCountry" TEXT NOT NULL DEFAULT '',
    "taxStatus" TEXT NOT NULL,
    "taxNote" TEXT NOT NULL DEFAULT '',
    "currency" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "taxAmountMinor" INTEGER NOT NULL DEFAULT 0,
    "planId" TEXT NOT NULL,
    "billingCycle" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "provider" TEXT NOT NULL,
    "providerPaymentId" TEXT,
    "providerInvoiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceCounter" (
    "series" TEXT NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceCounter_pkey" PRIMARY KEY ("series")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_providerPaymentId_key" ON "Invoice"("providerPaymentId");

-- CreateIndex
CREATE INDEX "Invoice_connectionId_issuedAt_idx" ON "Invoice"("connectionId", "issuedAt");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
