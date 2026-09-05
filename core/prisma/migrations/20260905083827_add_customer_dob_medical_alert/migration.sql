-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "dateOfBirth" TEXT,
ADD COLUMN     "medicalAlert" TEXT NOT NULL DEFAULT '';
