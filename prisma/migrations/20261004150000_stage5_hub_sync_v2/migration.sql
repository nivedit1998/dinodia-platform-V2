-- Stage 5: one bounded durable sync cursor and short-lived exact response receipts per enrolled hub.
ALTER TYPE "NativeAutomationExecutionStatus" ADD VALUE IF NOT EXISTS 'INTERRUPTED';

ALTER TABLE "HubInstallation"
  ADD COLUMN "syncStreamId" VARCHAR(80),
  ADD COLUMN "syncAcceptedSequence" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "acknowledgedCloudRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cloudConfigurationRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cloudConfigurationChecksum" VARCHAR(64),
  ADD COLUMN "lastSuccessfulSyncAt" TIMESTAMP(3),
  ADD COLUMN "lastQueueDepth" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastSyncErrorCode" VARCHAR(80),
  ADD COLUMN "syncGapDetected" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "syncCriticalBacklog" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "syncTelemetryPaused" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "syncDroppedTelemetryCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "HubInstallation"
  ADD CONSTRAINT "HubInstallation_sync_bounds_check"
  CHECK ("syncAcceptedSequence" >= 0 AND "acknowledgedCloudRevision" >= 0 AND "cloudConfigurationRevision" >= 0 AND "lastQueueDepth" BETWEEN 0 AND 100000 AND "syncDroppedTelemetryCount" >= 0);

ALTER TABLE "HubInstallation"
  ADD COLUMN "updateStatusRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "updaterTrustState" VARCHAR(20) NOT NULL DEFAULT 'UNAVAILABLE',
  ADD COLUMN "updatePhase" VARCHAR(32) NOT NULL DEFAULT 'unavailable',
  ADD COLUMN "updateAttemptId" VARCHAR(96),
  ADD COLUMN "updateReleaseId" VARCHAR(96),
  ADD COLUMN "activeReleaseVersion" VARCHAR(96),
  ADD COLUMN "updateResultCode" VARCHAR(96),
  ADD COLUMN "updateStatusAt" TIMESTAMP(3),
  ADD COLUMN "updateBusy" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT "HubInstallation_update_status_check" CHECK (
    "updateStatusRevision" >= 0
    AND "updaterTrustState" IN ('READY', 'UNPROVISIONED', 'UNAVAILABLE')
    AND "updatePhase" IN ('idle', 'downloading', 'verifying', 'staged', 'maintenance', 'activating', 'health_check', 'active', 'failed', 'rolled_back', 'unavailable')
  );

CREATE TABLE "HubSyncReceipt" (
  "id" UUID NOT NULL,
  "hubInstallationId" UUID NOT NULL,
  "streamId" VARCHAR(80) NOT NULL,
  "fromSequence" BIGINT NOT NULL,
  "toSequence" BIGINT NOT NULL,
  "bodyHash" VARCHAR(64) NOT NULL,
  "response" JSONB NOT NULL,
  "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HubSyncReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HubSyncReceipt_sequence_check" CHECK ("fromSequence" > 0 AND "toSequence" >= "fromSequence"),
  CONSTRAINT "HubSyncReceipt_body_hash_check" CHECK ("bodyHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "HubSyncReceipt_hubInstallationId_fkey" FOREIGN KEY ("hubInstallationId")
    REFERENCES "HubInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "HubSyncReceipt_exact_range_body_key"
  ON "HubSyncReceipt"("hubInstallationId", "streamId", "fromSequence", "toSequence", "bodyHash");
-- The second key makes a different body for an already accepted range an atomic conflict,
-- including when two conflicting signed requests race.
CREATE UNIQUE INDEX "HubSyncReceipt_one_body_per_range_key"
  ON "HubSyncReceipt"("hubInstallationId", "streamId", "fromSequence", "toSequence");
CREATE INDEX "HubSyncReceipt_expiresAt_idx" ON "HubSyncReceipt"("expiresAt");
CREATE INDEX "HubSyncReceipt_hubInstallationId_acceptedAt_idx" ON "HubSyncReceipt"("hubInstallationId", "acceptedAt");

-- Incident transitions are idempotent by stable OS incident key and monotonic
-- revision; event IDs independently prevent reusing an accepted source event.
ALTER TABLE "NativeDeviceOutageIncident"
  ADD COLUMN "sourceIncidentKey" VARCHAR(64),
  ADD COLUMN "sourceRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "sourceEventId" UUID;
CREATE UNIQUE INDEX "NativeDeviceOutageIncident_sourceEventId_key"
  ON "NativeDeviceOutageIncident"("sourceEventId");
CREATE UNIQUE INDEX "NativeDeviceOutageIncident_hub_source_key"
  ON "NativeDeviceOutageIncident"("hubInstallationId", "sourceIncidentKey");
ALTER TABLE "NativeDeviceOutageIncident"
  ADD CONSTRAINT "NativeDeviceOutageIncident_source_bounds_check"
  CHECK ("sourceRevision" >= 0 AND ("sourceIncidentKey" IS NULL OR "sourceIncidentKey" ~ '^[a-f0-9]{64}$'));

-- Stable source identity makes temperature observations idempotent even if an
-- OS stream is explicitly reconciled after receipt retention expires.
ALTER TABLE "NativeTemperatureSample"
  ADD COLUMN "sourceEventKey" VARCHAR(64),
  ADD COLUMN "validUntil" TIMESTAMP(3);
UPDATE "NativeTemperatureSample"
  SET "validUntil" = LEAST("sourceObservedAt" + INTERVAL '30 minutes', "purgeAt")
  WHERE "validUntil" IS NULL;
ALTER TABLE "NativeTemperatureSample"
  ALTER COLUMN "validUntil" SET NOT NULL;
CREATE UNIQUE INDEX "NativeTemperatureSample_sourceEventKey_key"
  ON "NativeTemperatureSample"("sourceEventKey");
ALTER TABLE "NativeTemperatureSample"
  ADD CONSTRAINT "NativeTemperatureSample_source_event_key_check"
  CHECK ("sourceEventKey" IS NULL OR "sourceEventKey" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "NativeTemperatureSample_valid_until_check"
  CHECK ("validUntil" > "sourceObservedAt" AND "validUntil" <= "sourceObservedAt" + INTERVAL '30 minutes');
