-- Keep one active true hub outage per enrolled hub while allowing distinct,
-- opaque integration outage incidents to be durably synchronized independently.
-- Existing rows are conservatively classified as hub_unknown so an existing
-- open hub incident continues to hold the one-hub-outage slot until a current
-- signed source transition identifies it more precisely. Integration outages
-- remain subject to the frozen bounded seven-minute cloud qualification rule.
ALTER TABLE "NativeDeviceOutageIncident"
  ADD COLUMN "sourceKind" VARCHAR(80) NOT NULL DEFAULT 'hub_unknown';

DROP INDEX IF EXISTS "NativeOutage_one_open_hub_idx";
CREATE UNIQUE INDEX "NativeOutage_one_open_hub_idx"
  ON "NativeDeviceOutageIncident" ("hubInstallationId")
  WHERE "hubInstallationId" IS NOT NULL
    AND "state" = 'OPEN'
    AND left("sourceKind", 4) = 'hub_';

ALTER TABLE "NativeDeviceOutageIncident"
  ADD CONSTRAINT "NativeDeviceOutageIncident_source_kind_check"
  CHECK ("sourceKind" ~ '^[a-z0-9_:-]{1,80}$');
