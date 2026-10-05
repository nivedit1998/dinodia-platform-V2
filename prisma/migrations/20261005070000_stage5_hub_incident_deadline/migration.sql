-- Hub/integration incidents have a seven-minute qualification deadline;
-- device incidents retain the existing sixty-minute deadline. This updates
-- only the database invariant and does not rewrite or delete incident rows.
ALTER TABLE "NativeDeviceOutageIncident"
  DROP CONSTRAINT "NativeOutage_deadline_check";

ALTER TABLE "NativeDeviceOutageIncident"
  ADD CONSTRAINT "NativeOutage_deadline_check"
  CHECK (
    ("deviceId" IS NOT NULL
      AND "alertEligibleAt" = "offlineObservedAt" + INTERVAL '60 minutes')
    OR
    ("deviceId" IS NULL AND "hubInstallationId" IS NOT NULL
      AND "alertEligibleAt" IN (
        "offlineObservedAt" + INTERVAL '7 minutes',
        "offlineObservedAt" + INTERVAL '60 minutes'
      ))
  );
