# Stage 1 release-candidate readiness

Updated 2026-09-26. This is a value-free evidence/runbook record. The reviewed
R11 Platform candidate is deployed to the canonical Production alias; the new
OS package is staged on the existing Pi but its guarded installer has not yet
been run. Stage 1 remains incomplete.

## Canonical topology and current baseline

- Production Platform origin: `https://dinodia-platform-v2.vercel.app` only.
- Vercel project: `dinodia-supabase/dinodia-platform-v2` (V2 project link and
  target guards must match the approved project IDs before a deployment).
- Supabase: `dinodia-native-v2`, reference `fppzzesvukjbsfmxmfxe`, region
  `eu-west-2`; this Stage 1 cycle must never reset or delete its data.
- Cloudflare uses the existing V2 Worker and existing named tunnel
  `dinodia-din-home-001` with its already verified company hostname. The RC
  Worker has no public customer route and proxies only to canonical Vercel V2.
  No Worker redeploy is warranted for a comment-only `wrangler.toml` edit.
- Scheduled work remains exactly one Supabase two-minute native-operations
  job and one daily Vercel `native-maintenance` cron; Edge has no schedule.
- Read-only checks after R11 deployment on 2026-09-26: canonical Vercel `/`,
  `/api/health` and `/api/readiness` returned 200; an unknown route returned
  404; unauthenticated `/api/installer/workflows` returned 401. Vercel
  deployment `dpl_5ZHziTkyXjykfNqmzXNpKxFQRaf4` is Ready and aliased to the
  canonical origin. The previous Ready deployment `dpl_33F8xEAGdAqBU8UxbPeQXT76fmk3`
  is retained for rollback. Existing CloudURL `/api/health` and `/setup.js`
  returned 200 before the new OS package was installed.
- Immediately before preparing the new package, Pi `192.168.1.76` reported
  `mode=native-v2`, build `native-v2-e40b81df300b7a57dfcc010d`; both
  `dinodia-os` and `dinodia-identityd` were active. The existing identity
  directory was not modified. The reviewed OS source commit is
  `d0fe632cc791168c83302620e38f44f5e89da010`; its transferred source archive
  SHA-256 is `d44c642a5ea230e1b9df11bf2b131315ef40bf1d91e1b9d0615b3578bf53c614`.
  The package is staged at `/tmp/dinodia-os-stage1-d0fe632` on the Pi; the
  atomic installer and post-install health verification are still pending.
- The Section 25 read recorded `operatorCredentialStates=[]`. Do not treat a
  working Pi health endpoint, CloudURL verification or an opened browser as
  proof that operator version 1 is active. Refresh this state after the real
  Platform/Portal/Pi lifecycle is exercised.
- R11 rate-limit/idempotency source remains in Platform commit
  `b9cf43c17ed1461b76e66280db6d985d285d64ca`; the CloudURL re-verification
  follow-up is commit `a08f45624c9c9f8b59b7bfda3e7c934e8d632cec` and is included
  in the deployed Vercel build above. The additive migration
  `20260925230000_r11_operator_mutation_idempotency` was applied to the
  specifically guarded Supabase project after baseline/checksum/schema
  verification. It was reapplied successfully with no pending migrations.

## Refreshed read-only Production evidence — 2026-09-26

- Vercel CLI 60.1.3 deployed the reviewed Platform source commit
  `a08f45624c9c9f8b59b7bfda3e7c934e8d632cec` to Production as
  `dpl_5ZHziTkyXjykfNqmzXNpKxFQRaf4`; the canonical alias now resolves to that
  Ready deployment. Smoke checks returned `/` 200, `/api/health` 200,
  `/api/readiness` 200, unauthenticated protected workflow 401 and unknown
  route 404. The prior deployment `dpl_33F8xEAGdAqBU8UxbPeQXT76fmk3` remains the
  rollback target.
- Non-printing target validation and guarded read-only SQL confirmed the
  configured database pair resolves only to Supabase project
  `fppzzesvukjbsfmxmfxe`. Before migration, all 14 applied checksums matched
  local history and R11 was the sole pending migration. The migration is now
  recorded as applied, all 15 ledger checksums match, and guarded reapplication
  reported no pending migrations. No reset or customer-data deletion occurred.
- Production schema-only inventory after R11: 45 tables, 623 columns, 188
  constraints, 190 indexes and 22 triggers. Direct table grants to `anon` and
  `authenticated` remain empty. The post-migration fingerprint is
  `f54717c673934fb30c35a48ad18ef76c5e95d478f73e277e18d0d9d533ca2382`.
- The schedule inventory contains exactly one active Supabase
  `dinodia-native-operations` job at `*/2 * * * *`. Vault contains the names
  `DINODIA_NATIVE_OPERATIONS_URL` and
  `DINODIA_NATIVE_OPERATIONS_CRON_SECRET`; values were not retrieved. Edge
  has zero schedules and Vercel retains only the daily maintenance cron.
