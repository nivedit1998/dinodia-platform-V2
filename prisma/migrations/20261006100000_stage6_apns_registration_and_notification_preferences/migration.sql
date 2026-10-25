-- Extend the existing membership-preference authority and attach an encrypted
-- V2 APNs registration to the current TrustedDevice row. No push token is
-- copied into a new account or notification authority.
ALTER TYPE "MemberPreferenceKind" ADD VALUE IF NOT EXISTS 'NOTIFICATION_PREFERENCES';
ALTER TYPE "MemberPreferenceKind" ADD VALUE IF NOT EXISTS 'MANAGER_NOTIFICATION_ASSIGNMENT';

ALTER TABLE "TrustedDevice" ADD COLUMN "apnsTokenDigest" VARCHAR(64);
CREATE UNIQUE INDEX "TrustedDevice_apnsTokenDigest_key"
  ON "TrustedDevice"("apnsTokenDigest");
