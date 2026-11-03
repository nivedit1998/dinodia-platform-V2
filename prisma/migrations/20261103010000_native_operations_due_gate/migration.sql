BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Build/release contract: scripts/native_operations_due_gate_contract.json.
-- No runtime instrumentation writes; uncertain work always dispatches.
-- Global due lookups need leading state/time indexes (existing indexes lead
-- with a Home, hub, account or credential purpose). Ordinary additive indexes;
-- parent must assess table sizes/lock budget before Production activation.
CREATE INDEX IF NOT EXISTS "HubCredentialVersion_due_rotation_idx"
  ON public."HubCredentialVersion" ("purpose", "state", "issuedAt");
CREATE INDEX IF NOT EXISTS "HubCredentialVersion_due_grace_idx"
  ON public."HubCredentialVersion" ("purpose", "state", "graceUntil");
CREATE INDEX IF NOT EXISTS "SupportSession_due_idx"
  ON public."SupportSession" ("status", "expiresAt");
CREATE INDEX IF NOT EXISTS "SupportAccessRequest_due_idx"
  ON public."SupportAccessRequest" ("status", "codeExpiresAt");
CREATE INDEX IF NOT EXISTS "HomeClaimReservation_due_idx"
  ON public."HomeClaimReservation" ("state", "expiresAt");
CREATE INDEX IF NOT EXISTS "AlexaNativeLink_due_idx"
  ON public."AlexaNativeLink" ("status", "autoScope", "revokedAt");
CREATE INDEX IF NOT EXISTS "NativeNotificationDeliveryReceipt_status_deliverAfter_idx"
  ON public."NativeNotificationDeliveryReceipt" ("status", "deliverAfter");

CREATE OR REPLACE FUNCTION public.native_operations_work_due(p_now timestamptz DEFAULT statement_timestamp())
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog
AS $gate$
DECLARE
  -- Prisma DateTime columns are timestamp(3) WITHOUT time zone, storing UTC.
  utc_now timestamp := timezone('UTC', p_now);
  r record;
  candidates integer;
  expected constant text[] := ARRAY['operator_credential_lifecycle', 'support_expiry_and_revocation', 'claim_reservation_expiry'];
