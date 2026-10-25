-- Stage 12: normalize Alexa Area authority and add one-use OAuth credentials.
-- Existing areaIds is retained as a deprecated compatibility cache; all new
-- authorization reads use AlexaNativeAreaSelection rows.

-- An Alexa user link is created during the OAuth token exchange, before
-- Alexa's separate AcceptGrant event-gateway credentials exist.
ALTER TABLE "AlexaNativeLink"
  ALTER COLUMN "accessTokenCiphertext" DROP NOT NULL,
  ALTER COLUMN "refreshTokenCiphertext" DROP NOT NULL,
  ALTER COLUMN "accessTokenExpiresAt" DROP NOT NULL;

ALTER TABLE "AlexaNativeDirectiveReceipt"
  ADD COLUMN "requestDigest" VARCHAR(64),
  ADD COLUMN "commandId" VARCHAR(160);

CREATE TABLE "AlexaNativeAreaSelection" (
  "id" UUID NOT NULL,
  "homeScopeId" UUID NOT NULL,
  "areaId" UUID NOT NULL,
  "exposureGeneration" INTEGER NOT NULL DEFAULT 1,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AlexaNativeAreaSelection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AlexaNativeAreaSelection_generation_check" CHECK ("exposureGeneration" > 0),
  CONSTRAINT "AlexaNativeAreaSelection_scope_fkey" FOREIGN KEY ("homeScopeId") REFERENCES "AlexaNativeHomeScope"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AlexaNativeAreaSelection_area_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AlexaNativeAreaSelection_scope_area_generation_key" ON "AlexaNativeAreaSelection"("homeScopeId", "areaId", "exposureGeneration");
CREATE UNIQUE INDEX "AlexaNativeAreaSelection_one_active_area" ON "AlexaNativeAreaSelection"("homeScopeId", "areaId") WHERE "revokedAt" IS NULL;
CREATE INDEX "AlexaNativeAreaSelection_scope_revoked_idx" ON "AlexaNativeAreaSelection"("homeScopeId", "revokedAt");
CREATE INDEX "AlexaNativeAreaSelection_area_revoked_idx" ON "AlexaNativeAreaSelection"("areaId", "revokedAt");

CREATE TABLE "AlexaNativeConnectIntent" (
  "id" UUID NOT NULL,
  "customerAccountId" UUID NOT NULL,
  "homeId" UUID NOT NULL,
  "membershipId" UUID NOT NULL,
  "intentHash" VARCHAR(64) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AlexaNativeConnectIntent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AlexaNativeConnectIntent_hash_check" CHECK ("intentHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "AlexaNativeConnectIntent_account_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AlexaNativeConnectIntent_home_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AlexaNativeConnectIntent_membership_fkey" FOREIGN KEY ("membershipId") REFERENCES "HomeMembership"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AlexaNativeConnectIntent_intentHash_key" ON "AlexaNativeConnectIntent"("intentHash");
CREATE INDEX "AlexaNativeConnectIntent_account_expiry_consumed_idx" ON "AlexaNativeConnectIntent"("customerAccountId", "expiresAt", "consumedAt");
CREATE INDEX "AlexaNativeConnectIntent_home_membership_expiry_idx" ON "AlexaNativeConnectIntent"("homeId", "membershipId", "expiresAt");

CREATE TABLE "AlexaNativeConnectIntentArea" (
  "intentId" UUID NOT NULL,
  "areaId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AlexaNativeConnectIntentArea_pkey" PRIMARY KEY ("intentId", "areaId"),
  CONSTRAINT "AlexaNativeConnectIntentArea_intent_fkey" FOREIGN KEY ("intentId") REFERENCES "AlexaNativeConnectIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AlexaNativeConnectIntentArea_area_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AlexaNativeConnectIntentArea_area_idx" ON "AlexaNativeConnectIntentArea"("areaId");

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
  IF TG_OP = 'UPDATE' AND NEW."consumedAt" IS NOT NULL AND (
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
CREATE TRIGGER "AlexaNativeConnectIntent_scope_guard" BEFORE INSERT OR UPDATE ON "AlexaNativeConnectIntent" FOR EACH ROW EXECUTE FUNCTION "enforce_native_alexa_connect_intent"();

CREATE OR REPLACE FUNCTION "enforce_native_alexa_connect_intent_area"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE intent_account UUID; intent_home UUID; intent_membership UUID; member_account UUID; member_role "MembershipRole"; member_status "MembershipStatus"; area_home UUID; area_status "AreaStatus";
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."intentId" <> OLD."intentId" OR NEW."areaId" <> OLD."areaId" OR NEW."createdAt" <> OLD."createdAt") THEN
    RAISE EXCEPTION 'Native Alexa connect-intent Area identity is immutable' USING ERRCODE = '23514';
  END IF;
  SELECT "customerAccountId", "homeId", "membershipId" INTO intent_account, intent_home, intent_membership
    FROM "AlexaNativeConnectIntent" WHERE "id" = NEW."intentId" AND "consumedAt" IS NULL AND "revokedAt" IS NULL AND "expiresAt" > clock_timestamp();
  SELECT "customerAccountId", "role", "status" INTO member_account, member_role, member_status
    FROM "HomeMembership" WHERE "id" = intent_membership AND "homeId" = intent_home;
  SELECT "homeId", "status" INTO area_home, area_status FROM "Area" WHERE "id" = NEW."areaId";
  IF intent_account IS NULL OR member_account <> intent_account OR member_role <> 'TENANT' OR member_status <> 'ACTIVE'
     OR area_home <> intent_home OR area_status <> 'ACTIVE'
     OR NOT EXISTS (SELECT 1 FROM "TenantAreaGrant" AS grant_row WHERE grant_row."membershipId" = intent_membership
       AND grant_row."homeId" = intent_home AND grant_row."areaId" = NEW."areaId" AND grant_row."revokedAt" IS NULL) THEN
    RAISE EXCEPTION 'Native Alexa intent Area requires the exact current tenant grant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "AlexaNativeConnectIntentArea_scope_guard" BEFORE INSERT OR UPDATE ON "AlexaNativeConnectIntentArea" FOR EACH ROW EXECUTE FUNCTION "enforce_native_alexa_connect_intent_area"();

-- Preserve any previously selected, currently valid rows before switching the
-- authorization trigger. Invalid, revoked, or malformed entries are not made
-- authoritative by this migration.
INSERT INTO "AlexaNativeAreaSelection" ("id", "homeScopeId", "areaId", "exposureGeneration", "createdAt", "updatedAt")
SELECT gen_random_uuid(), scope."id", parsed.area_id, GREATEST(scope."exposureGeneration", 1), scope."createdAt", CURRENT_TIMESTAMP
FROM "AlexaNativeHomeScope" AS scope
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(scope."areaIds") = 'array' THEN scope."areaIds" ELSE '[]'::jsonb END
) AS raw_area(area_text)
CROSS JOIN LATERAL (SELECT CASE WHEN raw_area.area_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN raw_area.area_text::uuid ELSE NULL END AS area_id) AS parsed
WHERE parsed.area_id IS NOT NULL AND scope."revokedAt" IS NULL
  AND EXISTS (
    SELECT 1 FROM "HomeMembership" AS member
    JOIN "CustomerAccount" AS account ON account."id" = member."customerAccountId" AND account."status" = 'ACTIVE'
    JOIN "TenantAreaGrant" AS grant_row ON grant_row."membershipId" = member."id" AND grant_row."homeId" = member."homeId"
    JOIN "Area" AS area ON area."id" = grant_row."areaId" AND area."homeId" = member."homeId"
    WHERE member."id" = scope."membershipId" AND member."homeId" = scope."homeId"
      AND member."role" = 'TENANT' AND member."status" = 'ACTIVE'
      AND grant_row."areaId" = parsed.area_id AND grant_row."revokedAt" IS NULL AND area."status" = 'ACTIVE'
  )
ON CONFLICT DO NOTHING;

CREATE TABLE "AlexaOAuthAuthorizationCode" (
  "id" UUID NOT NULL,
  "customerAccountId" UUID NOT NULL,
  "clientId" VARCHAR(160) NOT NULL,
  "redirectUri" VARCHAR(500) NOT NULL,
  "codeChallenge" VARCHAR(128) NOT NULL,
  "codeChallengeMethod" VARCHAR(8) NOT NULL DEFAULT 'S256',
  "codeHash" VARCHAR(128) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AlexaOAuthAuthorizationCode_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AlexaOAuthAuthorizationCode_hash_check" CHECK ("codeHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "AlexaOAuthAuthorizationCode_pkce_check" CHECK ("codeChallengeMethod" = 'S256' AND "codeChallenge" ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT "AlexaOAuthAuthorizationCode_account_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AlexaOAuthAuthorizationCode_codeHash_key" ON "AlexaOAuthAuthorizationCode"("codeHash");
CREATE INDEX "AlexaOAuthAuthorizationCode_account_expiry_idx" ON "AlexaOAuthAuthorizationCode"("customerAccountId", "expiresAt");
CREATE INDEX "AlexaOAuthAuthorizationCode_expiry_consumed_idx" ON "AlexaOAuthAuthorizationCode"("expiresAt", "consumedAt");

CREATE TABLE "AlexaOAuthAuthorizationCodeIntent" (
  "authorizationCodeId" UUID NOT NULL,
  "intentId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AlexaOAuthAuthorizationCodeIntent_pkey" PRIMARY KEY ("authorizationCodeId", "intentId"),
  CONSTRAINT "AlexaOAuthAuthorizationCodeIntent_code_fkey" FOREIGN KEY ("authorizationCodeId") REFERENCES "AlexaOAuthAuthorizationCode"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AlexaOAuthAuthorizationCodeIntent_intent_fkey" FOREIGN KEY ("intentId") REFERENCES "AlexaNativeConnectIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AlexaOAuthAuthorizationCodeIntent_intent_idx" ON "AlexaOAuthAuthorizationCodeIntent"("intentId");

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
        AND EXISTS (SELECT 1 FROM "AlexaNativeConnectIntentArea" selected WHERE selected."intentId" = intent."id")
        AND NOT EXISTS (SELECT 1 FROM "AlexaNativeConnectIntentArea" selected
          LEFT JOIN "TenantAreaGrant" grant_row ON grant_row."membershipId" = intent."membershipId" AND grant_row."homeId" = intent."homeId"
            AND grant_row."areaId" = selected."areaId" AND grant_row."revokedAt" IS NULL
          LEFT JOIN "Area" area ON area."id" = selected."areaId" AND area."homeId" = intent."homeId" AND area."status" = 'ACTIVE'
          WHERE selected."intentId" = intent."id" AND (grant_row."id" IS NULL OR area."id" IS NULL))
    ) THEN
    RAISE EXCEPTION 'Native Alexa OAuth code may only bind the same active tenant account and current scope' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "AlexaOAuthAuthorizationCodeIntent_scope_guard" BEFORE INSERT OR UPDATE ON "AlexaOAuthAuthorizationCodeIntent" FOR EACH ROW EXECUTE FUNCTION "enforce_native_alexa_authorization_code_intent"();

CREATE TABLE "AlexaOAuthTokenFamily" (
  "id" UUID NOT NULL,
  "linkId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "absoluteExpiresAt" TIMESTAMP(3) NOT NULL,
  "inactivityExpiresAt" TIMESTAMP(3) NOT NULL,
  "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  "revokeReason" VARCHAR(80),
  CONSTRAINT "AlexaOAuthTokenFamily_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AlexaOAuthTokenFamily_link_fkey" FOREIGN KEY ("linkId") REFERENCES "AlexaNativeLink"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AlexaOAuthTokenFamily_link_revoked_expiry_idx" ON "AlexaOAuthTokenFamily"("linkId", "revokedAt", "absoluteExpiresAt");

CREATE OR REPLACE FUNCTION "enforce_native_alexa_oauth_family"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE link_status "AlexaNativeLinkStatus"; link_revoked TIMESTAMP(3);
BEGIN
  IF NEW."revokedAt" IS NOT NULL THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'Native Alexa token families may only be revoked once without changing identity' USING ERRCODE = '23514';
    END IF;
    IF OLD."revokedAt" IS NOT NULL OR NEW."id" <> OLD."id" OR NEW."linkId" <> OLD."linkId"
      OR NEW."createdAt" <> OLD."createdAt" OR NEW."absoluteExpiresAt" <> OLD."absoluteExpiresAt"
      OR NEW."inactivityExpiresAt" <> OLD."inactivityExpiresAt" OR NEW."lastUsedAt" <> OLD."lastUsedAt" THEN
      RAISE EXCEPTION 'Native Alexa token families may only be revoked once without changing identity' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Revoked Native Alexa token families cannot be restored' USING ERRCODE = '23514';
  END IF;
  SELECT "status", "revokedAt" INTO link_status, link_revoked FROM "AlexaNativeLink" WHERE "id" = NEW."linkId";
  IF link_status <> 'ACTIVE' OR link_revoked IS NOT NULL OR NEW."absoluteExpiresAt" <= clock_timestamp()
    OR NEW."absoluteExpiresAt" > clock_timestamp() + INTERVAL '180 days'
    OR NEW."inactivityExpiresAt" <= clock_timestamp() OR NEW."inactivityExpiresAt" > NEW."absoluteExpiresAt"
    OR NEW."lastUsedAt" > clock_timestamp() + INTERVAL '1 minute' THEN
    RAISE EXCEPTION 'Native Alexa OAuth family requires an active link and bounded lifetime' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "AlexaOAuthTokenFamily_bounds_guard" BEFORE INSERT OR UPDATE ON "AlexaOAuthTokenFamily" FOR EACH ROW EXECUTE FUNCTION "enforce_native_alexa_oauth_family"();

CREATE TABLE "AlexaOAuthAccessToken" (
  "id" UUID NOT NULL,
  "familyId" UUID NOT NULL,
  "tokenHash" VARCHAR(128) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AlexaOAuthAccessToken_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AlexaOAuthAccessToken_hash_check" CHECK ("tokenHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "AlexaOAuthAccessToken_family_fkey" FOREIGN KEY ("familyId") REFERENCES "AlexaOAuthTokenFamily"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AlexaOAuthAccessToken_tokenHash_key" ON "AlexaOAuthAccessToken"("tokenHash");
CREATE INDEX "AlexaOAuthAccessToken_family_expiry_revoked_idx" ON "AlexaOAuthAccessToken"("familyId", "expiresAt", "revokedAt");

CREATE TABLE "AlexaOAuthRefreshToken" (
  "id" UUID NOT NULL,
  "familyId" UUID NOT NULL,
  "tokenHash" VARCHAR(128) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AlexaOAuthRefreshToken_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AlexaOAuthRefreshToken_hash_check" CHECK ("tokenHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "AlexaOAuthRefreshToken_family_fkey" FOREIGN KEY ("familyId") REFERENCES "AlexaOAuthTokenFamily"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AlexaOAuthRefreshToken_tokenHash_key" ON "AlexaOAuthRefreshToken"("tokenHash");
CREATE INDEX "AlexaOAuthRefreshToken_family_expiry_used_revoked_idx" ON "AlexaOAuthRefreshToken"("familyId", "expiresAt", "usedAt", "revokedAt");

CREATE OR REPLACE FUNCTION "enforce_native_alexa_oauth_token"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE family_deadline TIMESTAMP(3); family_inactivity TIMESTAMP(3); family_revoked TIMESTAMP(3);
BEGIN
  IF NEW."revokedAt" IS NOT NULL THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'Native Alexa OAuth tokens must be created active' USING ERRCODE = '23514';
    END IF;
    IF OLD."revokedAt" IS NOT NULL OR NEW."id" <> OLD."id" OR NEW."familyId" <> OLD."familyId"
      OR NEW."tokenHash" <> OLD."tokenHash" OR NEW."expiresAt" <> OLD."expiresAt" OR NEW."createdAt" <> OLD."createdAt" THEN
      RAISE EXCEPTION 'Native Alexa OAuth tokens may only be revoked once without changing identity' USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'AlexaOAuthRefreshToken'
      AND (to_jsonb(NEW) -> 'usedAt') IS DISTINCT FROM (to_jsonb(OLD) -> 'usedAt') THEN
      RAISE EXCEPTION 'Native Alexa refresh-token use state cannot change when revoking the token' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' AND OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Revoked Native Alexa OAuth tokens cannot be restored' USING ERRCODE = '23514';
  END IF;
  SELECT "absoluteExpiresAt", "inactivityExpiresAt", "revokedAt" INTO family_deadline, family_inactivity, family_revoked
    FROM "AlexaOAuthTokenFamily" WHERE "id" = NEW."familyId";
  IF family_deadline IS NULL OR family_revoked IS NOT NULL OR NEW."expiresAt" <= clock_timestamp()
    OR NEW."expiresAt" > family_deadline OR NEW."expiresAt" > family_inactivity THEN
    RAISE EXCEPTION 'Native Alexa OAuth token must remain within its active family lifetime' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "AlexaOAuthAccessToken_bounds_guard" BEFORE INSERT OR UPDATE ON "AlexaOAuthAccessToken" FOR EACH ROW EXECUTE FUNCTION "enforce_native_alexa_oauth_token"();
CREATE TRIGGER "AlexaOAuthRefreshToken_bounds_guard" BEFORE INSERT OR UPDATE ON "AlexaOAuthRefreshToken" FOR EACH ROW EXECUTE FUNCTION "enforce_native_alexa_oauth_token"();

-- Fail closed if old data already contains multiple active links for one
-- Dinodia account; do not silently pick or merge a skill identity.
CREATE UNIQUE INDEX "AlexaNativeLink_one_active_account" ON "AlexaNativeLink"("customerAccountId") WHERE "status" = 'ACTIVE' AND "revokedAt" IS NULL;

CREATE OR REPLACE FUNCTION "enforce_native_alexa_tenant_scope"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE link_account UUID; link_account_status "CustomerStatus"; link_email_verified TIMESTAMP(3); member_account UUID; member_role "MembershipRole"; member_status "MembershipStatus"; home_lifecycle "HomeLifecycle"; installation_status "InstallationStatus";
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" <> OLD."id" OR NEW."linkId" <> OLD."linkId" OR NEW."homeId" <> OLD."homeId" OR NEW."membershipId" <> OLD."membershipId"
      OR NEW."createdAt" <> OLD."createdAt" OR (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS NULL) THEN
      RAISE EXCEPTION 'Native Alexa Home scope identity is immutable and cannot be reactivated' USING ERRCODE = '23514';
    END IF;
    IF NEW."revokedAt" IS NOT NULL THEN RETURN NEW; END IF;
  ELSIF NEW."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Native Alexa Home scope must be created active' USING ERRCODE = '23514';
  END IF;
  SELECT link."customerAccountId", account."status", account."emailVerifiedAt" INTO link_account, link_account_status, link_email_verified
    FROM "AlexaNativeLink" AS link JOIN "CustomerAccount" AS account ON account."id" = link."customerAccountId"
    WHERE link."id" = NEW."linkId" AND link."status" = 'ACTIVE' AND link."revokedAt" IS NULL;
  SELECT "customerAccountId", "role", "status" INTO member_account, member_role, member_status FROM "HomeMembership" WHERE "id" = NEW."membershipId" AND "homeId" = NEW."homeId";
  SELECT "lifecycle", "installationStatus" INTO home_lifecycle, installation_status FROM "Home" WHERE "id" = NEW."homeId";
  IF link_account IS NULL OR link_account_status <> 'ACTIVE' OR link_email_verified IS NULL OR link_account <> member_account OR member_role <> 'TENANT' OR member_status <> 'ACTIVE'
    OR home_lifecycle <> 'ACTIVE' OR installation_status <> 'COMPLETE' THEN
    RAISE EXCEPTION 'Native Alexa scope requires an active linked account, tenant membership and completed Home' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION "enforce_native_alexa_area_selection"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE link_account UUID; member_account UUID; member_role "MembershipRole"; member_status "MembershipStatus"; scope_home UUID; scope_member UUID; area_home UUID; area_status "AreaStatus";
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" <> OLD."id" OR NEW."homeScopeId" <> OLD."homeScopeId" OR NEW."areaId" <> OLD."areaId"
      OR NEW."exposureGeneration" <> OLD."exposureGeneration" OR NEW."createdAt" <> OLD."createdAt"
      OR (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS NULL) THEN
      RAISE EXCEPTION 'Native Alexa Area selection identity is immutable and retired generations cannot be restored' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT link."customerAccountId", scope."homeId", scope."membershipId"
    INTO link_account, scope_home, scope_member
    FROM "AlexaNativeHomeScope" AS scope JOIN "AlexaNativeLink" AS link ON link."id" = scope."linkId"
    WHERE scope."id" = NEW."homeScopeId" AND scope."revokedAt" IS NULL AND link."status" = 'ACTIVE' AND link."revokedAt" IS NULL;
  SELECT "customerAccountId", "role", "status" INTO member_account, member_role, member_status
    FROM "HomeMembership" WHERE "id" = scope_member AND "homeId" = scope_home;
  SELECT "homeId", "status" INTO area_home, area_status FROM "Area" WHERE "id" = NEW."areaId";
  IF NEW."revokedAt" IS NULL AND (link_account IS NULL OR link_account <> member_account OR member_role <> 'TENANT'
      OR member_status <> 'ACTIVE' OR area_home <> scope_home OR area_status <> 'ACTIVE' OR NEW."exposureGeneration" < 1
      OR NOT EXISTS (SELECT 1 FROM "TenantAreaGrant" AS grant_row WHERE grant_row."membershipId" = scope_member
        AND grant_row."homeId" = scope_home AND grant_row."areaId" = NEW."areaId" AND grant_row."revokedAt" IS NULL)) THEN
    RAISE EXCEPTION 'Native Alexa Area selection requires a current linked tenant Area grant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "AlexaNativeAreaSelection_scope_guard" BEFORE INSERT OR UPDATE ON "AlexaNativeAreaSelection" FOR EACH ROW EXECUTE FUNCTION "enforce_native_alexa_area_selection"();

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
      OR NEW."deviceId" <> OLD."deviceId" OR NEW."areaId" <> OLD."areaId" OR NEW."endpointId" <> OLD."endpointId"
      OR NEW."exposureGeneration" <> OLD."exposureGeneration") THEN
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
