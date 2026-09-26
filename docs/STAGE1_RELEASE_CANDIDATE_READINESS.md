# Stage 1 release-candidate readiness

Updated 2026-09-26. This is an evidence/runbook record, not a deployment
authorization. The live baseline below is distinct from the uncommitted R11
worktree candidate; do not describe the R11 changes as deployed.

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
- Read-only checks on 2026-09-26: canonical Vercel `/`, `/api/health` and
  `/api/readiness` returned 200; an unknown route returned 404; unauthenticated
  `/api/installer/workflows` returned 401. Existing CloudURL `/api/health` and
  `/setup.js` returned 200. Pi `192.168.1.76` returned `{ok:true,mode:native-v2}`
  and both `dinodia-os` and `dinodia-identityd` were active.
- The last reported successful Pi install was build
  `native-v2-b49c7261853f222ee2e106b6`. Re-read its safe build/status metadata
  before the final deployment manifest; do not infer the current build solely
  from that earlier installer output.
- The Section 25 read recorded `operatorCredentialStates=[]`. Do not treat a
  working Pi health endpoint, CloudURL verification or an opened browser as
  proof that operator version 1 is active. Refresh this state after the real
  Platform/Portal/Pi lifecycle is exercised.
- R11 Platform changes and migration
  `20260925230000_r11_operator_mutation_idempotency` are local worktree changes
  and have not been deployed by this engineering run. Production migration
  ledger/checksums and immutable Vercel deployment ID still require guarded
  read-only verification before an additive migration or rollout.

## Refreshed read-only Production evidence — 2026-09-26

- Latest stable Vercel inspection (CLI 60.1.3) resolved the canonical alias to
  deployment `dpl_7mL7k37PEDpT8ThCNxVMKbndSc1z`, target `production`, status
  Ready. The canonical alias remains the sole Production origin. This is the
  currently deployed baseline, not the R11 worktree candidate.
- Hidden-Keychain target validation confirmed the configured connection pair
  resolves only to Supabase project `fppzzesvukjbsfmxmfxe`; no URL or password
  was printed. Production has 14 applied migrations; every applied checksum
  matches the local history, and the R11 migration is the sole pending
  migration. No Production migration or data mutation was performed.
- Production schema-only inventory: 45 tables, 620 columns, 187 constraints,
  189 indexes and 22 triggers. Direct table grants to `anon` and
  `authenticated` were empty. The local R11 candidate schema is 45 tables,
  623 columns, 188 constraints and 190 indexes; apply its additive migration
  only after the guarded deployment gate.
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
- The current deployed `/api/readiness` returning 200 describes its older
  schema contract. It is not evidence that the R11 candidate is ready: that
  candidate's exact migration is still absent in Production, so deploy the
  reviewed additive migration before expecting R11 readiness to pass.

## Immutable candidate manifest

Fill these fields only after final review/deployment. Do not put credentials,
database URLs, cookies, pairing codes, private keys or other secret values in
this file or a deployment ticket.

- Platform Stage 1 commit and Vercel deployment/build ID: pending reviewed
  immutable release.
- Dinodia OS commit/package checksum/build ID: retain and verify the existing
  Native V2 release; record a new ID only if OS source changes and is deployed.
- Migration name/checksum and verified Supabase ledger: pending guarded
  read-only inspection, then additive migration only after approval/gates.
- Cloudflare Worker version/source hash: current deployed version remains the
  existing V2 version unless reviewed Worker source changes; do not redeploy
  for documentation-only edits.
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

## Deployment gate

Do not deploy the R11 candidate until the required OS, Platform, Edge and iOS
engineering gates, disposable PostgreSQL proofs, source/diff review, target
guards and secret/topology scans pass. Before a Production database mutation,
prove both Keychain-sourced database URLs identify only the approved project,
capture schema-only evidence, confirm no unexpected data, and record migration
checksums. Apply only the reviewed additive migration. Do not commit or push
`.env.local`, credentials, keys, pairing data or generated local material.

After deployment, verify the exact Vercel build, migration ledger/readiness,
health/404/auth denial, canonical origin, Edge routing and rollback path before
continuing any customer journey. Preserve the existing CXO, work item, Home,
HubInstallation, enrolled identity, machine credential, tunnel and Pi backup.

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
