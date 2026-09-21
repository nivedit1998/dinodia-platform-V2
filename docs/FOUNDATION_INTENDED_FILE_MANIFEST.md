# Native V2 intended foundation file manifest

This manifest is reviewed before staging. It is not permission to commit or push.

## Add and retain as foundation source

- `.env.example` — value-free environment contract.
- `prisma/schema.prisma` — lean native schema with same-home integrity fields.
- `prisma/migrations/00000000000000_native_v2_lean_foundation/migration.sql` — single reviewed baseline including constraints, indexes, triggers and privacy grants.
- `prisma.config.ts` — secret-free Prisma generation configuration.
- `src/app/api/health/route.ts`.
- `src/app/api/readiness/route.ts`.
- `src/lib/foundation.ts`.
- `src/lib/foundationContracts.mjs`.
- `src/lib/runtimeDatabaseUrl.ts`.
- `src/lib/runtimeTarget.mjs`.
- Foundation tests under `test/`.
- Foundation guard/verification scripts under `scripts/`.
- `vercel.json`.
- `README.md`.
- `docs/V2_ENVIRONMENT_INVENTORY.md`.
- `docs/V2_FOUNDATION_STATUS.md`.
- `docs/NATIVE_V2_SCHEMA_OWNERSHIP.md`.
- This manifest.

## Keep modified foundation configuration

- `.gitignore`.
- `next.config.ts`.
- `package.json` and `package-lock.json`.
- `tsconfig.json`.
- `supabase/config.toml`.
- Existing safe logging, target and security-check scripts.

## Intentionally deleted

All inherited Home Assistant, old Alexa, transitional dashboard, legacy support, old authentication, old analytics, old automation and AWS-parity application routes/helpers remain deleted unless a later native stage adds a new implementation under an explicitly reviewed plan.

## Never include

- `.env.local`, `.env.preview`, `.env.production` or any real environment file.
- `.vercel`, `.supabase`, downloaded deployment metadata or Keychain exports.
- Database URLs, passwords, JWTs, peppers, encryption keys, cron secrets, bypass secrets or private keys.
- Database dumps, logs, crash reports or generated build directories.
