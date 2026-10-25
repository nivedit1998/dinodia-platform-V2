ALTER TABLE "AuthChallenge"
  ADD COLUMN "targetResourceId" UUID;

CREATE INDEX "AuthChallenge_targetResourceId_purpose_expiresAt_idx"
  ON "AuthChallenge"("targetResourceId", "purpose", "expiresAt");

ALTER TABLE "AreaAccessRequest"
  ALTER COLUMN "requesterAccountId" DROP NOT NULL,
  ADD COLUMN "requesterEmailNormalized" VARCHAR(320),
  ADD COLUMN "requesterEmailHash" VARCHAR(128),
  ADD COLUMN "emailVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "onboardingInvitationId" UUID,
  ADD COLUMN "onboardingEmailStatus" VARCHAR(24) NOT NULL DEFAULT 'NOT_REQUIRED';

ALTER TABLE "AreaAccessRequest"
  ADD CONSTRAINT "AreaAccessRequest_requester_or_email_check"
    CHECK ("requesterAccountId" IS NOT NULL OR "requesterEmailNormalized" IS NOT NULL),
  ADD CONSTRAINT "AreaAccessRequest_email_hash_requires_email_check"
    CHECK ("requesterEmailHash" IS NULL OR "requesterEmailNormalized" IS NOT NULL),
  ADD CONSTRAINT "AreaAccessRequest_onboarding_email_status_check"
    CHECK ("onboardingEmailStatus" IN ('NOT_REQUIRED', 'PENDING', 'ACCEPTED', 'FAILED')),
  ADD CONSTRAINT "AreaAccessRequest_onboardingInvitationId_fkey"
    FOREIGN KEY ("onboardingInvitationId") REFERENCES "MembershipInvitation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Keep the existing verified-account rule, while allowing the newly supported
-- logged-out Room flow only after the email challenge has set its verified
-- timestamp. The previous trigger assumed every requester already had an
-- account and rejected the correctly verified account-less request.
CREATE OR REPLACE FUNCTION dinodia_validate_area_access_request()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  qr_area uuid;
  qr_status "AreaQrStatus";
  requester_verified timestamp;
  approver_role "MembershipRole";
BEGIN
  SELECT "areaId", "status" INTO qr_area, qr_status
    FROM "AreaQrCredential" WHERE "id" = NEW."areaQrCredentialId";
  IF qr_area IS DISTINCT FROM NEW."areaId" THEN
    RAISE EXCEPTION 'area access request QR does not belong to requested area';
  END IF;
  IF NEW."status" = 'PENDING' THEN
    IF qr_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'pending area access request requires current active room QR';
    END IF;
    IF NEW."requesterAccountId" IS NOT NULL THEN
      SELECT "emailVerifiedAt" INTO requester_verified
        FROM "CustomerAccount" WHERE "id" = NEW."requesterAccountId";
      IF requester_verified IS NULL THEN
        RAISE EXCEPTION 'area access requester email must be verified';
      END IF;
    ELSIF NEW."emailVerifiedAt" IS NULL OR NEW."requesterEmailNormalized" IS NULL THEN
      RAISE EXCEPTION 'prospective area access requester email must be verified';
    END IF;
  END IF;
  IF NEW."approvedByMembershipId" IS NOT NULL THEN
    SELECT "role" INTO approver_role
      FROM "HomeMembership"
      WHERE "id" = NEW."approvedByMembershipId" AND "homeId" = NEW."homeId" AND "status" = 'ACTIVE';
    IF approver_role IS DISTINCT FROM 'OWNER' AND approver_role IS DISTINCT FROM 'PROPERTY_MANAGER' THEN
      RAISE EXCEPTION 'area access approver must be an active owner or property manager in the same home';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE UNIQUE INDEX "AreaAccessRequest_onboardingInvitationId_key"
  ON "AreaAccessRequest"("onboardingInvitationId");
CREATE INDEX "AreaAccessRequest_requesterEmailHash_areaId_status_expiresAt_idx"
  ON "AreaAccessRequest"("requesterEmailHash", "areaId", "status", "expiresAt");

CREATE TABLE "RoomAccessEmailAttempt" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "areaQrCredentialId" UUID NOT NULL,
  "areaId" UUID NOT NULL,
  "homeId" UUID NOT NULL,
  "qrGeneration" INTEGER NOT NULL,
  "requesterEmailNormalized" VARCHAR(320),
  "requesterEmailHash" VARCHAR(128) NOT NULL,
  "idempotencyKeyHash" VARCHAR(128) NOT NULL,
  "requestHash" VARCHAR(128) NOT NULL,
  "state" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "areaAccessRequestId" UUID,
  "coalescedIntoId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RoomAccessEmailAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RoomAccessEmailAttempt_state_check" CHECK ("state" IN ('PENDING', 'VERIFIED', 'EXPIRED', 'COALESCED')),
  CONSTRAINT "RoomAccessEmailAttempt_email_hash_check" CHECK ("requesterEmailNormalized" IS NULL OR length("requesterEmailNormalized") > 0),
  CONSTRAINT "RoomAccessEmailAttempt_qr_generation_check" CHECK ("qrGeneration" > 0),
  CONSTRAINT "RoomAccessEmailAttempt_qrCredential_area_fkey"
    FOREIGN KEY ("areaQrCredentialId", "areaId") REFERENCES "AreaQrCredential"("id", "areaId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RoomAccessEmailAttempt_area_home_fkey"
    FOREIGN KEY ("areaId", "homeId") REFERENCES "Area"("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RoomAccessEmailAttempt_home_fkey"
    FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RoomAccessEmailAttempt_request_fkey"
    FOREIGN KEY ("areaAccessRequestId") REFERENCES "AreaAccessRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "RoomAccessEmailAttempt_coalesced_fkey"
    FOREIGN KEY ("coalescedIntoId") REFERENCES "RoomAccessEmailAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RoomAccessEmailAttempt_idempotencyKeyHash_key"
  ON "RoomAccessEmailAttempt"("idempotencyKeyHash");
CREATE UNIQUE INDEX "RoomAccessEmailAttempt_areaAccessRequestId_key"
  ON "RoomAccessEmailAttempt"("areaAccessRequestId");
CREATE INDEX "RoomAccessEmailAttempt_requesterEmailHash_areaId_state_expiresAt_idx"
  ON "RoomAccessEmailAttempt"("requesterEmailHash", "areaId", "state", "expiresAt");
CREATE INDEX "RoomAccessEmailAttempt_homeId_state_expiresAt_idx"
  ON "RoomAccessEmailAttempt"("homeId", "state", "expiresAt");
