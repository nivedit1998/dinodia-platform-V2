-- R3 remediation: persist the installation-specific tunnel-name reservation
-- before Cloudflare creates the tunnel. The existing tunnel id is learned
-- only after the hub returns the signed, independently verified report.
ALTER TABLE "HubInstallation"
  ADD COLUMN "reservedTunnelName" VARCHAR(200);

CREATE INDEX "HubInstallation_reservedTunnelName_idx"
  ON "HubInstallation"("reservedTunnelName");

ALTER TABLE "SupportAccessRequest"
  ADD COLUMN "employeeHandoffHash" VARCHAR(128),
  ADD COLUMN "employeeHandoffIssuedAt" TIMESTAMP(3),
  ADD COLUMN "employeeHandoffExpiresAt" TIMESTAMP(3),
  ADD COLUMN "employeeHandoffConsumedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "SupportAccessRequest_employeeHandoffHash_key"
  ON "SupportAccessRequest"("employeeHandoffHash")
  WHERE "employeeHandoffHash" IS NOT NULL;

CREATE TABLE "AuthRateLimitBucket" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "bucketKey" VARCHAR(160) NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "blockedUntil" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuthRateLimitBucket_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AuthRateLimitBucket_bucketKey_key" ON "AuthRateLimitBucket"("bucketKey");
CREATE INDEX "AuthRateLimitBucket_blockedUntil_idx" ON "AuthRateLimitBucket"("blockedUntil");

CREATE TABLE "InitialCxoBootstrap" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "ceremonyKey" VARCHAR(80) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InitialCxoBootstrap_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InitialCxoBootstrap_ceremonyKey_key" ON "InitialCxoBootstrap"("ceremonyKey");

-- Support leases retain the approved tenant membership identity.  This keeps
-- private tenant-device filtering membership-scoped on the hub and avoids
-- falling back to legacy account ownership identifiers.
ALTER TABLE "SupportSession"
  ADD COLUMN "targetMembershipId" UUID;

CREATE INDEX "SupportSession_targetMembershipId_idx"
  ON "SupportSession"("targetMembershipId");
