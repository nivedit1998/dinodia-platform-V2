-- Additive physical-parent relation. Existing managed devices remain valid with NULL parent.
CREATE TABLE "NativePhysicalDevice" (
  "id" UUID NOT NULL,
  "homeId" UUID NOT NULL,
  "hubInstallationId" UUID NOT NULL,
  "osPhysicalDeviceId" VARCHAR(160) NOT NULL,
  "pairingGeneration" INTEGER NOT NULL DEFAULT 1,
  "managementClass" "DeviceManagementClass" NOT NULL,
  "ownerMembershipId" UUID,
  "protocol" VARCHAR(80) NOT NULL,
  "protocolIdentityHash" VARCHAR(64) NOT NULL,
  "manifestDigest" VARCHAR(64) NOT NULL,
  "manifestRevision" INTEGER NOT NULL DEFAULT 1,
  "lifecycle" VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NativePhysicalDevice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NativePhysicalDevice_owner_check" CHECK (
    ("managementClass" = 'PROPERTY_DEVICE' AND "ownerMembershipId" IS NULL) OR
    ("managementClass" = 'TENANT_DEVICE' AND "ownerMembershipId" IS NOT NULL)),
  CONSTRAINT "NativePhysicalDevice_revision_check" CHECK (
    "pairingGeneration" > 0 AND "manifestRevision" > 0),
  CONSTRAINT "NativePhysicalDevice_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "NativePhysicalDevice_hubInstallationId_fkey" FOREIGN KEY ("hubInstallationId") REFERENCES "HubInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "NativePhysicalDevice_ownerMembershipId_fkey" FOREIGN KEY ("ownerMembershipId") REFERENCES "HomeMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "NativePhysicalDevice_hub_physical_generation_key"
  ON "NativePhysicalDevice" ("hubInstallationId", "osPhysicalDeviceId", "pairingGeneration");
CREATE INDEX "NativePhysicalDevice_homeId_lifecycle_idx" ON "NativePhysicalDevice" ("homeId", "lifecycle");
ALTER TABLE "NativeDevice" ADD COLUMN "physicalParentId" UUID,
  ADD COLUMN "channelKey" VARCHAR(120),
  ADD COLUMN "channelGeneration" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "mappingRevision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "sourceBinding" JSONB;
ALTER TABLE "NativeDevice" ADD CONSTRAINT "NativeDevice_physicalParentId_fkey"
  FOREIGN KEY ("physicalParentId") REFERENCES "NativePhysicalDevice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "NativeDevice_parent_channel_generation_key"
  ON "NativeDevice" ("physicalParentId", "channelKey", "channelGeneration");

CREATE FUNCTION "check_logical_device_parent"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent "NativePhysicalDevice"%ROWTYPE;
BEGIN
  IF NEW."physicalParentId" IS NULL THEN
    IF NEW."channelKey" IS NOT NULL THEN RAISE EXCEPTION 'logical channel requires a physical parent'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO parent FROM "NativePhysicalDevice" WHERE "id" = NEW."physicalParentId" FOR SHARE;
  IF NOT FOUND OR parent."homeId" <> NEW."homeId" OR parent."hubInstallationId" <> NEW."hubInstallationId"
    OR parent."managementClass" <> NEW."managementClass"
    OR parent."ownerMembershipId" IS DISTINCT FROM NEW."ownerMembershipId"
    OR NEW."channelKey" IS NULL OR NEW."channelKey" = '' OR NEW."channelGeneration" < 1 OR NEW."mappingRevision" < 1
  THEN RAISE EXCEPTION 'logical device parent authority mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "NativeDevice_physical_parent_guard" BEFORE INSERT OR UPDATE ON "NativeDevice"
  FOR EACH ROW EXECUTE FUNCTION "check_logical_device_parent"();

CREATE FUNCTION "check_physical_device_scope"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "HubInstallation" h WHERE h."id" = NEW."hubInstallationId" AND h."homeId" = NEW."homeId")
    OR (NEW."ownerMembershipId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "HomeMembership" m WHERE m."id" = NEW."ownerMembershipId" AND m."homeId" = NEW."homeId" AND m."role" = 'TENANT'))
    OR EXISTS (SELECT 1 FROM "NativeDevice" d WHERE d."physicalParentId" = NEW."id" AND (
      d."homeId" <> NEW."homeId" OR d."hubInstallationId" <> NEW."hubInstallationId"
      OR d."managementClass" <> NEW."managementClass" OR d."ownerMembershipId" IS DISTINCT FROM NEW."ownerMembershipId"))
  THEN RAISE EXCEPTION 'physical device scope mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "NativePhysicalDevice_scope_guard" BEFORE INSERT OR UPDATE ON "NativePhysicalDevice"
  FOR EACH ROW EXECUTE FUNCTION "check_physical_device_scope"();

-- Existing private-device cleanup paths delete NativeDevice rows. Do not leave an
-- orphan containing a former tenant's identity, or block subsequent membership erasure.
-- A shared parent is retained while ANY child remains.
CREATE FUNCTION "remove_empty_logical_parent"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."physicalParentId" IS NOT NULL THEN
    PERFORM 1 FROM "NativePhysicalDevice" WHERE "id" = OLD."physicalParentId" FOR UPDATE;
    DELETE FROM "NativePhysicalDevice" p WHERE p."id" = OLD."physicalParentId"
      AND NOT EXISTS (SELECT 1 FROM "NativeDevice" d WHERE d."physicalParentId" = p."id");
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER "NativeDevice_remove_empty_parent" AFTER DELETE ON "NativeDevice"
  FOR EACH ROW EXECUTE FUNCTION "remove_empty_logical_parent"();
