CREATE TABLE "NotifyDockAutomationPolicy" (
  "shop" TEXT PRIMARY KEY,
  "startAt" TIMESTAMP(3) NOT NULL
);

-- The approved production boundary. Runtime settings cannot create or replace it.
INSERT INTO "NotifyDockAutomationPolicy" ("shop", "startAt")
VALUES ('fbgure-nn.myshopify.com', '2026-09-24 21:40:39.000');

CREATE FUNCTION notify_dock_protect_cutoff() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Notify Dock automation cutoffs are immutable. A deliberate migration is required.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notify_dock_immutable_cutoff
BEFORE UPDATE OR DELETE ON "NotifyDockAutomationPolicy"
FOR EACH ROW EXECUTE FUNCTION notify_dock_protect_cutoff();
