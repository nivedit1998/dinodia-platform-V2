-- Additive. Alexa for tenants: a link can cover every granted room of every tenant Home automatically ("autoScope"),
-- Alexa is told which endpoints it already knows (announced*), and a sign-in link attempt waits for phone approval.
-- No backfill: the Alexa tables are empty and every new column is nullable or has a safe default.
ALTER TABLE "AlexaNativeLink"
  ADD COLUMN "autoScope" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "announcedEndpointIds" JSONB;

ALTER TABLE "AlexaNativeEndpointProjection"
  ADD COLUMN "payloadHash" VARCHAR(64),
  ADD COLUMN "announcedHash" VARCHAR(64),
  ADD COLUMN "announcedAt" TIMESTAMP(3);

ALTER TABLE "AlexaNativeConnectIntent"
  ADD COLUMN "kind" VARCHAR(16) NOT NULL DEFAULT 'APP_CODE',
  ADD COLUMN "approvalNumber" INTEGER,
  ADD COLUMN "approvedAt" TIMESTAMP(3),
  ADD COLUMN "declinedAt" TIMESTAMP(3),
  ADD COLUMN "oauthRequestHash" VARCHAR(64);

-- One narrow relaxation of the endpoint guard (everything else in it is unchanged and still enforced): a live endpoint may
-- move to another room that is still granted, selected and assigned, keeping its endpoint id.
CREATE OR REPLACE FUNCTION "enforce_native_alexa_endpoint_scope"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE link_account UUID; link_account_status "CustomerStatus"; link_email_verified TIMESTAMP(3); member_account UUID; member_role "MembershipRole"; member_status "MembershipStatus"; device_class "DeviceManagementClass"; owner_membership UUID;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."status" <> 'ACTIVE' THEN
    IF OLD."status" <> 'ACTIVE' OR NEW."id" <> OLD."id" OR NEW."linkId" <> OLD."linkId" OR NEW."homeId" <> OLD."homeId"
      OR NEW."membershipId" <> OLD."membershipId" OR NEW."deviceId" <> OLD."deviceId" OR NEW."areaId" <> OLD."areaId"
      OR NEW."endpointId" <> OLD."endpointId" OR NEW."exposureGeneration" <> OLD."exposureGeneration" THEN
      RAISE EXCEPTION 'Native Alexa endpoint projections may only be retired without changing identity' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'INSERT' AND NEW."status" <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Native Alexa endpoint projections must be created active' USING ERRCODE = '23514';
  ELSIF TG_OP = 'UPDATE' AND OLD."status" <> 'ACTIVE'
    AND (NEW."exposureGeneration" <= OLD."exposureGeneration" OR NEW."endpointId" = OLD."endpointId") THEN
    RAISE EXCEPTION 'Re-exposed Native Alexa endpoints require a new exposure generation and identity' USING ERRCODE = '23514';
  ELSIF TG_OP = 'UPDATE' AND OLD."status" = 'ACTIVE'
    AND (NEW."linkId" <> OLD."linkId" OR NEW."homeId" <> OLD."homeId" OR NEW."membershipId" <> OLD."membershipId"
      OR NEW."deviceId" <> OLD."deviceId" OR NEW."endpointId" <> OLD."endpointId"
      OR (NEW."areaId" = OLD."areaId" AND NEW."exposureGeneration" <> OLD."exposureGeneration")
      OR (NEW."areaId" <> OLD."areaId" AND NEW."exposureGeneration" < 1)) THEN
    -- A live endpoint keeps its identity (so Alexa routines survive) and may move to another room that is still
    -- granted, selected and assigned; the room checks below are unchanged and still reject anything else.
    RAISE EXCEPTION 'Active Native Alexa endpoint identity is immutable within an exposure generation' USING ERRCODE = '23514';
  END IF;
  SELECT link."customerAccountId", account."status", account."emailVerifiedAt" INTO link_account, link_account_status, link_email_verified
    FROM "AlexaNativeLink" AS link JOIN "CustomerAccount" AS account ON account."id" = link."customerAccountId"
    WHERE link."id" = NEW."linkId" AND link."status" = 'ACTIVE' AND link."revokedAt" IS NULL;
  SELECT "customerAccountId", "role", "status" INTO member_account, member_role, member_status FROM "HomeMembership" WHERE "id" = NEW."membershipId" AND "homeId" = NEW."homeId";
  SELECT "managementClass", "ownerMembershipId" INTO device_class, owner_membership FROM "NativeDevice" WHERE "id" = NEW."deviceId" AND "homeId" = NEW."homeId" AND "lifecycle" = 'INSTALLED';
  IF link_account IS NULL OR link_account_status <> 'ACTIVE' OR link_email_verified IS NULL OR link_account <> member_account OR member_role <> 'TENANT' OR member_status <> 'ACTIVE' THEN RAISE EXCEPTION 'Native Alexa endpoint requires the linked account current active tenant membership' USING ERRCODE = '23514'; END IF;
  IF device_class IS NULL OR (device_class = 'TENANT_DEVICE' AND owner_membership <> NEW."membershipId") THEN RAISE EXCEPTION 'Native Alexa endpoint device is not visible to the linked tenant' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "TenantAreaGrant" grant_row JOIN "Area" area ON area."id" = grant_row."areaId" AND area."homeId" = grant_row."homeId"
    JOIN "AlexaNativeHomeScope" scope ON scope."linkId" = NEW."linkId" AND scope."membershipId" = NEW."membershipId" AND scope."homeId" = NEW."homeId" AND scope."revokedAt" IS NULL
    JOIN "AlexaNativeAreaSelection" selected ON selected."homeScopeId" = scope."id" AND selected."areaId" = NEW."areaId" AND selected."revokedAt" IS NULL
    WHERE grant_row."membershipId" = NEW."membershipId" AND grant_row."homeId" = NEW."homeId" AND grant_row."areaId" = NEW."areaId"
      AND grant_row."revokedAt" IS NULL AND area."status" = 'ACTIVE' AND selected."exposureGeneration" = NEW."exposureGeneration"
      AND EXISTS (SELECT 1 FROM "DeviceAreaAssignment" assignment WHERE assignment."deviceId" = NEW."deviceId"
        AND assignment."homeId" = NEW."homeId" AND assignment."areaId" = NEW."areaId" AND assignment."validFrom" <= clock_timestamp()
        AND (assignment."validUntil" IS NULL OR assignment."validUntil" > clock_timestamp()))
  ) THEN RAISE EXCEPTION 'Native Alexa endpoint Area is not in the current selected tenant scope' USING ERRCODE = '23514'; END IF;
  IF "json_contains_app_only_security"(NEW."capabilities") THEN RAISE EXCEPTION 'App-only security controls cannot be exposed through Alexa' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;

