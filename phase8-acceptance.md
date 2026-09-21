<!-- Native Dinodia V2 foundation acceptance runbook. The former Home Assistant Phase 8 runbook is retired. -->
# Native Dinodia V2 foundation acceptance

This runbook covers only the clean foundation. Authentication, claims, support, devices, analytics, automations and Alexa are later Native V2 stages and are not accepted by this document.

## Preconditions

- The repository is the intended Native V2 source snapshot.
- The target guard identifies only Supabase project `fppzzesvukjbsfmxmfxe` and Vercel project `dinodia-platform-v2`.
- No Production deployment or old backend is in scope.
- Local secrets are supplied through Keychain or hidden input and never recorded.

## Local acceptance

Run against two independent empty Docker PostgreSQL databases:

```bash
npm ci
npx prisma validate
npx prisma generate
npm run check:foundation
npm run check:foundation:manifest
npm run test:foundation
npm run test:foundation:invariants
npm run clean-clone:check
npm run lint
npm run typecheck
npm test
npm run build
```

Each database must apply `prisma/migrations/00000000000000_native_v2_lean_foundation/migration.sql`, pass the transactional integrity tests, and produce the same schema fingerprint. A second migration deployment must report no pending migrations.

## Preview acceptance

Deploy Preview only. Verify:

- `/api/health` returns 200 without requiring database access;
- `/api/readiness` returns generic 503 until the exact V2 baseline and checksum are present;
- after the guarded reset and baseline migration, `/api/readiness` returns 200;
- unknown routes return the application 404;
- no response exposes a secret, database URL, credential, password or schema detail;
- deployment protection and the approved Vercel project/team remain intact;
- Vercel Production and old resources remain untouched.

## Foundation database acceptance

The remote database is accepted only when a redacted report proves:

- only the authorised V2 project was reset;
- 32 native application tables plus `_prisma_migrations` exist;
- the single native migration is complete and has the checked-in checksum;
- every application table is empty;
- no legacy HA/AWS/transitional table remains;
- no direct `anon` or `authenticated` table grant remains;
- the remote fingerprint equals both Docker fingerprints.

## Not accepted here

This foundation acceptance does not claim any numbered Native V2 product stage is complete. The later plans must add their own routes, UI, data contracts, tests and user acceptance on top of this foundation without recreating duplicate home, membership, area or device authority.
