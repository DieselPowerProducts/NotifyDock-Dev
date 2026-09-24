CREATE TABLE "NotifyDockBackorderJob" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "previewPayload" JSONB,
    "sendPayload" JSONB,
    "attemptedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NotifyDockBackorderJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NotifyDockBackorderJob_shop_orderId_key" ON "NotifyDockBackorderJob"("shop", "orderId");
CREATE INDEX "NotifyDockBackorderJob_shop_status_nextAttemptAt_idx" ON "NotifyDockBackorderJob"("shop", "status", "nextAttemptAt");

CREATE TABLE "NotifyDockBackorderScan" (
    "shop" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "cursor" TEXT,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NotifyDockBackorderScan_pkey" PRIMARY KEY ("shop")
);
