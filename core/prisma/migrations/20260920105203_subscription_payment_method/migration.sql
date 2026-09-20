-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "paymentMethodKind" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "paymentMethodLabel" TEXT NOT NULL DEFAULT '';
