-- Add a rolling refresh-token family and an immutable account-session ceiling.
-- Existing sessions receive a private one-row family and a deadline based on
-- their original issue time; no session is extended by this migration.
ALTER TABLE "CustomerSession"
  ADD COLUMN "sessionFamilyId" UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN "absoluteExpiresAt" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '180 days');

UPDATE "CustomerSession"
SET "sessionFamilyId" = "id",
    "absoluteExpiresAt" = "issuedAt" + INTERVAL '180 days';

CREATE INDEX "CustomerSession_sessionFamilyId_revokedAt_idx"
  ON "CustomerSession"("sessionFamilyId", "revokedAt");

ALTER TABLE "CustomerSession"
  ADD CONSTRAINT "CustomerSession_absolute_expiry_after_issue_check"
  CHECK ("absoluteExpiresAt" > "issuedAt");

ALTER TABLE "CustomerSession"
  ADD CONSTRAINT "CustomerSession_idle_expiry_before_absolute_check"
  CHECK ("expiresAt" <= "absoluteExpiresAt");

ALTER TABLE "AuthChallenge"
  ADD COLUMN "deliveryStatus" VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "deliveryAttemptedAt" TIMESTAMP(3) WITH TIME ZONE;

ALTER TABLE "AuthChallenge"
  ADD CONSTRAINT "AuthChallenge_delivery_status_check"
  CHECK ("deliveryStatus" IN ('PENDING', 'ACCEPTED', 'FAILED'));

-- A Trusted Device removal is an account-global operation, not a selected
-- home's device command. Its short-lived operation-bound proof is bound to
-- the account session/device with these three scope columns NULL.
ALTER TABLE "StepUpChallenge"
  ALTER COLUMN "homeId" DROP NOT NULL,
  ALTER COLUMN "membershipId" DROP NOT NULL,
  ALTER COLUMN "hubInstallationId" DROP NOT NULL;
