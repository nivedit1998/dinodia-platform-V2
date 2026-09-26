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

## Stage 1 asymmetric trust material

| Variable | Owner | Secret | Environments | Purpose | Rotation |
|---|---|---:|---|---|---|
| `COMPANY_PORTAL_SESSION_PRIVATE_KEY` | Platform | Yes | local/rc/production | Signs employee-only Company Portal sessions | Employee-session key rotation |
| `COMPANY_PORTAL_SESSION_PUBLIC_KEYS` | Dinodia OS/Platform | Yes | local/rc/production | Verifies employee sessions; may contain current and retiring public keys | Coordinated key rotation |
| `DINODIA_APP_SESSION_PRIVATE_KEY` | Platform | Yes | local/rc/production | Signs customer membership-scoped hub sessions and offline envelopes | App-session key rotation |
| `DINODIA_APP_PUBLIC_KEYS` | Dinodia OS/Platform | Yes | local/rc/production | Verifies customer tokens and Platform-signed offline grants | Coordinated key rotation |
| `OPERATOR_SESSION_PRIVATE_KEY` | Platform | Yes | local/rc/production | Signs bounded operator grants | Operator-session key rotation |
| `DINODIA_OPERATOR_PUBLIC_KEY` | Dinodia OS | Yes | local/rc/production | Verifies bounded operator grants locally | Coordinated key rotation |
| `MANUFACTURING_ROOT_PUBLIC_KEYS` | Platform | No | local/rc/production | Verifies genuine imaging/enrolment signatures | Manufacturing-root rotation with overlap |
| `MANUFACTURING_ENROLLMENT_OPERATOR_PUBLIC_KEYS` | Platform | No | local/rc/production | Verifies the separately authorised operator signature for manufacturing enrolment; never grants installer self-certification | Operator-key rotation with overlap and audit |
| `STAGE1_CONTRACT_SECRET` | Platform | Yes | local/test/rc only | Restricts the non-public Stage 1 contract harness | Replace before each RC |
| `COMPANY_PORTAL_INITIAL_CXO_BOOTSTRAP_SECRET` | Platform | Yes | Empty local/RC/Production ceremony only | One-use first-CXO ceremony when the employee table is empty | Disable and remove immediately after ceremony; never a normal login fallback |
| `COMPANY_PORTAL_INITIAL_CXO_EMAIL` | Platform/CXO owner | No | Ceremony only | Exact verified mailbox allowed to receive the first CXO invitation | Remove/lock after the first CXO is verified |
| `AWS_REGION` | Platform | No | Temporary ceremony configuration | SES region for the first-CXO invitation only; not an AWS backend | Remove after ceremony if no remaining mail consumer |
| `SES_FROM_EMAIL` | Platform | No | Temporary ceremony configuration | Verified SES sender for the first-CXO invitation only | Remove after ceremony if no remaining mail consumer |
| `AWS_ACCESS_KEY_ID` | Platform | Yes | Temporary ceremony credential | Narrow SES `SendEmail`-only IAM identity for the one-time first-CXO invitation | Revoke the access key after successful ceremony; never client-visible |
| `AWS_SECRET_ACCESS_KEY` | Platform | Yes | Temporary ceremony credential | Secret half of the narrow SES sender identity | Revoke with its access key after successful ceremony; never client-visible |
| `DINODIA_IDENTITY_BROKER_SOCKET` | Dinodia OS | No | local/rc/production | Root-owned `dinodia-identityd` Unix socket path | OS image configuration |

Supabase Vault must contain these named secrets for the optional Supabase-owned two-minute trigger. The values are never stored in the migration or this document:

| Vault secret name | Owner | Consumer | Rotation |
|---|---|---|---|
| `DINODIA_NATIVE_OPERATIONS_URL` | Platform | Supabase `pg_cron`/`pg_net` job | Change with the Vercel deployment URL |
| `DINODIA_NATIVE_OPERATIONS_CRON_SECRET` | Platform | Supabase job and `/api/cron/native-operations` | Rotate together with Vercel `CRON_SECRET` |

## Deployment metadata

| Variable | Owner | Secret | Environments | Purpose |
|---|---|---:|---|---|
| `FOUNDATION_SCHEMA_FINGERPRINT` | Platform | No | rc/production | Expected reviewed schema object fingerprint |
| `FOUNDATION_MIGRATION_CHECKSUM` | Platform | No | rc/production | Exact SHA-256 checksum of the deployed native baseline migration |
| `FOUNDATION_SOURCE_FINGERPRINT` | Platform | No | rc/production | Safe fingerprint of the intended source snapshot; health exposes only its short prefix |

## Rules