-- Sign-in links (kind SIGN_IN) have no per-room choice, so the two guards that demanded selected rooms on a connect intent
-- accept an approved SIGN_IN intent instead. APP_CODE intents keep exactly the checks they had.
CREATE OR REPLACE FUNCTION "enforce_native_alexa_connect_intent"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_status "CustomerStatus"; member_account UUID; member_home UUID; member_role "MembershipRole"; member_status "MembershipStatus"; home_status "HomeLifecycle"; installation_status "InstallationStatus";
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" <> OLD."id" OR NEW."customerAccountId" <> OLD."customerAccountId" OR NEW."homeId" <> OLD."homeId"
      OR NEW."membershipId" <> OLD."membershipId" OR NEW."intentHash" <> OLD."intentHash" OR NEW."expiresAt" <> OLD."expiresAt"
      OR NEW."createdAt" <> OLD."createdAt" OR (OLD."consumedAt" IS NOT NULL AND NEW."consumedAt" IS NULL)
      OR (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS NULL) THEN
      RAISE EXCEPTION 'Native Alexa connect intent identity and expiry are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW."revokedAt" IS NOT NULL THEN RETURN NEW; END IF;
  ELSIF NEW."consumedAt" IS NOT NULL OR NEW."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Native Alexa connect intents must be created unused' USING ERRCODE = '23514';
  END IF;
  SELECT "status" INTO account_status FROM "CustomerAccount" WHERE "id" = NEW."customerAccountId";
  SELECT "customerAccountId", "homeId", "role", "status" INTO member_account, member_home, member_role, member_status
    FROM "HomeMembership" WHERE "id" = NEW."membershipId";
  SELECT "lifecycle", "installationStatus" INTO home_status, installation_status FROM "Home" WHERE "id" = NEW."homeId";
  IF account_status <> 'ACTIVE' OR member_account <> NEW."customerAccountId" OR member_home <> NEW."homeId"
     OR member_role <> 'TENANT' OR member_status <> 'ACTIVE' OR home_status <> 'ACTIVE' OR installation_status <> 'COMPLETE'
     OR NEW."expiresAt" <= clock_timestamp() OR NEW."intentHash" !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Native Alexa connect intent requires a current tenant membership and complete Home' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."consumedAt" IS NOT NULL AND NEW."kind" = 'APP_CODE' AND (
    NOT EXISTS (SELECT 1 FROM "AlexaNativeConnectIntentArea" selected WHERE selected."intentId" = NEW."id")
    OR EXISTS (SELECT 1 FROM "AlexaNativeConnectIntentArea" selected
      LEFT JOIN "TenantAreaGrant" grant_row ON grant_row."membershipId" = NEW."membershipId" AND grant_row."homeId" = NEW."homeId"
        AND grant_row."areaId" = selected."areaId" AND grant_row."revokedAt" IS NULL
      LEFT JOIN "Area" area ON area."id" = selected."areaId" AND area."homeId" = NEW."homeId" AND area."status" = 'ACTIVE'
      WHERE selected."intentId" = NEW."id" AND (grant_row."id" IS NULL OR area."id" IS NULL))
  ) THEN
    RAISE EXCEPTION 'Consumed Native Alexa connect intent must retain every selected current Area grant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION "enforce_native_alexa_authorization_code_intent"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE code_account UUID; code_deadline TIMESTAMP(3); code_consumed TIMESTAMP(3); intent_account UUID; intent_home UUID; intent_membership UUID;
