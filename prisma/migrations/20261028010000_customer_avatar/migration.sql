-- Additive, nullable: a tenant's chosen icon and colour for the shared-area avatar stack (D21).
-- No backfill: null icon means initials, null colour means a stable default derived from the account id.
ALTER TABLE "CustomerAccount"
  ADD COLUMN "avatarIcon" VARCHAR(24),
  ADD COLUMN "avatarColour" VARCHAR(16),
  ADD COLUMN "avatarUpdatedAt" TIMESTAMP(3);
