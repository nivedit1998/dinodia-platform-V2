-- Add short-lived app access credentials while retaining the existing
-- CustomerSession refresh-token family as the sole account/session authority.
-- Existing browser sessions remain cookie-authenticated and receive no access
-- credential from this additive migration.
ALTER TABLE "CustomerSession"
  ADD COLUMN "accessTokenHash" VARCHAR(128),
  ADD COLUMN "accessTokenExpiresAt" TIMESTAMP(3) WITH TIME ZONE;

CREATE UNIQUE INDEX "CustomerSession_accessTokenHash_key"
  ON "CustomerSession"("accessTokenHash");

CREATE INDEX "CustomerSession_accessTokenExpiresAt_revokedAt_idx"
  ON "CustomerSession"("accessTokenExpiresAt", "revokedAt");

ALTER TABLE "CustomerSession"
  ADD CONSTRAINT "CustomerSession_access_token_expiry_pair_check"
  CHECK (("accessTokenHash" IS NULL) = ("accessTokenExpiresAt" IS NULL));