BEGIN
  SELECT "customerAccountId", "expiresAt", "consumedAt" INTO code_account, code_deadline, code_consumed
    FROM "AlexaOAuthAuthorizationCode" WHERE "id" = NEW."authorizationCodeId";
  SELECT "customerAccountId", "homeId", "membershipId" INTO intent_account, intent_home, intent_membership
    FROM "AlexaNativeConnectIntent" WHERE "id" = NEW."intentId";
  IF code_account IS NULL OR code_account <> intent_account OR code_deadline <= clock_timestamp() OR code_consumed IS NOT NULL
    OR NOT EXISTS (
      SELECT 1 FROM "AlexaNativeConnectIntent" intent
      JOIN "CustomerAccount" account ON account."id" = intent."customerAccountId" AND account."status" = 'ACTIVE'
      JOIN "HomeMembership" member ON member."id" = intent."membershipId" AND member."customerAccountId" = intent."customerAccountId"
        AND member."homeId" = intent."homeId" AND member."role" = 'TENANT' AND member."status" = 'ACTIVE'
      JOIN "Home" home ON home."id" = intent."homeId" AND home."lifecycle" = 'ACTIVE' AND home."installationStatus" = 'COMPLETE'
      WHERE intent."id" = NEW."intentId" AND intent."consumedAt" IS NULL AND intent."revokedAt" IS NULL AND intent."expiresAt" > clock_timestamp()
        AND (
          -- Linking from the Alexa side: the person signed in and the phone approved; there is no per-room choice to check.
          (intent."kind" = 'SIGN_IN' AND intent."approvedAt" IS NOT NULL AND intent."declinedAt" IS NULL)
          OR (intent."kind" = 'APP_CODE'
            AND EXISTS (SELECT 1 FROM "AlexaNativeConnectIntentArea" selected WHERE selected."intentId" = intent."id")
            AND NOT EXISTS (SELECT 1 FROM "AlexaNativeConnectIntentArea" selected
              LEFT JOIN "TenantAreaGrant" grant_row ON grant_row."membershipId" = intent."membershipId" AND grant_row."homeId" = intent."homeId"
                AND grant_row."areaId" = selected."areaId" AND grant_row."revokedAt" IS NULL
              LEFT JOIN "Area" area ON area."id" = selected."areaId" AND area."homeId" = intent."homeId" AND area."status" = 'ACTIVE'
              WHERE selected."intentId" = intent."id" AND (grant_row."id" IS NULL OR area."id" IS NULL)))
        )
    ) THEN
    RAISE EXCEPTION 'Native Alexa OAuth code may only bind the same active tenant account and current scope' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