- Redacted safe-record counts show the existing CXO remains ACTIVE and the
  initial bootstrap ceremony is CONSUMED; the existing Home, installation
  work, HubInstallation, active machine credential and verified CloudURL
  remain present. No active Production operator-credential version was found;
  the Pi's reported `operatorCredentialStates` is still empty. Do not claim
  operator access or credential lifecycle acceptance.
- The post-deployment `/api/readiness` returns 200 with the existing
  `20260925230000_r11_operator_mutation_idempotency` migration already applied;
  all 15 Production ledger checksums match local migrations. Readiness does not
  prove operator activation, browser handoff, fresh CloudURL proof or user
  acceptance.

## Immutable candidate manifest

Fill these fields only after final review/deployment. Do not put credentials,
database URLs, cookies, pairing codes, private keys or other secret values in
this file or a deployment ticket.

- Platform Stage 1 commits: `b9cf43c17ed1461b76e66280db6d985d285d64ca` and
  `a08f45624c9c9f8b59b7bfda3e7c934e8d632cec`; Production deployment/build ID:
  `dpl_5ZHziTkyXjykfNqmzXNpKxFQRaf4` at the canonical alias.
- Dinodia OS source commit `d0fe632cc791168c83302620e38f44f5e89da010`; source
  archive SHA-256 `d44c642a5ea230e1b9df11bf2b131315ef40bf1d91e1b9d0615b3578bf53c614`;
  the candidate build ID and successful atomic install remain pending.
- Migration `20260925230000_r11_operator_mutation_idempotency`, SHA-256
  `8297d0923192b9ea2d4fd364bc1ae365a7709461b65da1e1981aaa1b93eb7014`;
  Supabase ledger contains the matching completed row and a guarded reapply
  reports no pending migration.
- Edge tooling/configuration commit: `fb87611` (tooling and value-free comment
  only); executable Worker source is unchanged, so it was not redeployed. A
  read-only Wrangler RC deployment inventory on 2026-09-26 reports the current
  100% version `4ef553c8-1c1a-448f-8783-54aca6ca2b07` (deployment
  `38511013-d158-4783-a541-fa9413a4f244`, created 2026-09-25). No Edge schedule
  or alternate origin was added.
- Redacted existing hub/home identifiers and safe effective credential state:
  capture after read-only verification; do not publish full serials or secrets.
- BaseURL and verified CloudURL scenario evidence: record only redacted
  references and status, never query/session material.
- iOS reference build and physical Gupta test record: pending real device
  execution; simulator results are not biometric or UA evidence.
- Rollback: restore the previously deployed Vercel build and the existing
  backed-up Native V2 Pi release using the tested atomic installer procedure.
  Keep additive database migrations/data in place during application rollback;
  never drop or reset Production schema/data as an automatic rollback.

## Deployment gate and rollback

The critical local engineering gate passed before the Platform deployment:
Platform Stage 1 integration, two independent clean-source PostgreSQL
reconstruction/idempotency runs, OS tests/checks, Edge tests/typecheck/lint and
RC dry-run, iOS simulator tests, full/runtime dependency audits, schema
fingerprint and exact-value client-bundle scan. The R11 additive migration was
already applied and verified; no Production data mutation occurred during this
deployment. Do not commit or push `.env.local`, credentials, keys, pairing data
or generated local material.

Vercel rollback target: restore the prior Ready deployment
`dinodia-platform-v2-3i24kx2uj-dinodia-supabase.vercel.app` (deployment ID
`dpl_33F8xEAGdAqBU8UxbPeQXT76fmk3`) to the canonical alias using the current
Vercel CLI; keep the additive migration and all data in place. The Pi rollback
must use the installer's preserved previous release symlink and saved service
units, never the old HA installation. Do not claim the Pi candidate is live
until the guarded install reports its exact build and `/api/health` matches.

## Remaining real-hardware and participant run

Use the existing paired Pi and verified CloudURL; do not create a replacement
tunnel or duplicate Production rows. Execute the UA scenarios in Section 13 of
the authoritative Stage 1 plan with the named operator, owner, manager, tenant,
product owner and security owner. Record redacted build IDs, timestamps,
expected/actual results, audit IDs, defects/retests and explicit sign-off.
Specifically verify:

1. The actual browser-bound Company Portal launch over BaseURL and CloudURL,
   with two browser profiles, and a real OS-protected read followed by session
   end/revocation. A popup-open message is not success evidence.
2. Platform, Portal and Pi agree on separate PENDING, DELIVERED, ACKNOWLEDGED
   and ACTIVE operator credential states without exposing the credential.
3. Automatic 60-minute rotation, exact 20-minute grace, interrupted retries,
   emergency revocation and active HTTP/WebSocket enforcement within 60s.
4. The new independent signed challenge and durable Platform CloudURL
   verification for the existing tunnel.
5. Physical Gupta Face ID/passcode success/cancel and controlled reversible WAN
   loss/reconnect. Simulator tests do not substitute for these scenarios.

Stage 1 remains incomplete and Stage 2 remains blocked until every AC-01 and
UA-01 item passes with evidence and both product-owner and security-owner
sign-off.
