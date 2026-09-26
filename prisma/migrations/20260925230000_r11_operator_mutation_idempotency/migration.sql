-- Operator rotate/revoke retries must replay the original safe result. This
-- stores response metadata only; no credential, envelope or bearer material.
ALTER TABLE "IdempotencyRecord"
ADD COLUMN "responseBody" JSONB;

ALTER TABLE "AuthRateLimitBucket"
ADD COLUMN "attemptTimestamps" JSONB;

ALTER TABLE "IdempotencyRecord"
ADD COLUMN "hubInstallationId" UUID;

CREATE INDEX "IdempotencyRecord_hubInstallationId_expiresAt_idx"
ON "IdempotencyRecord"("hubInstallationId", "expiresAt");

ALTER TABLE "IdempotencyRecord"
ADD CONSTRAINT "IdempotencyRecord_hubInstallationId_fkey"
FOREIGN KEY ("hubInstallationId") REFERENCES "HubInstallation"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
