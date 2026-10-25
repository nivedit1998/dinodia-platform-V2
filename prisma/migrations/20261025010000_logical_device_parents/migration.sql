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
  SELECT * INTO parent FROM "NativePhysicalDevice" WHERE "id" = NEW."physicalParentId" FOR UPDATE;
  IF NOT FOUND OR parent."homeId" <> NEW."homeId" OR parent."hubInstallationId" <> NEW."hubInstallationId"
    OR parent."managementClass" <> NEW."managementClass"
    OR parent."ownerMembershipId" IS DISTINCT FROM NEW."ownerMembershipId"
    OR NEW."channelKey" IS NULL OR NEW."channelKey" = '' OR NEW."channelGeneration" < 1 OR NEW."mappingRevision" < 1
  THEN RAISE EXCEPTION 'logical device parent authority mismatch'; END IF;
  IF NEW."lifecycle" IN ('INSTALLED','VIEW_ONLY','DISCOVERED') AND EXISTS (
    SELECT 1 FROM "NativeDevice" d WHERE d."physicalParentId" = NEW."physicalParentId" AND d."id" <> NEW."id"
      AND d."lifecycle" IN ('INSTALLED','VIEW_ONLY','DISCOVERED')
      AND (d."channelKey" = NEW."channelKey" OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(COALESCE(d."sourceBinding" -> 'sourceEntityIds','[]'::jsonb)) a(value)
        JOIN jsonb_array_elements_text(COALESCE(NEW."sourceBinding" -> 'sourceEntityIds','[]'::jsonb)) b(value)
          ON a.value = b.value
      )))
  THEN RAISE EXCEPTION 'active logical channels cannot overlap physical sources'; END IF;
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

-- Lifecycle intents are not expiring delivery messages. Keep the original
-- bounds for ALL other outboxes; allow only the two reviewed state machines
-- their durable reservation/acknowledgement phases and bounded manifests.
ALTER TABLE "NativeDomainOutbox" DROP CONSTRAINT "NativeOutbox_bounds_check";
ALTER TABLE "NativeDomainOutbox" ADD CONSTRAINT "NativeOutbox_bounds_check" CHECK (
  "attempts" BETWEEN 0 AND 12 AND "expiresAt" > "createdAt"
  AND ("hubInstallationId" IS NULL OR "homeId" IS NOT NULL)
  AND (
    ("state" IN ('PENDING','PROCESSING','DELIVERED','FAILED','CANCELLED')
      AND "expiresAt" <= "createdAt" + INTERVAL '30 days' AND octet_length("payload"::text) <= 16384)
    OR ("aggregateType" = 'AreaDeletion' AND "eventType" = 'AREA_DELETE_V1'
      AND "state" IN ('PREVIEW','RESERVED','WAITING_HUB','COMPLETE')
      AND octet_length("payload"::text) <= 262144)
    OR ("aggregateType" = 'LogicalDeviceConversion' AND "eventType" = 'LOGICAL_CONVERSION_V1'
      AND "state" IN ('PREVIEW','RESERVED','COMPLETE') AND octet_length("payload"::text) <= 262144)
  )
);

-- A confirmed reservation freezes only its destructive scope. New assignments,
-- identity changes or room edits cannot race the Hub's irreversible fence.
-- Telemetry and unrelated rooms remain writable; authority revocation remains
-- immediate. Only the scoped lifecycle transaction may advance its own intent.
CREATE FUNCTION "guard_reserved_area_deletion"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE area_ids text[] := ARRAY[]::text[]; device_ids text[] := ARRAY[]::text[];
BEGIN
  IF TG_TABLE_NAME = 'Area' THEN
    IF TG_OP <> 'INSERT' THEN area_ids := array_append(area_ids, OLD."id"::text); END IF;
    IF TG_OP <> 'DELETE' THEN area_ids := array_append(area_ids, NEW."id"::text); END IF;
  ELSIF TG_TABLE_NAME = 'DeviceAreaAssignment' THEN
    IF TG_OP <> 'INSERT' THEN area_ids := array_append(area_ids, OLD."areaId"::text); device_ids := array_append(device_ids, OLD."deviceId"::text); END IF;
    IF TG_OP <> 'DELETE' THEN area_ids := array_append(area_ids, NEW."areaId"::text); device_ids := array_append(device_ids, NEW."deviceId"::text); END IF;
  ELSIF TG_TABLE_NAME = 'NativeDevice' THEN
    IF TG_OP = 'UPDATE' AND ROW(OLD."lifecycle", OLD."managementClass", OLD."ownerMembershipId",
      OLD."descriptorRevision", OLD."descriptorDigest", OLD."sourceBinding", OLD."inventoryRevision",
      OLD."analyticsCategory", OLD."overrideName", OLD."customerLabel")
      IS NOT DISTINCT FROM ROW(NEW."lifecycle", NEW."managementClass", NEW."ownerMembershipId",
      NEW."descriptorRevision", NEW."descriptorDigest", NEW."sourceBinding", NEW."inventoryRevision",
      NEW."analyticsCategory", NEW."overrideName", NEW."customerLabel") THEN RETURN NEW; END IF;
    IF TG_OP <> 'INSERT' THEN device_ids := array_append(device_ids, OLD."id"::text); END IF;
    IF TG_OP <> 'DELETE' THEN device_ids := array_append(device_ids, NEW."id"::text); END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM "NativeDomainOutbox" o WHERE o."eventType" = 'AREA_DELETE_V1'
    AND o."aggregateType" = 'AreaDeletion' AND o."state" IN ('RESERVED','WAITING_HUB')
    AND o."id"::text IS DISTINCT FROM current_setting('dinodia.area_deletion_operation', true)
    AND (o."payload" #>> '{snapshot,areaId}' = ANY(area_ids)
      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(
        COALESCE(o."payload" #> '{snapshot,deviceIds}', '[]'::jsonb)
        || COALESCE(o."payload" #> '{snapshot,legacyDeviceIds}', '[]'::jsonb)) d(value) WHERE d.value = ANY(device_ids))))
  THEN RAISE EXCEPTION 'area deletion scope is reserved; finish cleanup before changing its assignments'; END IF;
  IF EXISTS (SELECT 1 FROM "NativeDomainOutbox" o WHERE o."eventType" = 'LOGICAL_CONVERSION_V1'
    AND o."aggregateType" = 'LogicalDeviceConversion' AND o."state" = 'RESERVED'
    AND o."id"::text IS DISTINCT FROM current_setting('dinodia.logical_conversion_operation', true)
    AND o."payload" ->> 'deviceId' = ANY(device_ids))
  THEN RAISE EXCEPTION 'logical conversion scope is reserved; finish conversion before changing its assignments'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER "Area_reserved_deletion_guard" BEFORE UPDATE OR DELETE ON "Area"
  FOR EACH ROW EXECUTE FUNCTION "guard_reserved_area_deletion"();
CREATE TRIGGER "Assignment_reserved_deletion_guard" BEFORE INSERT OR UPDATE OR DELETE ON "DeviceAreaAssignment"
  FOR EACH ROW EXECUTE FUNCTION "guard_reserved_area_deletion"();
CREATE TRIGGER "Device_reserved_deletion_guard" BEFORE UPDATE OR DELETE ON "NativeDevice"
  FOR EACH ROW EXECUTE FUNCTION "guard_reserved_area_deletion"();
