<!-- Native Dinodia V2 foundation security runbook. This is not a Home Assistant or legacy-schema procedure. -->
# Native Dinodia V2 foundation security checklist

This repository is the V2 Vercel backend. The only active data target is the authorised fresh Supabase project identified by `SUPABASE_PROJECT_REF`. AWS, Home Assistant credentials, legacy runtime roles and old deployment targets are outside this repository’s foundation boundary.

## Before any database-connected command

- Use a disposable Docker PostgreSQL database for local validation.
- Set `V2_ENVIRONMENT=local` or `V2_ENVIRONMENT=rc`; never use `production` with the guarded scripts.
- Provide `DATABASE_URL` and `DIRECT_URL` only through a local secret store or hidden prompt.
- Run `npm run db:validate-target` before Prisma migration, reset or metadata commands.
- For remote reset/migration, require both exact confirmation strings and the exact V2 project metadata. Never target an old project.

## Foundation verification

Run the complete local gate:

```bash
npm ci
npx prisma validate
npx prisma generate
npm run check:foundation
npm run check:security
npm run check:logs
npm run test:foundation
npm run test:foundation:invariants
npm run clean-clone:check
npm run lint
npm run typecheck
npm test
npm run build
```

The database checks must prove:

- exactly 32 native application tables plus `_prisma_migrations`;
- one completed `00000000000000_native_v2_lean_foundation` migration;
- no application rows in a fresh foundation database;
- no direct `anon` or `authenticated` table grants;
- identical schema fingerprints in two independent Docker databases;
- PostgreSQL rejection of cross-home relationships, invalid tenant ownership and invalid invitation/request state.

## Secret and target rules

- Never commit `.env.local`, Preview downloads, database URLs, Supabase keys, JWTs, peppers, encryption keys, cron secrets, Vercel bypass values or private keys.
- `DATABASE_URL` and `DIRECT_URL` must resolve to the same authorised V2 project and database.
- Server-only keys must never use `NEXT_PUBLIC_` names.
- `/api/health` is database-independent; `/api/readiness` fails closed with a generic 503 when target configuration, migration checksum or database state is not correct.
- No endpoint may return connection strings, secret fragments, SQL errors or schema details.

## Privilege and schema boundary

The checked-in native migration owns the foundation privilege posture. Do not run the deleted legacy `scripts/supabase_privacy_hardening.sql` or create legacy runtime/migration roles from this repository. Review grants only through the guarded metadata checks and the migration’s explicit `REVOKE` statements.

## Preview release gate

Before a Preview is considered valid:

1. Verify the linked Vercel project and team IDs.
2. Verify Preview variable names and scopes with `vercel env ls`; do not print values.
3. Deploy without `--prod`.
4. Verify health, readiness, application 404 and deployment protection.
5. Confirm readiness uses the exact checked-in migration checksum and reviewed schema result.
6. Confirm Production and all old resources remain untouched.

## Incident response

If a target guard, schema fingerprint, grant check, secret scan or fail-closed endpoint check fails:

- stop before mutation or deployment;
- preserve redacted command output and hashes only;
- do not bypass the guard or edit the database manually;
- correct the source/configuration, rerun both Docker proofs and obtain independent review.
