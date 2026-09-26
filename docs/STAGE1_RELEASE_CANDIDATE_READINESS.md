# Stage 1 release-candidate readiness

Updated 2026-09-26. This is a value-free evidence/runbook record. The reviewed
CloudURL challenge-evidence follow-up, audited operator credential transitions,
and support close/redeem race fix are deployed to the canonical Production
alias as Vercel deployment `dpl_8hjtjMusx6Cm4u8soX4doKbh7tYz`. A separate Native V2 OS package
with the locked-setup mDNS fix is staged on the existing Pi; its guarded
installer has not yet been run. Stage 1 remains incomplete.

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
- Read-only checks after the latest Platform deployment on 2026-09-26:
  canonical Vercel `/`, `/api/health` and `/api/readiness` returned 200;
  an unknown route returned 404; unauthenticated `/api/installer/workflows`
  returned 401. Deployment `dpl_8hjtjMusx6Cm4u8soX4doKbh7tYz` is Ready and
  aliased to the canonical origin. The preceding Ready deployment
  `dpl_BgEMjyMhzEDZgNDsh1NACrET1PQn` is the immediate rollback target;
  `dpl_ETjeK2SyLTudMrSpqVYMaphGqiBd` remains available as an older rollback point;
  `dpl_5ZHziTkyXjykfNqmzXNpKxFQRaf4` and
  `dpl_33F8xEAGdAqBU8UxbPeQXT76fmk3` remain available as older rollback points.
- Before staging the mDNS update, Pi `192.168.1.76` reported
  `mode=native-v2`, build `native-v2-295865a6263064dc51553536`; both services
  were reported active. The enrolled identity was not modified. The candidate
  source fingerprint is `native-v2-fb5ba1404cd34a79feb649f9`; its transferred
  archive SHA-256 is
  `f2a30dfd37ae6e696e98391d73c9e115e8f1650d5e068c53681f2b197aefd127`.
  It is staged at `/tmp/dinodia-os-stage1-fb5ba1404cd34a79feb649f9` on the Pi;
  the sudo-protected atomic installer and post-install health check remain
  pending. Before this candidate, the Pi lacked `avahi-publish-address` and
  `avahi-publish-service`, so `.local` discovery was not proven.
- Section 27's real operator lifecycle evidence supersedes Section 26. A
  guarded read-only Production query at approximately `2026-09-26T09:55Z`
  found version 4 ACTIVE and version 3 REVOKED; version 3's grace deadline was
  `09:40:09.742Z`, followed by durable revocation at `09:42:00.424Z`. At the
  earlier `09:28Z` Pi observation, it agreed on version 4 ACTIVE and version 3
  GRACE, with `lastError` absent and last sync at `09:28:34.601Z`. Version 4
  was issued at
  `09:20:02.285Z`, delivered at `09:20:02.969Z`, acknowledged at
  `09:20:07.448Z` and activated at `09:20:09.742Z`. Version 3 was activated at
  `08:18:38.445Z` and given a 20-minute grace deadline at `09:40:09.742Z`.
  Scheduler-driven rotation occurred naturally; no credential value was read
  or exposed. This is partial live evidence only: exact-boundary behavior,
  emergency revocation, and active WebSocket revocation remain unproven live.
- Historical R11 rate-limit/idempotency source is in Platform commit
  `b9cf43c17ed1461b76e66280db6d985d285d64ca`; the CloudURL re-verification
  follow-up is in commit `a08f45624c9c9f8b59b7bfda3e7c934e8d632cec`. Both are
  ancestors of the deployed Platform branch head. The latest deployment also
  includes the reviewed route/test worktree patch noted below. The additive migration
  `20260925230000_r11_operator_mutation_idempotency` was applied to the
  specifically guarded Supabase project after baseline/checksum/schema
  verification. It was reapplied successfully with no pending migrations.

## Refreshed read-only Production evidence — 2026-09-26

- Vercel CLI 60.1.3 deployed the reviewed CloudURL route/test source snapshot
  from Platform branch head `3fab8b7e0cbdbc4f6983e9a67a89e5f031291068` plus
  the reviewed changes to `src/app/api/hub-agent/v2/pairing/cloud-url/route.ts`
  and `test/stage1_security.test.mjs` as deployment
  `dpl_ETjeK2SyLTudMrSpqVYMaphGqiBd`
  (`dinodia-platform-v2-os5eibkkh-dinodia-supabase.vercel.app`). The deployment
  is READY and the canonical Production alias resolves to it. The route now
  records the challenge issuance timestamp and `HubInstallation.remoteChallengeAt`
  transactionally. No migration or database mutation was part of this deploy.
  Smoke results: `/` 200, `/api/health` 200, `/api/readiness` 200,
  unauthenticated protected workflow 401, unknown route 404; frame protection
  was `DENY` and HSTS was present on each response.

