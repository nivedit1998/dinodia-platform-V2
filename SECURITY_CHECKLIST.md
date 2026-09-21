<!-- Architecture: Active Dinodia module SECURITY_CHECKLIST.md; document its role here while preserving the existing runtime and cross-repository contracts. -->
# Security Checklist — Phase 7 Supabase Visibility Lockdown

Use this runbook for the `dinodia-platform` repository.

## 1) Pre-deployment checks
- Confirm the latest app code is deployed to staging first.
- Confirm you have a privileged DB account for one-time hardening execution.
- Confirm a ticket/change request exists for this operation.

## 2) Apply SQL hardening
Run from this repository root:

```bash
cd dinodia-platform
psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f scripts/supabase_privacy_hardening.sql
```

This script:
- creates `dinodia_runtime_role` and `dinodia_migration_role`,
- revokes broad grants from `PUBLIC` and Supabase API roles (`anon`, `authenticated` when present),
- grants least-privilege runtime access and elevated migration-only access,
- creates `audit.break_glass_access_log`,
- enables/configures `pgaudit` when available.

## 3) Create dedicated login users (once)
Run in SQL editor or `psql` after the hardening script:

```sql
CREATE ROLE dinodia_runtime_login LOGIN PASSWORD '<strong-runtime-password>';
CREATE ROLE dinodia_migration_login LOGIN PASSWORD '<strong-migration-password>';
GRANT dinodia_runtime_role TO dinodia_runtime_login;
GRANT dinodia_migration_role TO dinodia_migration_login;
ALTER ROLE dinodia_runtime_login BYPASSRLS;
ALTER ROLE dinodia_migration_login BYPASSRLS;
```

## 4) Rotate app DB credentials
Update deployment secrets so:
- `DATABASE_URL` uses `dinodia_runtime_login`
- `DIRECT_URL` uses `dinodia_migration_login`

Then run deploy-time checks from this repository:

```bash
cd dinodia-platform
npm run prisma:deploy
npm run lint
npm run build
```

## 5) Restrict Supabase production visibility
- Keep SQL Editor access limited to security/on-call maintainers.
- Keep backup export/log access limited to security/on-call maintainers.
- Remove unnecessary Project Owner/Admin memberships.

## 6) Break-glass direct SQL workflow (required)
Before any direct production data query:
1. Open ticket with reason and approval.
2. Log access start:

```sql
SELECT audit.log_break_glass_access(
  '<actor-email>',
  '<ticket-id>',
  '<reason>',
  'start'
);
```

3. Run minimal scoped query set.
4. Update completion in `audit.break_glass_access_log` with reviewer + notes.

## 7) Post-change verification queries
```sql
SELECT grantee, table_name, privilege_type
FROM information_schema.table_privileges
WHERE table_schema = 'public'
  AND grantee IN ('PUBLIC', 'anon', 'authenticated', 'dinodia_runtime_role', 'dinodia_migration_role')
ORDER BY grantee, table_name, privilege_type;
```

Expected:
- `PUBLIC`, `anon`, `authenticated` should not retain broad table privileges.
- `dinodia_runtime_role` should have DML-only access.
- `dinodia_migration_role` should have migration privileges.