BEGIN
  IF p_now IS NULL OR NOT isfinite(p_now) THEN RETURN true; END IF;
  -- Include expected ids even if somebody assigned them to another dispatcher.
  SELECT count(*) INTO candidates FROM public."NativeBackgroundTaskState"
    WHERE "dispatcher" = 'OPERATIONS' OR "taskId" = ANY(expected);
  IF candidates <> 3 THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public."NativeBackgroundTaskState"
    WHERE ("dispatcher" = 'OPERATIONS' OR "taskId" = ANY(expected))
      AND ("dispatcher" <> 'OPERATIONS' OR NOT ("taskId" = ANY(expected))
        OR "consecutiveFailures" <> 0
        OR ("lastOutcome" IS NOT NULL AND ("lastOutcome"->>'status') IS DISTINCT FROM 'SUCCEEDED')))
    THEN RETURN true; END IF;
  -- Do not trust nextDueAt or suppress work under a lease. The endpoint's
  -- existing serializable lease remains the sole duplicate-effects authority.
  IF EXISTS (SELECT 1 FROM public."HubCredentialVersion"
    WHERE "purpose" = 'operator-credential' AND "state" = 'GRACE' AND "graceUntil" <= utc_now)
    THEN RETURN true; END IF;
  candidates := 0;
  FOR r IN SELECT "hubInstallationId" FROM public."HubCredentialVersion"
    WHERE "purpose" = 'operator-credential' AND "state" = 'ACTIVE'
      AND "issuedAt" <= utc_now - interval '1 hour' LIMIT 1001
  LOOP
    candidates := candidates + 1;
    IF candidates > 1000 THEN RETURN true; END IF;
    IF NOT EXISTS (SELECT 1 FROM public."HubCredentialVersion"
      WHERE "hubInstallationId" = r."hubInstallationId" AND "purpose" = 'operator-credential'
        AND "state" IN ('PENDING', 'DELIVERED', 'ACKNOWLEDGED')) THEN RETURN true; END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public."SupportSession" WHERE "status" = 'ACTIVE' AND "expiresAt" <= utc_now)
    THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public."SupportAccessRequest"
    WHERE "status" IN ('REQUESTED', 'APPROVED', 'ISSUED') AND "codeExpiresAt" <= utc_now)
    THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public."HomeClaimReservation" WHERE "state" = 'ACTIVE' AND "expiresAt" <= utc_now)
    THEN RETURN true; END IF;
  -- Discovery reconciles dynamic authorities, even without queued reports.
  -- Environment/provider enablement is intentionally not inferred in SQL.
  IF EXISTS (SELECT 1 FROM public."AlexaNativeLink"
    WHERE "status" = 'ACTIVE' AND "revokedAt" IS NULL AND "autoScope") THEN RETURN true; END IF;

  -- The existing (state,nextAttemptAt) index bounds both state probes. Never
  -- prove unknown absence by walking an arbitrarily large queue.
  IF EXISTS (SELECT 1 FROM public."NativeDomainOutbox" WHERE "state" = 'PROCESSING') THEN RETURN true; END IF;
  candidates := 0;
  FOR r IN SELECT "aggregateType", "eventType", "nextAttemptAt", "expiresAt", "attempts"
    FROM public."NativeDomainOutbox" WHERE "state" = 'PENDING' LIMIT 1001
  LOOP
    candidates := candidates + 1;
    IF candidates > 1000 THEN RETURN true; END IF;
    IF (r."aggregateType" = 'HomeClaimReference' AND r."eventType" = 'installation_complete')
      OR (r."aggregateType" = 'NativeDevice' AND r."eventType" IN ('PROPERTY_DEVICE_COMMISSIONED', 'PROPERTY_DEVICE_ADOPTED'))
      THEN CONTINUE; -- Retained domain signals; no operations consumer.
    ELSIF r."aggregateType" = 'PermanentDeviceInstallationRequest'
      AND r."eventType" IN ('INSTALLATION_REQUEST_EMAIL', 'INSTALLATION_REQUEST_COMPLETED') THEN
      -- Expired/exhausted PENDING rows are NOT processed by this handler.
      IF r."nextAttemptAt" <= utc_now AND r."expiresAt" > utc_now AND r."attempts" < 12 THEN RETURN true; END IF;
    ELSIF r."aggregateType" = 'HomeownerAccessRemovalNotice'
      AND r."eventType" = 'TENANT_AUTOMATION_MANAGEMENT_NOTICE' THEN RETURN true;
    ELSIF r."aggregateType" = 'HomeownerAccessRemovalNotice'
      AND r."eventType" IN ('TENANT_ACCESS_REMOVAL_NOTICE', 'PROPERTY_MANAGER_ACCESS_REMOVAL_NOTICE', 'OWNERSHIP_TRANSFER_NOTICE', 'HOME_DEREGISTRATION_NOTICE', 'ROOM_ACCESS_REQUEST_NOTICE', 'ROOM_ACCESS_APPROVED_NOTICE', 'ROOM_ACCESS_DECLINED_NOTICE', 'ALEXA_LINKED_NOTICE', 'NEW_DEVICES_NOTICE', 'MFA_ENABLED_NOTICE', 'MFA_DISABLED_NOTICE', 'MEMBERSHIP_INVITATION_ACCEPTED_NOTICE', 'MEMBERSHIP_INVITATION_DECLINED_NOTICE') THEN
      IF r."expiresAt" <= utc_now THEN RETURN true; END IF;
      IF r."nextAttemptAt" <= utc_now AND r."attempts" < 8 THEN RETURN true; END IF;
    ELSIF r."aggregateType" = 'FullHomeDeregistrationAccountCleanup' AND r."eventType" = 'FULL_HOME_ACCOUNT_CLEANUP' THEN
      IF r."expiresAt" <= utc_now THEN RETURN true; END IF;
      IF r."attempts" >= 8 THEN RETURN true; END IF;
      IF r."nextAttemptAt" <= utc_now THEN RETURN true; END IF;
    ELSIF r."aggregateType" = 'AlexaChangeReport' AND r."eventType" = 'ALEXA_CHANGE_REPORT' THEN
      -- ChangeReport's outer candidate query excludes expired rows.
      IF r."nextAttemptAt" <= utc_now AND r."expiresAt" > utc_now THEN RETURN true; END IF;
    ELSIF r."aggregateType" = 'AlexaAccountRemoval' AND r."eventType" = 'ALEXA_ACCOUNT_REMOVAL_REPORT' THEN
      IF r."expiresAt" <= utc_now THEN RETURN true; END IF;
      IF r."nextAttemptAt" <= utc_now THEN RETURN true; END IF;
    ELSE RETURN true;
    END IF;
  END LOOP;
  candidates := 0;
  FOR r IN SELECT "family", "channel", "deliverAfter", "expiresAt", "attemptCount", "idempotencyKey"
    FROM public."NativeNotificationDeliveryReceipt" WHERE "status" = 'PENDING' LIMIT 1001
  LOOP
    candidates := candidates + 1;
    IF candidates > 1000 THEN RETURN true; END IF;
    -- Suppression is unconditional, including future/expired/exhausted rows.
    IF r."family" = 'TENANT_AUTOMATION_FAILURE' AND r."channel" = 'PUSH' THEN RETURN true;
    ELSIF r."family" = 'OWNER_INSTALLATION_UPDATE' AND r."channel" IN ('EMAIL', 'PUSH')
      AND r."idempotencyKey" LIKE 'installation-request:%' THEN
      IF r."deliverAfter" <= utc_now AND r."expiresAt" > utc_now AND r."attemptCount" < 8 THEN RETURN true; END IF;
    ELSE RETURN true;
    END IF;
  END LOOP;
  RETURN false;
