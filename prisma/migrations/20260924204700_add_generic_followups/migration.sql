-- CreateTable
CREATE TABLE "NotifyDockFollowupItem" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lineItemId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "initialHistoryId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "nextCheckAt" TIMESTAMP(3) NOT NULL,
    "batchId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotifyDockFollowupItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotifyDockFollowupBatch" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotifyDockFollowupBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotifyDockFollowupLease" (
    "shop" TEXT NOT NULL,
    "leaseUntil" TIMESTAMP(3),
    "token" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "NotifyDockFollowupLease_pkey" PRIMARY KEY ("shop")
);

-- CreateIndex
CREATE INDEX "NotifyDockFollowupItem_shop_status_nextCheckAt_idx" ON "NotifyDockFollowupItem"("shop", "status", "nextCheckAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotifyDockFollowupItem_shop_orderId_lineItemId_key" ON "NotifyDockFollowupItem"("shop", "orderId", "lineItemId");

-- CreateIndex
CREATE INDEX "NotifyDockFollowupBatch_shop_status_nextAttemptAt_idx" ON "NotifyDockFollowupBatch"("shop", "status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "NotifyDockFollowupItem" ADD CONSTRAINT "NotifyDockFollowupItem_initialHistoryId_fkey" FOREIGN KEY ("initialHistoryId") REFERENCES "NotifyDockEmailHistory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
