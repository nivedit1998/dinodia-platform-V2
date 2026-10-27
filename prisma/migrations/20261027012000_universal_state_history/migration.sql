ALTER TABLE "NativeAnalyticsInterval" DROP CONSTRAINT "analytics_interval_policy_version";
ALTER TABLE "NativeAnalyticsInterval" ADD CONSTRAINT "analytics_interval_policy_version" CHECK (
  ("analyticsPolicyVersion" IN (2,3) AND "analyticsCategory"::text IN ('NONE','LIGHT','RADIATOR','BOILER'))
  OR ("analyticsPolicyVersion"=4 AND "analyticsCategory"::text IN ('SOCKET','TV','BLIND','AC','WASHING_MACHINE'))
);
CREATE TABLE "NativeAnalyticsStateDay" (
  id VARCHAR(64) PRIMARY KEY,
  "homeId" UUID NOT NULL REFERENCES "Home"(id) ON DELETE CASCADE,
  "hubInstallationId" UUID NOT NULL,
  "deviceId" UUID NOT NULL REFERENCES "NativeDevice"(id) ON DELETE RESTRICT,
  "areaId" UUID NOT NULL REFERENCES "Area"(id) ON DELETE RESTRICT,
  "analyticsCategory" VARCHAR(24) NOT NULL,
  dimension VARCHAR(24) NOT NULL,
  "controlId" VARCHAR(160) NOT NULL,
  "sourceGeneration" INTEGER NOT NULL,
  "bindingRevision" INTEGER NOT NULL,
  "analyticsIntervalId" UUID NOT NULL,
  "analyticsPolicyVersion" INTEGER NOT NULL,
  timezone VARCHAR(64) NOT NULL,
  "writerFrom" TIMESTAMP(3) NOT NULL,
  "dayStartAt" TIMESTAMP(3) NOT NULL,
  "dayEndAt" TIMESTAMP(3) NOT NULL,
  "assignmentEpochAt" TIMESTAMP(3) NOT NULL,
  revision INTEGER NOT NULL,
  "coverageStartAt" TIMESTAMP(3) NOT NULL,
  "coverageEndAt" TIMESTAMP(3) NOT NULL,
  "closedAt" TIMESTAMP(3),
  "durationsSeconds" JSONB NOT NULL,
  hourly JSONB NOT NULL DEFAULT '[]',
  "payloadDigest" VARCHAR(64) NOT NULL,
  "purgeAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NativeAnalyticsStateDay_bounds" CHECK (
    id ~ '^[a-f0-9]{64}$' AND "payloadDigest" ~ '^[a-f0-9]{64}$'
    AND "sourceGeneration">0 AND "bindingRevision">0 AND revision>0 AND "analyticsPolicyVersion"=4
    AND "coverageStartAt">=GREATEST("dayStartAt","writerFrom","assignmentEpochAt")
    AND "coverageEndAt">"coverageStartAt" AND "coverageEndAt"<="dayEndAt"
    AND ("closedAt" IS NULL OR "closedAt"="dayEndAt")
    AND date_trunc('hour',"writerFrom")="writerFrom"
  )
);
CREATE INDEX "NativeAnalyticsStateDay_homeId_analyticsCategory_dayStartAt_idx" ON "NativeAnalyticsStateDay"("homeId","analyticsCategory","dayStartAt");
CREATE INDEX "NativeAnalyticsStateDay_purgeAt_idx" ON "NativeAnalyticsStateDay"("purgeAt");
CREATE INDEX "NativeAnalyticsStateDay_deviceId_coverageStartAt_coverageEndAt_idx" ON "NativeAnalyticsStateDay"("deviceId","coverageStartAt","coverageEndAt");

CREATE FUNCTION native_state_duration_valid(category text, dimension_name text, durations jsonb, seconds bigint)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE keys text[]; expected text[]; expected_dimension text; total bigint;
BEGIN
  CASE category
    WHEN 'SOCKET','TV' THEN expected:=ARRAY['off','on','unknown']; expected_dimension:='power';
    WHEN 'BLIND' THEN expected:=ARRAY['closed','open','partial','unknown']; expected_dimension:='position';
    WHEN 'AC' THEN expected:=ARRAY['cooling','heating','idle','unknown']; expected_dimension:='thermal_activity';
    WHEN 'WASHING_MACHINE' THEN expected:=ARRAY['error','finished','idle','running','unknown']; expected_dimension:='cycle_activity';
    ELSE RETURN false;
  END CASE;
  IF dimension_name<>expected_dimension OR jsonb_typeof(durations)<>'object' OR seconds<0 OR seconds>100000 THEN RETURN false; END IF;
  SELECT array_agg(key ORDER BY key) INTO keys FROM jsonb_object_keys(durations) AS key;
  IF keys IS DISTINCT FROM expected THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_each(durations) v WHERE jsonb_typeof(v.value)<>'number' OR v.value::text !~ '^[0-9]{1,6}$') THEN RETURN false; END IF;
  SELECT sum(value::text::bigint) INTO total FROM jsonb_each(durations);
  RETURN total=seconds;