EXCEPTION WHEN OTHERS OR query_canceled OR assert_failure THEN
  -- Missing tables/columns/types/permissions and predicate uncertainty must
  -- preserve the former unconditional dispatch. Do not log private row data.
  RETURN true;
END $gate$;

CREATE OR REPLACE FUNCTION public.dispatch_native_operations_if_due()
RETURNS void LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog
AS $dispatch$
DECLARE due boolean;
BEGIN
  BEGIN
    due := public.native_operations_work_due();
  EXCEPTION WHEN OTHERS OR query_canceled OR assert_failure THEN
    due := true;
  END;
  IF COALESCE(due, true) THEN
    -- Exact original authenticated Vault/net semantics, evaluated only here.
    PERFORM net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'DINODIA_NATIVE_OPERATIONS_URL'),
        headers := jsonb_build_object(
          'content-type', 'application/json',
          'authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'DINODIA_NATIVE_OPERATIONS_CRON_SECRET')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 8000
      );
  END IF;
END $dispatch$;

REVOKE ALL ON FUNCTION public.native_operations_work_due(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dispatch_native_operations_if_due() FROM PUBLIC;
DO $permissions$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.native_operations_work_due(timestamptz) FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION public.dispatch_native_operations_if_due() FROM %I', role_name);
    END IF;
  END LOOP;
END $permissions$;
ALTER FUNCTION public.native_operations_work_due(timestamptz) OWNER TO postgres;
ALTER FUNCTION public.dispatch_native_operations_if_due() OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.native_operations_work_due(timestamptz) TO postgres;
GRANT EXECUTE ON FUNCTION public.dispatch_native_operations_if_due() TO postgres;

-- No extension installation, scheduling, unscheduling, or job recreation.
DO $schedule$
DECLARE
  j record;
  job_count integer;
  former constant text := $former$SELECT net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'DINODIA_NATIVE_OPERATIONS_URL'),
        headers := jsonb_build_object(
          'content-type', 'application/json',
          'authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'DINODIA_NATIVE_OPERATIONS_CRON_SECRET')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 8000
      )$former$;
  candidate constant text := 'SELECT public.dispatch_native_operations_if_due();';
BEGIN
  IF to_regclass('cron.job') IS NULL THEN RETURN; END IF;
  -- Managed Supabase exposes the catalog read-only; serialize cooperating
  -- releases without requiring UPDATE/LOCK privileges. alter_job owns its row lock.
  PERFORM pg_catalog.pg_advisory_xact_lock(6804, 1);
  SELECT count(*) INTO job_count FROM cron.job WHERE jobname = 'dinodia-native-operations';
  IF job_count = 0 THEN RETURN; END IF;
  IF job_count <> 1 THEN RAISE EXCEPTION 'native operations requires exactly one existing cron job'; END IF;
  SELECT * INTO STRICT j FROM cron.job WHERE jobname = 'dinodia-native-operations';
  IF j.schedule IS DISTINCT FROM '*/2 * * * *' OR j.username IS DISTINCT FROM 'postgres'
    OR j.database IS DISTINCT FROM current_database()
    OR (j.command IS DISTINCT FROM former AND j.command IS DISTINCT FROM candidate) THEN
    RAISE EXCEPTION 'native operations cron identity/schedule/command mismatch';
  END IF;
  -- Omitted schedule/active/username/database preserve the exact former values.
  PERFORM cron.alter_job(j.jobid, command := candidate);
END $schedule$;

COMMIT;
