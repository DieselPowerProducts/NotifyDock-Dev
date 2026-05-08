ALTER TABLE "NotifyDockEmailHistory"
ADD COLUMN "requestEventUniqueId" TEXT,
ADD COLUMN "deliveryStatus" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN "deliveryStatusReason" TEXT,
ADD COLUMN "deliveryEventId" TEXT,
ADD COLUMN "deliveryStatusAt" TIMESTAMP(3),
ADD COLUMN "deliveryCheckedAt" TIMESTAMP(3);

CREATE INDEX "NotifyDockEmailHistory_shop_deliveryStatus_sentAt_idx"
ON "NotifyDockEmailHistory"("shop", "deliveryStatus", "sentAt" DESC);
