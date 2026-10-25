-- CreateTable
CREATE TABLE "NativeAnalyticsRetention" (
    "hubInstallationId" UUID NOT NULL,
    "homeId" UUID NOT NULL,
    "timezone" VARCHAR(64) NOT NULL,
    "writerFrom" TIMESTAMP(3) NOT NULL,
    "writerEnabled" BOOLEAN NOT NULL DEFAULT false,
    "readsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "pruningEnabled" BOOLEAN NOT NULL DEFAULT false,
    "barrierStreamId" VARCHAR(80),
    "barrierSequence" BIGINT,
    "legacySealedThrough" TIMESTAMP(3),
    "backfillVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NativeAnalyticsRetention_pkey" PRIMARY KEY ("hubInstallationId")
);

-- CreateTable
CREATE TABLE "NativeAnalyticsDay" (
    "id" UUID NOT NULL,
    "homeId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "areaId" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "analyticsCategory" "DeviceAnalyticsCategory" NOT NULL,
    "controlId" VARCHAR(160) NOT NULL,
    "sourceGeneration" INTEGER NOT NULL,
    "bindingRevision" INTEGER NOT NULL DEFAULT 0,
    "analyticsIntervalId" UUID,
    "analyticsPolicyVersion" INTEGER NOT NULL,
    "timezone" VARCHAR(64) NOT NULL,
    "dayStartAt" TIMESTAMP(3) NOT NULL,
    "dayEndAt" TIMESTAMP(3) NOT NULL,
    "writerFrom" TIMESTAMP(3) NOT NULL,
    "assignmentEpochAt" TIMESTAMP(3) NOT NULL,
    "origin" VARCHAR(16) NOT NULL,
    "revision" INTEGER NOT NULL,
    "onSeconds" INTEGER NOT NULL DEFAULT 0,
    "offSeconds" INTEGER NOT NULL DEFAULT 0,
    "unknownSeconds" INTEGER NOT NULL DEFAULT 0,
    "knownMilliseconds" BIGINT NOT NULL DEFAULT 0,
    "celsiusMilliseconds" DECIMAL(24,2) NOT NULL DEFAULT 0,
    "minimumCelsius" DECIMAL(6,2),
    "maximumCelsius" DECIMAL(6,2),
    "sampleCount" INTEGER NOT NULL DEFAULT 0,
    "lastCelsius" DECIMAL(6,2),
    "lastObservedAt" TIMESTAMP(3),
    "lastValidUntil" TIMESTAMP(3),
    "coverageStartAt" TIMESTAMP(3) NOT NULL,
    "coverageEndAt" TIMESTAMP(3) NOT NULL,
    "payloadDigest" VARCHAR(64) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "purgeAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NativeAnalyticsDay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NativeAnalyticsRetention_homeId_idx" ON "NativeAnalyticsRetention"("homeId");

-- CreateIndex
CREATE INDEX "NativeAnalyticsDay_homeId_kind_dayStartAt_idx" ON "NativeAnalyticsDay"("homeId", "kind", "dayStartAt");

-- CreateIndex
CREATE INDEX "NativeAnalyticsDay_purgeAt_idx" ON "NativeAnalyticsDay"("purgeAt");

-- CreateIndex
CREATE UNIQUE INDEX "NativeAnalyticsDay_source_key" ON "NativeAnalyticsDay"("deviceId", "areaId", "kind", "analyticsCategory", "controlId", "sourceGeneration", "bindingRevision", "dayStartAt", "writerFrom", "assignmentEpochAt", "origin");

-- AddForeignKey
ALTER TABLE "NativeAnalyticsRetention" ADD CONSTRAINT "NativeAnalyticsRetention_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeAnalyticsRetention" ADD CONSTRAINT "NativeAnalyticsRetention_hubInstallationId_fkey" FOREIGN KEY ("hubInstallationId") REFERENCES "HubInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeAnalyticsDay" ADD CONSTRAINT "NativeAnalyticsDay_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeAnalyticsDay" ADD CONSTRAINT "NativeAnalyticsDay_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "NativeDevice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeAnalyticsDay" ADD CONSTRAINT "NativeAnalyticsDay_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Counters describe disjoint genuine coverage, not a rounded chart bar. All new
-- rows remain shadow-only until their complete source prefix is verified.
ALTER TABLE "NativeAnalyticsRetention" ADD CONSTRAINT "NativeAnalyticsRetention_flags_check" CHECK (
  (NOT "pruningEnabled" OR ("readsEnabled" AND "backfillVerifiedAt" IS NOT NULL AND "legacySealedThrough" = "writerFrom"))
  AND ("barrierStreamId" IS NULL) = ("barrierSequence" IS NULL)
  AND ("barrierStreamId" IS NULL) = ("legacySealedThrough" IS NULL)
);
ALTER TABLE "NativeAnalyticsDay" ADD CONSTRAINT "NativeAnalyticsDay_coverage_check" CHECK (
  "kind" IN ('USAGE', 'TEMPERATURE') AND "origin" IN ('HUB', 'LEGACY')
  AND "analyticsCategory" IN ('LIGHT', 'RADIATOR', 'BOILER')
  AND "sourceGeneration" > 0 AND "bindingRevision" >= 0 AND "revision" > 0
  AND "analyticsPolicyVersion" IN (1, 2, 3)
  AND "coverageStartAt" >= "dayStartAt" AND "coverageEndAt" <= "dayEndAt"
  AND "coverageEndAt" > "coverageStartAt" AND "dayEndAt" > "dayStartAt"
  AND ("origin" <> 'HUB' OR "coverageStartAt" >= GREATEST("writerFrom", "assignmentEpochAt"))
  AND ("origin" <> 'LEGACY' OR "coverageEndAt" <= "writerFrom")
  AND "onSeconds" >= 0 AND "offSeconds" >= 0 AND "unknownSeconds" >= 0
  AND "knownMilliseconds" >= 0 AND "sampleCount" >= 0
  AND (("kind" = 'USAGE' AND ("onSeconds"::bigint + "offSeconds" + "unknownSeconds") * 1000
      = EXTRACT(EPOCH FROM ("coverageEndAt" - "coverageStartAt")) * 1000
      AND "knownMilliseconds" = 0 AND "celsiusMilliseconds" = 0 AND "minimumCelsius" IS NULL
      AND "maximumCelsius" IS NULL AND "lastCelsius" IS NULL AND "sampleCount" = 0
      AND "lastObservedAt" IS NULL AND "lastValidUntil" IS NULL)
    OR ("kind" = 'TEMPERATURE' AND "analyticsCategory" = 'RADIATOR'
      AND "onSeconds" = 0 AND "offSeconds" = 0 AND "unknownSeconds" = 0
      AND "knownMilliseconds" > 0
      AND "knownMilliseconds" <= EXTRACT(EPOCH FROM ("coverageEndAt" - "coverageStartAt")) * 1000
      AND "minimumCelsius" IS NOT NULL AND "maximumCelsius" IS NOT NULL AND "lastCelsius" IS NOT NULL
      AND "minimumCelsius" >= -50 AND "maximumCelsius" <= 80 AND "minimumCelsius" <= "maximumCelsius"
      AND "lastCelsius" BETWEEN -50 AND 80
      AND "lastObservedAt" IS NOT NULL AND "lastValidUntil" IS NOT NULL AND "lastValidUntil" >= "lastObservedAt"
      AND "celsiusMilliseconds" BETWEEN "minimumCelsius" * "knownMilliseconds" - 0.1
        AND "maximumCelsius" * "knownMilliseconds" + 0.1))
);

CREATE FUNCTION "guard_native_analytics_day"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE device_row "NativeDevice"%ROWTYPE;
BEGIN
  SELECT * INTO device_row FROM "NativeDevice" WHERE id = NEW."deviceId" FOR UPDATE;
  IF NOT FOUND OR device_row."homeId" <> NEW."homeId" OR device_row."managementClass" <> 'PROPERTY_DEVICE'
    OR device_row."ownerMembershipId" IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM "Area" a WHERE a.id = NEW."areaId" AND a."homeId" = NEW."homeId") THEN
    RAISE EXCEPTION 'Daily analytics requires same-home permanent-device authority' USING ERRCODE = '23514';
  END IF;
  IF NEW."dayStartAt" <> (date_trunc('day', NEW."dayStartAt" AT TIME ZONE 'UTC' AT TIME ZONE NEW.timezone) AT TIME ZONE NEW.timezone AT TIME ZONE 'UTC')
    OR NEW."dayEndAt" <> ((date_trunc('day', NEW."dayStartAt" AT TIME ZONE 'UTC' AT TIME ZONE NEW.timezone) + interval '1 day') AT TIME ZONE NEW.timezone AT TIME ZONE 'UTC') THEN
    RAISE EXCEPTION 'Daily analytics requires exact local-calendar boundaries' USING ERRCODE = '23514';
  END IF;
  IF NEW.origin = 'HUB' AND EXISTS (SELECT 1 FROM "NativeAnalyticsDay" d
      WHERE d."deviceId" = NEW."deviceId" AND d.kind = NEW.kind AND d.origin = 'HUB' AND d.id <> NEW.id
      AND d."coverageStartAt" < NEW."coverageEndAt" AND d."coverageEndAt" > NEW."coverageStartAt") THEN
    RAISE EXCEPTION 'Daily analytics coverage cannot overlap' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "NativeAnalyticsDay_authority_guard" BEFORE INSERT OR UPDATE ON "NativeAnalyticsDay"
FOR EACH ROW EXECUTE FUNCTION "guard_native_analytics_day"();

