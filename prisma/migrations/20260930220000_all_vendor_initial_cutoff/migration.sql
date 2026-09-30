-- Separate new initial notices from follow-ups enrolled under the original policy.
-- All-vendor initial rollout: September 30, 2026, 3:30 p.m. America/Los_Angeles.
-- Preserve the original cutoff and re-lock both cutoffs in the same transaction.
BEGIN;
ALTER TABLE "NotifyDockAutomationPolicy" ADD COLUMN IF NOT EXISTS "initialStartAt" TIMESTAMP(3);
DROP TRIGGER notify_dock_immutable_cutoff ON "NotifyDockAutomationPolicy";
UPDATE "NotifyDockAutomationPolicy"
SET "initialStartAt" = GREATEST("startAt", TIMESTAMP '2026-09-30 22:30:00')
WHERE "initialStartAt" IS NULL;
CREATE TRIGGER notify_dock_immutable_cutoff
BEFORE UPDATE OR DELETE ON "NotifyDockAutomationPolicy"
FOR EACH ROW EXECUTE FUNCTION notify_dock_protect_cutoff();
COMMIT;
