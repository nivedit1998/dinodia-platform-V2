-- Idempotently restore the exact former unconditional authenticated dispatch.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
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
  PERFORM cron.alter_job(j.jobid, command := former);
END $schedule$;
COMMIT;