- No server secret may use `NEXT_PUBLIC_` or another client-visible prefix.
- The mobile app receives API/session credentials, never database credentials.
- The customer app receives only short-lived membership-scoped sessions; employee sessions and OS operator grants use separate keys and cookies.
- Dinodia OS private identity material remains on the hub.
- Phone private keys remain in iOS Keychain/Secure Enclave.
- AWS backend variables are not part of V2.
- Home Assistant credential variables are not part of native V2 runtime configuration.
- Empty, missing, malformed or old-project values must fail closed.
- Logs, error responses, browser storage and build output must not contain secret values.
- `COMPANY_PORTAL_INITIAL_CXO_BOOTSTRAP_SECRET` is never enabled after the
  first successful ceremony and is not a normal employee login fallback.
- The first-CXO ceremony has been used for the existing verified CXO. Confirm
  `consumedAt` using guarded read-only evidence, then remove the one-use
  bootstrap variables and revoke the dedicated SES key. Do not rerun bootstrap
  or delete/recreate the CXO account.

## Stage 1 dependency-advisory disposition

This is an evidence record, not a suppression list. Runtime production
dependencies must remain clean. Development/tooling findings are reviewed
separately because they are used by lint/build tooling and are not imported by
the deployed request handlers.

| Review date | Package path | Runtime reachable? | Decision | Owner | Follow-up |
|---|---|---:|---|---|---|
| 2026-09-22 | Prisma/Next development toolchain findings reported by `npm audit` | No runtime path proven; confirmed with `npm audit --omit=dev --omit=optional --audit-level=high` | Accept temporarily for local tooling only; do not downgrade Prisma blindly | Dinodia engineering | Re-run audit on every Stage 1 candidate and upgrade when a compatible patched Prisma/toolchain release is available |

The full audit output is intentionally not copied here because it can include
local package paths. The exact command and exit status belong in the Stage 1
engineering evidence report.

## Provisioning checklist

Before adding a variable to Vercel:

1. Identify its exact consumer in source.
2. Generate a fresh V2 value.
3. Record only its name and purpose here.
4. Set it in the new Vercel project/environment.
5. Validate presence and format without printing the value.
6. Record rotation and revocation ownership.

## Producer, consumer and storage ownership

This table is the implementation boundary for Stage 1. A variable must not be
copied to another component merely because the names look similar. The
consumer listed here is the only runtime that may read it.