END $$;

CREATE FUNCTION guard_native_analytics_state_day() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE device_row "NativeDevice"%ROWTYPE; hour jsonb; hour_start timestamp; covered_start timestamp; covered_end timestamp; keys text[]; part_seconds bigint; total_seconds bigint:=0; expected_seconds bigint; state_key text; hourly_total bigint;
BEGIN
  SELECT * INTO device_row FROM "NativeDevice" WHERE id=NEW."deviceId" FOR UPDATE;
  IF NOT FOUND OR device_row."homeId"<>NEW."homeId" OR device_row."hubInstallationId"<>NEW."hubInstallationId"
    OR device_row."managementClass"<>'PROPERTY_DEVICE' OR device_row."ownerMembershipId" IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM "Area" WHERE id=NEW."areaId" AND "homeId"=NEW."homeId" AND status='ACTIVE') THEN
    RAISE EXCEPTION 'State analytics requires same-Home permanent-device authority' USING ERRCODE='23514';
  END IF;
  IF NEW."dayStartAt"<>native_analytics_day_start((NEW."dayStartAt" AT TIME ZONE 'UTC' AT TIME ZONE NEW.timezone)::date,NEW.timezone)
    OR NEW."dayEndAt"<>native_analytics_day_start((NEW."dayStartAt" AT TIME ZONE 'UTC' AT TIME ZONE NEW.timezone)::date+1,NEW.timezone) THEN
    RAISE EXCEPTION 'State analytics requires exact local day' USING ERRCODE='23514';
  END IF;
  expected_seconds:=EXTRACT(EPOCH FROM NEW."coverageEndAt"-NEW."coverageStartAt");
  IF EXTRACT(EPOCH FROM NEW."coverageEndAt"-NEW."coverageStartAt")<>expected_seconds
    OR NOT native_state_duration_valid(NEW."analyticsCategory",NEW.dimension,NEW."durationsSeconds",expected_seconds) THEN
    RAISE EXCEPTION 'Invalid state duration coverage' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM "NativeAnalyticsInterval" i WHERE i.id=NEW."analyticsIntervalId"
      AND i."homeId"=NEW."homeId" AND i."hubInstallationId"=NEW."hubInstallationId" AND i."deviceId"=NEW."deviceId"
      AND i."analyticsCategory"::text=NEW."analyticsCategory" AND i.revision=NEW."bindingRevision"
      AND i."sourceGeneration"=NEW."sourceGeneration" AND i."analyticsPolicyVersion"=4
      AND (i."selectedControlId" IS NULL OR i."selectedControlId"=NEW."controlId")
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(i."authorizedControls") c WHERE c->>'controlId'=NEW."controlId"
        AND c->>'observable'='true' AND c->>'semanticRole'=CASE NEW."analyticsCategory"
          WHEN 'SOCKET' THEN 'power' WHEN 'TV' THEN 'power' WHEN 'BLIND' THEN 'opening_percentage'
          WHEN 'AC' THEN 'thermal_activity' WHEN 'WASHING_MACHINE' THEN 'cycle_activity' END
        AND (NEW."analyticsCategory" IN ('SOCKET','TV') OR c->>'writable' IS DISTINCT FROM 'true'))
      AND i."validFrom"<=NEW."coverageStartAt" AND (i."validUntil" IS NULL OR i."validUntil">=NEW."coverageEndAt")) THEN
    RAISE EXCEPTION 'Invalid state analytics epoch' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM "DeviceAreaAssignment" a WHERE a."homeId"=NEW."homeId" AND a."deviceId"=NEW."deviceId" AND a."areaId"=NEW."areaId"
    AND a."validFrom"<=NEW."coverageStartAt" AND (a."validUntil" IS NULL OR a."validUntil">=NEW."coverageEndAt")
    AND NEW."assignmentEpochAt"=GREATEST(date_trunc('second',a."validFrom"),NEW."writerFrom")) THEN
    RAISE EXCEPTION 'Invalid state analytics room assignment' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM "NativeAnalyticsStateDay" d WHERE d."deviceId"=NEW."deviceId" AND d.id<>NEW.id
      AND d."coverageStartAt"<NEW."coverageEndAt" AND d."coverageEndAt">NEW."coverageStartAt")
    OR EXISTS(SELECT 1 FROM "NativeAnalyticsDay" d WHERE d."deviceId"=NEW."deviceId" AND d.kind='USAGE'
      AND d."coverageStartAt"<NEW."coverageEndAt" AND d."coverageEndAt">NEW."coverageStartAt") THEN
    RAISE EXCEPTION 'State analytics coverage cannot overlap' USING ERRCODE='23514';
  END IF;
  IF jsonb_typeof(NEW.hourly)<>'array' OR jsonb_array_length(NEW.hourly)>27 THEN RAISE EXCEPTION 'Invalid state hourly detail' USING ERRCODE='23514'; END IF;
  FOR hour IN SELECT value FROM jsonb_array_elements(NEW.hourly) LOOP
    SELECT array_agg(key ORDER BY key) INTO keys FROM jsonb_object_keys(hour) AS key;
    IF keys IS DISTINCT FROM ARRAY['coverageEndAt','coverageStartAt','durationsSeconds','hourStartAt'] THEN RAISE EXCEPTION 'Invalid hourly fields' USING ERRCODE='23514'; END IF;
    hour_start:=(hour->>'hourStartAt')::timestamptz AT TIME ZONE 'UTC';
    covered_start:=(hour->>'coverageStartAt')::timestamptz AT TIME ZONE 'UTC';
    covered_end:=(hour->>'coverageEndAt')::timestamptz AT TIME ZONE 'UTC';
    part_seconds:=EXTRACT(EPOCH FROM covered_end-covered_start);
    IF date_trunc('hour',hour_start)<>hour_start OR covered_start<GREATEST(hour_start,NEW."coverageStartAt")
      OR covered_end>LEAST(hour_start+interval '1 hour',NEW."coverageEndAt") OR covered_end<=covered_start
      OR EXTRACT(EPOCH FROM covered_end-covered_start)<>part_seconds
      OR NOT native_state_duration_valid(NEW."analyticsCategory",NEW.dimension,hour->'durationsSeconds',part_seconds) THEN
      RAISE EXCEPTION 'Invalid hourly coverage' USING ERRCODE='23514';
    END IF;
    total_seconds:=total_seconds+part_seconds;
  END LOOP;
  IF jsonb_array_length(NEW.hourly)>0 THEN
    IF total_seconds<>expected_seconds OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.hourly) a, jsonb_array_elements(NEW.hourly) b
      WHERE a.value->>'hourStartAt'<b.value->>'hourStartAt' AND (a.value->>'coverageEndAt')::timestamptz>(b.value->>'coverageStartAt')::timestamptz)
      OR (SELECT count(DISTINCT value->>'hourStartAt') FROM jsonb_array_elements(NEW.hourly))<>jsonb_array_length(NEW.hourly) THEN
      RAISE EXCEPTION 'Hourly state detail must partition coverage' USING ERRCODE='23514';
    END IF;
    FOR state_key IN SELECT jsonb_object_keys(NEW."durationsSeconds") LOOP
      SELECT sum((value->'durationsSeconds'->>state_key)::bigint) INTO hourly_total FROM jsonb_array_elements(NEW.hourly);
      IF hourly_total<>(NEW."durationsSeconds"->>state_key)::bigint THEN RAISE EXCEPTION 'Hourly state totals differ' USING ERRCODE='23514'; END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "NativeAnalyticsStateDay_guard" BEFORE INSERT OR UPDATE ON "NativeAnalyticsStateDay" FOR EACH ROW EXECUTE FUNCTION guard_native_analytics_state_day();

CREATE FUNCTION guard_binary_state_analytics_overlap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind='USAGE' THEN
    PERFORM id FROM "NativeDevice" WHERE id=NEW."deviceId" FOR UPDATE;
    IF EXISTS(SELECT 1 FROM "NativeAnalyticsStateDay" d WHERE d."deviceId"=NEW."deviceId"
      AND d."coverageStartAt"<NEW."coverageEndAt" AND d."coverageEndAt">NEW."coverageStartAt") THEN
      RAISE EXCEPTION 'Binary and state analytics coverage cannot overlap' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "NativeAnalyticsDay_state_overlap_guard" BEFORE INSERT OR UPDATE ON "NativeAnalyticsDay" FOR EACH ROW EXECUTE FUNCTION guard_binary_state_analytics_overlap();
REVOKE ALL ON "NativeAnalyticsStateDay" FROM PUBLIC;
REVOKE ALL ON FUNCTION native_state_duration_valid(text,text,jsonb,bigint),guard_native_analytics_state_day(),guard_binary_state_analytics_overlap() FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON "NativeAnalyticsStateDay" FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION native_state_duration_valid(text,text,jsonb,bigint),guard_native_analytics_state_day(),guard_binary_state_analytics_overlap() FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
