-- Current private LAN endpoint is a machine-signed observation, not the
-- immutable BaseURL presentation captured during initial provisioning.
ALTER TABLE "HubInstallation"
  ADD COLUMN "lanEndpointRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lanEndpointReportedAt" TIMESTAMP(3),
  ADD COLUMN "lanEndpointState" VARCHAR(24) NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "lanEndpointIdentityGeneration" INTEGER;

ALTER TABLE "HubInstallation"
  ADD CONSTRAINT "HubInstallation_lanEndpointRevision_nonnegative"
    CHECK ("lanEndpointRevision" >= 0),
  ADD CONSTRAINT "HubInstallation_lanEndpointState_valid"
    CHECK ("lanEndpointState" IN ('UNKNOWN', 'CURRENT', 'UNAVAILABLE')),
  ADD CONSTRAINT "HubInstallation_lanEndpoint_state_coherent"
    CHECK (
      ("lanEndpointState" = 'UNKNOWN' AND "lanEndpointRevision" = 0 AND "lanEndpointReportedAt" IS NULL AND "lanEndpointIdentityGeneration" IS NULL)
      OR
      ("lanEndpointState" IN ('CURRENT', 'UNAVAILABLE') AND "lanEndpointRevision" > 0 AND "lanEndpointReportedAt" IS NOT NULL AND "lanEndpointIdentityGeneration" > 0
        AND ("lanEndpointState" <> 'CURRENT' OR "baseUrl" IS NOT NULL))
    );

CREATE INDEX "HubInstallation_lanEndpointState_lanEndpointReportedAt_idx"
  ON "HubInstallation"("lanEndpointState", "lanEndpointReportedAt");
