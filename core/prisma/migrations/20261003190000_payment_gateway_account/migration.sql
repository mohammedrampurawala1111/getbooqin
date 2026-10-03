-- CreateTable
CREATE TABLE "PaymentGatewayAccount" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'razorpay',
    "accountId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL DEFAULT '',
    "tokenExpiresAt" TIMESTAMP(3),
    "webhookId" TEXT NOT NULL DEFAULT '',
    "webhookSecret" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lastError" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentGatewayAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentGatewayAccount_connectionId_key" ON "PaymentGatewayAccount"("connectionId");

-- CreateIndex
CREATE INDEX "PaymentGatewayAccount_accountId_idx" ON "PaymentGatewayAccount"("accountId");

-- AddForeignKey
ALTER TABLE "PaymentGatewayAccount" ADD CONSTRAINT "PaymentGatewayAccount_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
