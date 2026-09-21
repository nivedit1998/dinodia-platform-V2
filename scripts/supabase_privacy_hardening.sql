-- Phase 7: Supabase visibility lockdown
-- Run with a database owner/superuser account against staging first, then production.
-- Example:
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f scripts/supabase_privacy_hardening.sql

BEGIN;

-- Group roles (no direct login) used by application credentials.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dinodia_runtime_role') THEN
    CREATE ROLE dinodia_runtime_role NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dinodia_migration_role') THEN
    CREATE ROLE dinodia_migration_role NOLOGIN;
  END IF;
END $$;

COMMENT ON ROLE dinodia_runtime_role IS 'Least-privilege runtime role for Dinodia app traffic.';
COMMENT ON ROLE dinodia_migration_role IS 'Elevated role for controlled Prisma migrations only.';

-- Remove broad default grants.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', role_name);
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I', role_name);
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM %I', role_name);
    END IF;
  END LOOP;
END $$;

-- Runtime role: application DML only.
GRANT USAGE ON SCHEMA public TO dinodia_runtime_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dinodia_runtime_role;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO dinodia_runtime_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO dinodia_runtime_role;

-- Migration role: schema + migration operations.
GRANT USAGE, CREATE ON SCHEMA public TO dinodia_migration_role;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO dinodia_migration_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO dinodia_migration_role;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO dinodia_migration_role;

-- Default privileges for objects created by the current schema owner.
DO $$
DECLARE
  owner_name text := current_user;
  role_name text;
BEGIN
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC', owner_name);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC', owner_name);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC', owner_name);

  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM %I', owner_name, role_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', owner_name, role_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', owner_name, role_name);
    END IF;
  END LOOP;

  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dinodia_runtime_role', owner_name);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO dinodia_runtime_role', owner_name);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO dinodia_runtime_role', owner_name);

  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT ALL ON TABLES TO dinodia_migration_role', owner_name);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT ALL ON SEQUENCES TO dinodia_migration_role', owner_name);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT ALL ON FUNCTIONS TO dinodia_migration_role', owner_name);
END $$;

-- Break-glass audit objects.
CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE IF NOT EXISTS audit.break_glass_access_log (
  id BIGSERIAL PRIMARY KEY,
  actor TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  reviewed_by TEXT,
  notes TEXT
);

ALTER TABLE audit.break_glass_access_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS break_glass_migration_only ON audit.break_glass_access_log;
CREATE POLICY break_glass_migration_only
ON audit.break_glass_access_log
FOR ALL
TO dinodia_migration_role
USING (true)
WITH CHECK (true);

CREATE OR REPLACE FUNCTION audit.log_break_glass_access(
  p_actor TEXT,
  p_ticket_id TEXT,
  p_reason TEXT,
  p_notes TEXT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_id BIGINT;
BEGIN
  INSERT INTO audit.break_glass_access_log (actor, ticket_id, reason, notes)
  VALUES (p_actor, p_ticket_id, p_reason, p_notes)
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

REVOKE ALL ON SCHEMA audit FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA audit FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA audit FROM PUBLIC;
GRANT USAGE ON SCHEMA audit TO dinodia_migration_role;
GRANT SELECT, INSERT, UPDATE ON audit.break_glass_access_log TO dinodia_migration_role;
GRANT EXECUTE ON FUNCTION audit.log_break_glass_access(TEXT, TEXT, TEXT, TEXT) TO dinodia_migration_role;

-- Enable pgaudit when extension is available.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pgaudit') THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS pgaudit;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'pgaudit extension is available but this role cannot install it.';
    END;
  ELSE
    RAISE NOTICE 'pgaudit extension is not available in this Postgres environment.';
  END IF;
END $$;

DO $$
BEGIN
  BEGIN
    EXECUTE 'ALTER ROLE dinodia_runtime_role SET "pgaudit.log" = ''read,write''';
    EXECUTE 'ALTER ROLE dinodia_migration_role SET "pgaudit.log" = ''ddl,role''';
  EXCEPTION
    WHEN insufficient_privilege OR undefined_object OR invalid_parameter_value THEN
      RAISE NOTICE 'Unable to set pgaudit role parameters in this environment.';
  END;
END $$;

COMMIT;

-- Optional Phase 1+ (manual): enable RLS on sensitive Alexa linkage tables.
-- Note: If your runtime login role has BYPASSRLS enabled, RLS policies are bypassed.
-- These policies are still useful if you later remove BYPASSRLS and want defense-in-depth.
--
-- Run (as owner/superuser) after Prisma migrations have created the tables:
--   ALTER TABLE public."AlexaSkillUserLink" ENABLE ROW LEVEL SECURITY;
--   DROP POLICY IF EXISTS alexa_skill_user_link_runtime ON public."AlexaSkillUserLink";
--   DROP POLICY IF EXISTS alexa_skill_user_link_migration ON public."AlexaSkillUserLink";
--   CREATE POLICY alexa_skill_user_link_runtime ON public."AlexaSkillUserLink" FOR ALL TO dinodia_runtime_role USING (true) WITH CHECK (true);
--   CREATE POLICY alexa_skill_user_link_migration ON public."AlexaSkillUserLink" FOR ALL TO dinodia_migration_role USING (true) WITH CHECK (true);

-- Post-run (manual, outside this file):
--   1) Create dedicated LOGIN users and grant group roles:
--      CREATE ROLE dinodia_runtime_login LOGIN PASSWORD '...';
--      CREATE ROLE dinodia_migration_login LOGIN PASSWORD '...';
--      GRANT dinodia_runtime_role TO dinodia_runtime_login;
--      GRANT dinodia_migration_role TO dinodia_migration_login;
--      ALTER ROLE dinodia_runtime_login BYPASSRLS;
--      ALTER ROLE dinodia_migration_login BYPASSRLS;
--   2) Rotate app secrets so:
--      DATABASE_URL uses dinodia_runtime_login
--      DIRECT_URL uses dinodia_migration_login
