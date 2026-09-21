# Stage 1 release-candidate readiness

This document is a preparation artifact only. No release candidate was deployed by the Stage 1 engineering run, and no production database or hub was mutated.

## Topology

- Active backend/frontend: `dinodia-platform-V2` on the new Vercel project.
- `dinodia-platform-aws`: retired from the V2 runtime; no traffic, schedules, queue consumers or background workers.
- `dinodia-edge-worker-V2`: routes `/api/*` only to the configured V2 `VERCEL_APP_ORIGIN`.
- Shared cron ceiling: two entries maximum; the current repository configuration declares no Stage 1-specific credential cron.
- Database: one shared Supabase data source for an authorised release-candidate deployment; migration rehearsal must use disposable PostgreSQL only.

## Release-candidate manifest to complete before deployment

Record these values in the deployment ticket, never in this repository:

- Vercel `dinodia-platform` commit/build identifier: **operator fills in**.
- Dinodia OS commit/build identifier: **operator fills in**.
- Prisma migration applied: **operator fills in**.
- Redacted hub serial suffix and installation ID: **operator fills in**.
- BaseURL test path: **operator fills in; do not publish the URL in a ticket visible to customers**.
- CloudURL test path: **operator fills in; company-domain hostname only**.
- Portable-router/LAN network and printed `.local` setup address: **operator fills in**.
- WAN-disconnection method and exact start/end timestamps: **operator fills in**.
- Reference-client/app build: **operator fills in**.
- Rollback target: previous approved Vercel build, previous approved Dinodia OS image/configuration and the documented migration rollback procedure.

Required secret/configuration names are recorded here only as names: `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`, native hub signing-root configuration, Cloudflare company-domain configuration, Vercel deployment credentials and the hub identity-broker configuration. Never paste their values into this document, source control, logs or chat.

## Deployment gate

Do not deploy until all locally executable engineering checks pass and the product/security owners authorise the release-candidate run. Do not point dormant AWS at the release candidate. After deployment, verify the deployed commit and migration before any customer journey.

## Manual release-candidate run

Use one authorised Company Portal operator, one original-owner test principal, one property-manager test principal, one tenant test principal, the product owner and the security owner. Use a disposable test property/hub or an explicitly approved test home.

1. Confirm the locked `http://dinodia-<serial>.local/setup` page is data-empty, reachable only on the isolated portable-router network and does not expose a dashboard or routine password login.
2. Generate one short-lived pairing presentation on the hub, select the assigned installation workflow in Company Portal, redeem it, complete the outbound hub proof and confirm that no browser response contains a machine/operator bearer credential.
3. Create the reserved company-domain Cloudflare tunnel through the paired Dinodia OS Cloudflare section. Verify the signed CloudURL response with an independent Platform challenge. Confirm installation completion remains unavailable until this succeeds.
4. Verify the permanent hub-label and Company Portal Home QR resolve to the same secure reference. Before installation completion, confirm a scan creates only resumable pending onboarding and no active membership or protected property data.
5. Exercise support: create a V2 ticket, obtain customer approval, issue the reveal-once code, redeem only through the signed hub endpoint, verify tenant/property scope, verify tenant-device privacy, close/revoke, and confirm offline desired revocation is acknowledged on reconnect. Confirm the browser redemption endpoint returns `403`.
6. Exercise credential delivery and rotation. Confirm `PENDING -> DELIVERED -> ACKNOWLEDGED -> ACTIVE`, exact 20-minute grace, 60-minute rotation and emergency revocation. Confirm active sockets close or reauthorize within 60 seconds.
7. Exercise owner, property-manager and tenant permissions across two properties, including wrong-home replay, removed membership, tenant area restriction and private `tenant_device` isolation.
8. Disconnect WAN. Confirm an already enrolled trusted phone can perform only previously authorised local operations after fresh step-up; a new phone, widened scope, CloudURL use and account/access/support/Alexa administration fail. Reconnect and confirm newer cloud policy is applied before normal connected state.
9. Execute the exact step-up cancellation, replay, expiry, changed-value, wrong-target and concurrent-consumption cases. Confirm no rejected case dispatches a physical action.
10. Capture redacted audit IDs, builds, timestamps, HTTP status/results, hub status, participant sign-off and every defect/retest.

## Rollback

Rollback requires an authorised change ticket. Stop new release-candidate traffic, preserve redacted evidence, restore the previous approved Vercel build and approved hub software/configuration, and follow the migration-specific database rollback procedure. Never run a destructive rollback against production Supabase without a separately approved backup/restore decision.

Stage 1 remains incomplete until every AC-01 and UA-01 item has evidence from this run and product-owner/security-owner sign-off.