| Variable or binding | Produced/created by | Consumed by | Stored in | Production rule |
|---|---|---|---|---|
| `DATABASE_URL` | Supabase connection settings | Vercel server-side Prisma runtime | Vercel encrypted Production environment | Fresh V2 project only; never bundled to clients or Dinodia OS |
| `DIRECT_URL` | Supabase connection settings | Prisma migration/administrative scripts | Vercel encrypted environment or local Keychain for guarded operator commands | Never print, commit or send to the hub |
| `SUPABASE_ANON_KEY` | Supabase Legacy anon key for the V2 project | Server/client integration where explicitly required | Vercel encrypted environment; client exposure only if a future route deliberately needs it | Must identify `fppzzesvukjbsfmxmfxe`; never use an old-project key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Legacy service-role key for the V2 project | Server-only Supabase integration | Vercel encrypted Production environment | Never expose to browser, iOS, hub, logs or evidence |
| `JWT_SECRET` | Dinodia operator-generated random value | Platform-native signing/compatibility code only | Vercel encrypted environment | Not a Supabase replacement; rotate deliberately and invalidate affected sessions |
| `PLATFORM_DATA_ENCRYPTION_KEY` | Dinodia operator-generated random value | Platform envelope/data encryption | Vercel encrypted environment | Key-versioned rotation; never put in Prisma or client config |
| `CLAIM_REFERENCE_PEPPER` | Dinodia operator-generated random value | Platform claim-reference hashing | Vercel encrypted environment | Replacement invalidates affected claim references by policy |
| `AUDIT_LOG_HASH_SALT` | Dinodia operator-generated random value | Platform audit redaction/hash code | Vercel encrypted environment | Never log or return the salt |
| `CRON_SECRET` | Dinodia operator-generated random value | Vercel cron endpoint and shared native-operations route | Vercel encrypted environment; Supabase Vault copy only when the Supabase job invokes the route | No secret-specific cron; shared dispatcher only |
| `NEXT_PUBLIC_APP_URL` | Dinodia release configuration | Next.js browser URL generation | Vercel config | Production must be `https://dinodia-platform-v2.vercel.app` |
| `SUPABASE_PROJECT_REF` | Supabase project metadata | Target guards and readiness checks | Value-free source metadata plus Vercel config | Must be `fppzzesvukjbsfmxmfxe` |
| `VERCEL_PROJECT_ID` | Vercel project metadata | Target guards and deployment checks | Value-free source metadata plus Vercel config | Must be the V2 project ID; never the old deployment |
| `COMPANY_PORTAL_SESSION_PRIVATE_KEY` | Dinodia key ceremony | Vercel employee-session signer | Vercel encrypted environment only | Never copied to OS, browser or iOS |
| `COMPANY_PORTAL_SESSION_PUBLIC_KEYS` | Matching Dinodia key ceremony | Platform and Company Portal verification | Vercel encrypted environment; public verification copy only where needed | Key rotation requires overlap and revocation evidence |
| `DINODIA_APP_SESSION_PRIVATE_KEY` | Dinodia key ceremony | Vercel customer hub-session signer | Vercel encrypted environment only | Never copied to browser or OS |
| `DINODIA_APP_PUBLIC_KEYS` | Matching Dinodia key ceremony | Platform and Dinodia OS verification | Vercel plus Dinodia OS secure configuration | Must contain only trusted V2 public keys |
| `OPERATOR_SESSION_PRIVATE_KEY` | Dinodia key ceremony | Vercel bounded operator-grant signer | Vercel encrypted environment only | Browser never receives the resulting OS bearer/grant |
| `DINODIA_OPERATOR_PUBLIC_KEY` | Matching operator key ceremony | Dinodia OS operator-grant verification | Dinodia OS secure configuration | Must match the V2 Platform key; rotate with session invalidation |
| `MANUFACTURING_ROOT_PUBLIC_KEYS` | Offline Dinodia manufacturing authority | Platform enrolment verifier and OS identity bootstrap verifier | Vercel plus OS trusted configuration | Public verification material only; never generate this from an installer |
| `MANUFACTURING_ENROLLMENT_OPERATOR_PUBLIC_KEYS` | Dinodia manufacturing authority | Platform manufacturing-enrolment script only | Vercel encrypted environment and guarded operator workstation | Separate operator authorisation; never copied to the hub, browser or customer app |
| `STAGE1_CONTRACT_SECRET` | Dinodia operator-generated random value | Non-public Stage 1 contract harness | Local/RC encrypted environment only | Do not enable public claim UI with it |
| `COMPANY_PORTAL_INITIAL_CXO_BOOTSTRAP_SECRET` | Dinodia operator-generated one-use value | Empty-database bootstrap route | Local/RC encrypted environment only | Delete/disable immediately after first CXO ceremony; never a login fallback |
| `DINODIA_PLATFORM_API_URL` | Dinodia release configuration | Dinodia OS outbound Platform client | Dinodia OS secure/local configuration | Production must be `https://dinodia-platform-v2.vercel.app` |
| `DINODIA_IDENTITY_BROKER_SOCKET` | OS image configuration | Dinodia OS identity broker client | Root-owned OS configuration | Must resolve to the root-owned protected Unix socket |
| `VERCEL_APP_ORIGIN` | Edge release configuration | V2 Cloudflare Worker | Wrangler vars, secret bypass separately in Wrangler secret storage | Must be `https://dinodia-platform-v2.vercel.app`; no fallback origin |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Vercel deployment-protection secret | RC edge Worker automation requests only | Wrangler secret storage | Never put in `wrangler.toml`, source, logs or browser responses |
| `DINODIA_NATIVE_OPERATIONS_URL` | Dinodia release configuration | Supabase `pg_net`/`pg_cron` dispatcher | Supabase Vault | Must call the canonical V2 origin |
| `DINODIA_NATIVE_OPERATIONS_CRON_SECRET` | Same ceremony as Vercel cron secret | Supabase dispatcher request | Supabase Vault | Must be rotated together with the accepted V2 cron secret |

### Explicitly retired production inputs

The following are not valid Native V2 production authority: HA usernames or
tokens, `DINODIA_ADMIN_TOKEN`, `DINODIA_PLATFORM_TOKEN`, pasted bootstrap
secrets, arbitrary Cloudflare tunnel tokens/hostnames, old Vercel origins,
AWS origins, or a reusable dashboard password. Compatibility source may remain
for development or later removal, but production configuration must ignore it
and the native route tests must prove rejection.

### Local-file rule

`.env.local` is an operator convenience for local testing only. It is not the
source of truth for Vercel, Supabase Vault, Cloudflare Wrangler or Dinodia OS.
When a value changes, update the owning encrypted store, redeploy/restart the
affected runtime, and verify the runtime without printing the value. Never
copy a Vercel secret into this document or into an app bundle.
