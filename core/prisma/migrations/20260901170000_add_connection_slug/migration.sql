-- AlterTable
ALTER TABLE "Connection" ADD COLUMN "slug" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Connection_slug_key" ON "Connection"("slug");
