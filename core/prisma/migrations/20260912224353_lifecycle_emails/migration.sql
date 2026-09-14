-- CreateTable
CREATE TABLE "LifecycleEmail" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LifecycleEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LifecycleEmail_kind_idx" ON "LifecycleEmail"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "LifecycleEmail_connectionId_kind_key" ON "LifecycleEmail"("connectionId", "kind");

-- AddForeignKey
ALTER TABLE "LifecycleEmail" ADD CONSTRAINT "LifecycleEmail_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
