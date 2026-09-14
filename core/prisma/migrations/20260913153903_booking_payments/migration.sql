-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "confirmedByUserId" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'deposit',
ADD COLUMN     "link" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "method" TEXT NOT NULL DEFAULT 'upi',
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "reference" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "utr" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "ServiceConfig" ADD COLUMN     "depositAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;
