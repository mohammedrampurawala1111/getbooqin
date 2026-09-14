-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "billingAddress" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "billingName" TEXT NOT NULL DEFAULT '';
