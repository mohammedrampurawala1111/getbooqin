-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "taxCountry" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "taxId" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "taxStatus" TEXT NOT NULL DEFAULT '';
