ALTER TABLE "NotifyDockBackorderJob"
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "leaseUntil" TIMESTAMP(3);
