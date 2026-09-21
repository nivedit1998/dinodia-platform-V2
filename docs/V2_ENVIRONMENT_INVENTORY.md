# Native Dinodia V2 Environment Inventory

This document is a value-free contract. Secret values belong only in the new Vercel project, the Mac Keychain/password manager, or the Dinodia OS secure store. Never add a value here or to Git.

## Target identity

| Variable | Owner | Secret | Environments | Purpose |
|---|---|---:|---|---|
| `V2_ENVIRONMENT` | Platform | No | local/test/rc/production | Selects guarded runtime behavior |
| `SUPABASE_PROJECT_REF` | Platform | No | all | Must equal the approved V2 project reference |
| `VERCEL_PROJECT_ID` | Platform | No | rc/production | Prevents deployment to the old Vercel project |
| `DATABASE_URL` | Platform | Yes | local/test/rc/production | Prisma pooled/direct runtime connection |
| `DIRECT_URL` | Platform | Yes | local/test/rc/production | Prisma migration connection |
| `NEXT_PUBLIC_SUPABASE_URL` | Platform | No | local/test/rc/production | Safe Supabase project URL metadata; must identify V2 |
| `NEXT_PUBLIC_APP_URL` | Platform | No | local/test/rc/production | Browser/application origin |

## Native security values

| Variable | Owner | Secret | Required from | Rotation |
|---|---|---:|---|---|
| `JWT_SECRET` | Platform | Yes | Authentication stage | Deliberate session-key rotation |
| `PLATFORM_DATA_ENCRYPTION_KEY` | Platform | Yes | Native secret-storage stage | Key-versioned migration |
| `CLAIM_REFERENCE_PEPPER` | Platform | Yes | Claim stage | Emergency replacement only |
| `AUDIT_LOG_HASH_SALT` | Platform | Yes | Audit stage | Versioned rotation |
| `CRON_SECRET` | Platform | Yes | Shared dispatcher stage | Provider rotation |
| `SUPABASE_SERVICE_ROLE_KEY` | Platform | Yes | Server-only integration | Supabase rotation |
| `SUPABASE_ANON_KEY` | Platform | Yes in server config | Client/server integration | Supabase rotation |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Vercel | Yes | rc only when required | Vercel protection rotation |

## Deployment metadata

| Variable | Owner | Secret | Environments | Purpose |
|---|---|---:|---|---|
| `FOUNDATION_SCHEMA_FINGERPRINT` | Platform | No | rc/production | Expected reviewed schema object fingerprint |
| `FOUNDATION_MIGRATION_CHECKSUM` | Platform | No | rc/production | Exact SHA-256 checksum of the deployed native baseline migration |
| `FOUNDATION_SOURCE_FINGERPRINT` | Platform | No | rc/production | Safe fingerprint of the intended source snapshot; health exposes only its short prefix |

## Rules

- No server secret may use `NEXT_PUBLIC_` or another client-visible prefix.
- The mobile app receives API/session credentials, never database credentials.
- Dinodia OS private identity material remains on the hub.
- Phone private keys remain in iOS Keychain/Secure Enclave.
- AWS backend variables are not part of V2.
- Home Assistant credential variables are not part of native V2 runtime configuration.
- Empty, missing, malformed or old-project values must fail closed.
- Logs, error responses, browser storage and build output must not contain secret values.

## Provisioning checklist

Before adding a variable to Vercel:

1. Identify its exact consumer in source.
2. Generate a fresh V2 value.
3. Record only its name and purpose here.
4. Set it in the new Vercel project/environment.
5. Validate presence and format without printing the value.
6. Record rotation and revocation ownership.
