<!-- Architecture: Active Dinodia module phase8-acceptance.md; document its role here while preserving the existing runtime and cross-repository contracts. -->
# Phase 8 Acceptance Runbook

## Status (as of 2026-03-17)
- ✅ Complete: Runbook document (execution must be performed/validated in the target environment).

## Pre-reqs
- Environment: `DATABASE_URL`, `CLAIM_CODE_PEPPER`, email/SES credentials, and `APP_URL` configured; Prisma schema deployed and migrations applied.
- Home Assistant reachable via `HaConnection.cloudUrl` or `baseUrl` with a valid long-lived token; remote access is required for FULL_RESET.
- Admin portal access to `/admin/settings` and the claimant portal `/claim`; ability to read the database (`psql` or `prisma studio`).

## Scenario A – FULL_RESET
1) Sign in as the current admin, open Admin Settings → Selling Property, choose **Full reset**, and confirm. If HA is unreachable you should see “Remote access is required to reset this home” and no DB changes occur.
2) On success, record the claim code shown. Verify DB state: `Home.status` = `UNCLAIMED`, `HaConnection.ownerId` = `NULL`, `HaConnection.cloudUrl` = `NULL`, `claimCodeConsumedAt` = `NULL`, and all `User` rows for that `homeId` are removed. `AuditEvent` rows should include `SELL_INITIATED`, `CLAIM_CODE_GENERATED`, and `HOME_RESET` with `haCleanup.guardrails` and HA target counts.
3) Confirm HA cleanup: `haCleanup.targets` only includes IDs from commissioning sessions, automations start with `dinodia_`, and `haCleanup.entities/devices.skipped` shows any capped/ignored IDs (core/native devices are not targeted).
4) Claim via `/claim` using the code; because the home is `UNCLAIMED` and `cloudUrl` is empty the form/API requires a remote URL. Complete email verification. Verify `Home.status` = `ACTIVE`, `HaConnection.ownerId` = new admin id, and `claimCodeConsumedAt` is set.

## Scenario B – OWNER_TRANSFER
1) From Admin Settings → Selling Property choose **Owner transfer**. This should delete only the current admin’s account and linked trusted devices/permissions, leave tenants/devices/HA tokens intact, set `Home.status` = `TRANSFER_PENDING`, and clear `HaConnection.ownerId` only.
2) Capture the claim code shown. `AuditEvent` should show `OWNER_TRANSFERRED` with deleted counts and `CLAIM_CODE_GENERATED`. Tenant sessions should continue working.
3) Claim via `/claim` with the new owner. If a `cloudUrl` already exists it remains optional; otherwise the API returns `missingField: "cloudUrl"`. After verification `Home.status` = `ACTIVE`, `HaConnection.ownerId` = new admin id, tenants remain mapped to the same `homeId`, and `claimCodeConsumedAt` is set.

## Claim Retry (abandoned verification)
1) Start `/claim` with a valid code, submit details to trigger email verification, but do not click the email link. Observe the temporary admin row (`role=ADMIN`, `emailVerifiedAt` = `NULL`, `emailPending` set).
2) Start a second `/claim` for the same code with a new username/email. The API removes only unverified claim admins for that home/connection, then creates a fresh admin and challenge. `AuditEvent` `HOME_CLAIM_ATTEMPTED` metadata shows `pendingAdminsDeleted`.
3) Complete verification from the new email; `HOME_CLAIMED` is recorded and the home becomes `ACTIVE`.

## Audit Event Proof Points
- Query `AuditEvent` ordered by `createdAt` for the `homeId`. Key types: `SELL_INITIATED`, `CLAIM_CODE_GENERATED`, `HOME_RESET` (with `haCleanup` + guardrails), `OWNER_TRANSFERRED`, `HOME_CLAIM_ATTEMPTED`, `HOME_CLAIMED`.
- `haCleanup` metadata lists targeted/deleted counts, the endpoint used, and any guardrail skips or errors for HA safety.