- Vercel CLI 60.1.3 then deployed the reviewed operator transition/audit
  source snapshot to Production as `dpl_BgEMjyMhzEDZgNDsh1NACrET1PQn`
  (`dinodia-platform-v2-kdkucpnft-dinodia-supabase.vercel.app`), Ready and
  aliased to the canonical origin. It includes transactional, redacted audit
  events for delivery, exact-version acknowledgement and activation, plus
  idempotent concurrent hub retries. The snapshot is based on Platform
  `3fab8b7e0cbdbc4f6983e9a67a89e5f031291068` plus the reviewed worktree diff,
  not a clean Git commit. No migration or Production row mutation was part of
  the deployment. Post-deploy smoke returned `/`, `/api/health` and
  `/api/readiness` 200, unauthenticated protected workflow 401 and unknown
  route 404; `X-Frame-Options: DENY` and HSTS were present.

- After the support close/redeem concurrency regression passed against
  disposable PostgreSQL and `npm run clean-clone:check`, commit
  `c043ab1cbf87baa9e27fbeade0c80f02031b16a4` was deployed to Production with
  Vercel CLI 60.1.3 as `dpl_8hjtjMusx6Cm4u8soX4doKbh7tYz`; it is READY and
  aliased to the canonical origin. This commit records the reviewed R11
  credential lifecycle and CloudURL changes as well as the support
  close/redeem serializable-transaction fix. No migration or Production row
  mutation was part of the deployment. Post-deploy smoke: `/`, `/api/health`,
  `/api/readiness` returned 200; unauthenticated support redeem, ticket
  creation and installer workflow requests returned 401; an unknown path
  returned 404; all sampled responses had frame denial and HSTS.

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
- The existing CXO remains ACTIVE and the initial bootstrap ceremony remains
  CONSUMED; the existing Home, installation work, HubInstallation, active
  machine credential and verified CloudURL were preserved. At the 09:55Z
  observation Production showed operator v4 ACTIVE and v3 REVOKED after grace;
  Pi had previously converged on v4 ACTIVE. The
  `HubInstallation.remoteChallengeAt` was still null, and
  the matching VERIFIED `CloudUrlVerification` row was issued at
  `2026-09-25T19:38:54.226Z`, verified at `2026-09-26T07:45:02.402Z`, and
  expired at `2026-09-26T07:50:01.473Z`. The row's tunnel ID equals the installation's stored tunnel
  ID, and its hostname/name match the reserved installation. The fresh signed
  challenge has not yet been triggered.
- The post-deployment `/api/readiness` returns 200 with the existing
  `20260925230000_r11_operator_mutation_idempotency` migration already applied;
  all 15 Production ledger checksums match local migrations. Readiness does not
  prove operator activation, browser handoff, fresh CloudURL proof or user
  acceptance.
- A read-only tunnel probe at approximately 09:55Z returned `/api/health` 200
  with `mode=native-v2`, build `native-v2-295865a6263064dc51553536`, and
  `/setup.js` 200. The Pi services were active. The mDNS candidate remains
  staged at `/tmp/dinodia-os-stage1-fb5ba1404cd34a79feb649f9`; it has not been
  installed, so the current Pi still lacks the candidate `.local` helper.
- The physical iPhone `Gupta` is paired and available. The Stage 1 Debug app
  was signed, installed and launched with the reference-view argument. This
  proves installation only—not customer sign-in, Face ID/passcode, a protected
  command or WAN acceptance. Simulator tests are engineering evidence only.
  Chrome control remains unavailable after the approved reconnect attempt;
  the Browser plugin reinstallation request is outstanding. The live
  two-browser matrix and physical biometric/WAN acceptance remain open.

## Immutable candidate manifest

Fill these fields only after final review/deployment. Do not put credentials,
database URLs, cookies, pairing codes, private keys or other secret values in
this file or a deployment ticket.

