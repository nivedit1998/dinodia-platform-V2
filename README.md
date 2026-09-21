# Dinodia Platform V2

This repository is the sole Vercel backend and frontend for the new native Dinodia V2 stack. It uses the fresh `dinodia-native-v2` Supabase project and is not connected to the old deployment, old database, AWS backend or Home Assistant customer runtime.

## Active topology

```text
Dinodia OS / iOS V2 / Company Portal
                    |
                    v
      dinodia-edge-worker-V2 (optional edge ingress)
                    |
                    v
          Vercel: dinodia-platform-v2
                    |
                    v
          Supabase: dinodia-native-v2
```

The V2 project is linked locally through `.vercel/project.json` and guarded by `scripts/assert_v2_target.mjs`. The local Supabase link is project metadata only; application code must use the server-side Prisma connection and must never ship database credentials to a client.

## Local setup

1. Confirm Node/npm and Docker Desktop are installed.
2. Install dependencies with `npm ci`; Prisma generation does not require a live database.
3. Copy `.env.example` to `.env.local` only when local database/runtime work begins and replace the local placeholders.
4. Set `V2_ENVIRONMENT=local`.
5. Start a disposable local PostgreSQL database with `npm run db:local:up`.
6. Run `npm run db:validate-target` before any Prisma command that connects to a database.
7. Run `npm run db:migrate:local`, `npm run test:foundation` and `npm run test:foundation:invariants`.
8. Run `npm run lint`, `npm run typecheck` and `npm run build`.

Never copy `.env.local`, downloaded Vercel variables, Supabase link credentials, private keys or database dumps into Git.

## Guarded database commands

The local migration entry point is guarded:

```bash
V2_ENVIRONMENT=local \
DATABASE_URL=postgresql://... \
DIRECT_URL=postgresql://... \
npm run db:migrate:local
```

For the fresh RC project, use only the guarded destructive wrapper after Docker proof and explicit operator confirmation:

```bash
V2_ENVIRONMENT=rc \
V2_ALLOW_REMOTE_RESET=I_UNDERSTAND_FRESH_V2_PROJECT_fppzzesvukjbsfmxmfxe \
npm run db:reset:rc
```

The guard identifies the exact V2 project (including pooler tenant identity), requires the V2 Vercel link for remote work and rejects old or unknown targets before Prisma runs.

The first clean V2 baseline is:

```text
prisma/migrations/00000000000000_native_v2_lean_foundation/
```

It was generated from the V2 schema and applied only to the fresh Supabase project. No old customer rows or old migration history were imported.

## Development boundary

This repository currently exposes only the native foundation status surface and the two readiness routes. Home Assistant, old Alexa, support, commissioning, analytics and automation journeys are intentionally absent from the active Next.js build. They are introduced later from the rewritten Native V2 stage plans and must not be copied back as transitional routes.

## Environment

See [the value-free environment inventory](docs/V2_ENVIRONMENT_INVENTORY.md). Secret values are stored only in the new Vercel project, the Mac Keychain/password manager, or Dinodia OS secure storage. V2 has no AWS backend, fallback deployment or Home Assistant runtime.

## Clean source proof

`npm run clean-clone:check` reconstructs the explicit intended foundation source snapshot in a temporary directory, verifies that local credentials and deployment metadata are absent, installs dependencies, applies the native schema to disposable PostgreSQL and runs the complete local validation gate. It must pass before a commit or Preview deployment is considered reproducible.
