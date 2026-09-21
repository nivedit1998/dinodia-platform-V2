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

1. Install dependencies with `npm ci`.
2. Copy `.env.example` to `.env.local` and supply only local/test values.
3. Set `V2_ENVIRONMENT=local`.
4. Use a disposable local PostgreSQL database for destructive tests.
5. Run `npm run foundation:target` before Prisma commands.
6. Run `npm run lint` and `npm run build`.

Never copy `.env.local`, downloaded Vercel variables, Supabase link credentials, private keys or database dumps into Git.

## Guarded database commands

The normal migration entry point is guarded:

```bash
V2_ENVIRONMENT=rc \
V2_ALLOW_REMOTE_MIGRATION=I_UNDERSTAND_NEW_V2_DATABASE \
npm run prisma:deploy
```

The guard verifies the approved V2 Supabase project reference, the V2 Vercel project link, matching database hosts and the explicit remote-migration confirmation. It rejects old or unknown targets before Prisma runs.

The first clean V2 baseline is:

```text
prisma/migrations/00000000000000_native_v2_foundation/
```

It was generated from the V2 schema and applied only to the fresh Supabase project. No old customer rows or old migration history were imported.

## Development boundary

The imported application framework still contains transitional compatibility code that will be replaced by the fourteen native implementation stages. Do not treat Home Assistant-compatible routes, old Alexa flows or legacy support paths as native V2 authority. New native work must use the contracts defined in `Code Planning/Dinodia OS Migration` and must not add a second backend.

## Environment

See [the value-free environment inventory](docs/V2_ENVIRONMENT_INVENTORY.md). Secret values are stored only in the new Vercel project, the Mac Keychain/password manager, or Dinodia OS secure storage.