- Platform commit `c043ab1cbf87baa9e27fbeade0c80f02031b16a4`: immutable
  Production deployment `dpl_8hjtjMusx6Cm4u8soX4doKbh7tYz`; prior Ready
  deployment `dpl_BgEMjyMhzEDZgNDsh1NACrET1PQn` is the immediate rollback
  target. Earlier deployments were source snapshots rather than clean commits.
- Dinodia OS commit `78c31ce16f822990878bb740d1540db358ff1a70`; candidate build
  ID `native-v2-fb5ba1404cd34a79feb649f9`, archive
  SHA-256 `f2a30dfd37ae6e696e98391d73c9e115e8f1650d5e068c53681f2b197aefd127`.
  It remains staged; installation and health verification remain pending.
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
- iOS Stage 1 reference commit `76eeeebaf6a749be68e1dc6ba6d38590235cc8a6`.
  On 2026-09-26, `xcodebuild test -project Dinodia.xcodeproj -scheme Dinodia
  -destination 'platform=iOS Simulator,id=6F327A41-390F-4FD9-8C32-0C606B4D7014'
  -quiet` passed 111/111 on iPhone 17 Pro Simulator, iOS 26.5. The app was
  installed/launched on physical Gupta earlier; customer sign-in, physical
  Face ID/passcode, protected command and WAN acceptance remain unproven.
- Redacted existing hub/home identifiers and safe effective credential state:
  guarded Production query at approximately 09:55Z showed v4 ACTIVE and v3
  REVOKED; Pi had reported v4 ACTIVE at 09:28Z. No credential value was read.
- BaseURL and verified CloudURL scenario evidence: record only redacted
  references and status, never query/session material.
- iOS simulator suite passed on iPhone 17 Pro simulator. Debug build
  `com.dinodia.DinodiaV2` was also built, installed and launched on paired
  Gupta with `-stage1-security-reference`; physical authentication, authorized
  customer sign-in, exact safe command, replay denial and WAN tests remain
  pending.
- Rollback: restore the previously deployed Vercel build and the existing
  backed-up Native V2 Pi release using the tested atomic installer procedure.
  Keep additive database migrations/data in place during application rollback;
  never drop or reset Production schema/data as an automatic rollback.

## Deployment gate and rollback

The critical Platform gate passed before the latest Platform deployment:
Platform Stage 1 integration, clean-source PostgreSQL
reconstruction/idempotency runs, OS tests/checks, Edge tests/typecheck/lint and
RC dry-run, iOS simulator tests, full/runtime dependency audits, schema
fingerprint and exact-value client-bundle scan. The R11 additive migration was
already applied and verified; no Production data mutation occurred during this
deployment. The support close/redeem race fix was validated on the actual
Platform routes with disposable PostgreSQL before deployment. Do not commit or
push `.env.local`, credentials, keys, pairing data
or generated local material.

Vercel rollback target: restore the prior Ready deployment
`dinodia-platform-v2-kdkucpnft-dinodia-supabase.vercel.app` (deployment ID
`dpl_BgEMjyMhzEDZgNDsh1NACrET1PQn`) to the canonical alias using the current
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

## R11-04 support close/redeem race regression — 2026-09-26 10:23Z

The loopback integration harness exposed a missing behavioral race case between
customer ticket closure and machine-authenticated support redemption. Both
production routes now use the shared bounded serializable transaction helper
`src/lib/serializableTransaction.ts`; a retry is limited to PostgreSQL
serialization conflicts and does not repeat external side effects. The actual
Platform/OS + disposable PostgreSQL test raced `POST
/api/v2/support/tickets/:ticketId` against `POST
/api/hub-agent/support/v2/redeem` and passed: closure returned success, the
request ended REVOKED, and no ACTIVE support lease remained. `npm run
test:stage1`, `npm test`, `npm run lint`, `npm run typecheck`, `npm run
check:foundation:manifest`, `npm run check:logs`, `npm run check:security`,
`npm run check:stage1`, `npm run check:foundation`, `npx prisma validate`, both
dependency audits, `npm run build`, and `npm run clean-clone:check` passed on
the reviewed worktree. Commit `c043ab1cbf87baa9e27fbeade0c80f02031b16a4` is
deployed as `dpl_8hjtjMusx6Cm4u8soX4doKbh7tYz`; production smoke passed. This
regression does not prove the full support clock-boundary, participant or
offline acceptance matrix.
