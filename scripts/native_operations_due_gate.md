# Native Operations due gate: build/release contract

`20261103010000_native_operations_due_gate` replaces the command of the existing
`dinodia-native-operations` cron job through `cron.alter_job(jobid, command := ...)`.
The `*/2 * * * *` schedule, job ID, database, owner and active flag remain intact.
It creates no job or extensions. Duplicate jobs or unexpected command/schedule/
owner/database abort the transaction. Parent release preflight must verify exactly
one matching job; an absent local job is deliberately left absent.

The SQL functions are INVOKER with `search_path=pg_catalog`, explicit public table
references, UTC conversion for Prisma's timestamp(3) columns, no instrumentation
writes, and execute permission only for owner `postgres`. A false predicate avoids
all Vault reads. A true predicate performs the original Vault/net HTTP dispatch,
with the original two Vault names, JSON body, Bearer header and 8-second timeout.
The HTTP request ID is discarded. No credential is returned or logged.

The predicate checks the persistent OPERATIONS registry exactly:

- `operator_credential_lifecycle`
- `support_expiry_and_revocation`
- `claim_reservation_expiry`

Misownership, missing/extra tasks, failures, unknown work and SQL errors dispatch.
`nextDueAt` never suppresses queue arrivals. The existing endpoint lease remains
the duplicate-effects authority; the gate adds no lock or worker behavior.

## Work inventory

- Operator ACTIVE issued at least one hour ago, without an operator-credential
  PENDING/DELIVERED/ACKNOWLEDGED sibling on that hub; GRACE graceUntil <= now.
- ACTIVE support expiresAt <= now; REQUESTED/APPROVED/ISSUED requests
  codeExpiresAt <= now; ACTIVE claim expiresAt <= now.
- ACTIVE, non-revoked autoScope Alexa links always dispatch. Discovery reconciles
  changing memberships/areas/devices and cannot safely be inferred idle cheaply.
- Every PROCESSING outbox row conservatively dispatches, including fresh leases.
- PermanentDeviceInstallationRequest EMAIL/COMPLETED events: nextAttemptAt due,
  expiresAt future, attempts < 12. Expired/exhausted PENDING rows are not consumed
  by the actual handler and do not keep dispatch alive.
- HomeownerAccessRemovalNotice: the 13 current removal/account events use due
  retry and attempts < 8, or unconditional expiry transition. Retired automation
  management notices always dispatch for suppression.
- FullHomeDeregistrationAccountCleanup/FULL_HOME_ACCOUNT_CLEANUP: retry due,
  expiration or exhausted attempts >= 8, regardless of future retry time.
- AlexaChangeReport/ALEXA_CHANGE_REPORT: retry due and unexpired. The handler's
  outer query excludes expired pending rows; no standalone expiry cleanup exists.
- AlexaAccountRemoval/ALEXA_ACCOUNT_REMOVAL_REPORT: retry due or expiration.
  Unknown events within this aggregate also dispatch, preserving its aggregate-wide
  expiration cleanup.
- OWNER_INSTALLATION_UPDATE EMAIL/PUSH receipts with installation-request keys:
  deliverAfter due, unexpired, attemptCount < 8. TENANT_AUTOMATION_FAILURE/PUSH
  PENDING always dispatches for unconditional suppression, including future,
  expired and exhausted receipts. Unknown families/channels/key classes dispatch.
- Explicit passive PENDING signals: HomeClaimReference/installation_complete,
  NativeDevice/PROPERTY_DEVICE_COMMISSIONED and NativeDevice/PROPERTY_DEVICE_ADOPTED.
  Source writers are stage1ClaimContract.ts and commissioning-sessions/route.ts;
  neither runNativeOperations nor its queue consumers selects these events.
  They are retained domain signals, not work for this dispatcher. No rows change.

Pending outbox, pending receipts and old ACTIVE credential candidates are each
bounded at 1,001 rows. More than 1,000 means dispatch, even for passive/future
rows. Small queues use the existing state/nextAttemptAt and hub/purpose/state
indexes plus seven added global state/time lookup indexes. These are ordinary
transactional index builds; the release owner must assess table sizes/lock budget.
The gate promises bounded candidate inspection, not a measured Production latency
or a forced planner/index choice. Heap bloat still affects physical scan cost.

## Source compatibility

`native_operations_due_gate_contract.json` fingerprints 25 gate-sensitive source/
schema files, including dispatcher, notification/outbox consumers and nested Alexa
and cleanup callees. `test/native_operations_due_gate.test.mjs` rejects any drift.
Before updating fingerprints, review the SQL inventory against changed worker
behavior, including new nested tasks, pending families and passive-event consumers.
This is a build/release contract, not runtime discovery. Persistent registry checks
cover task-row uncertainty; unknown queue classes fail open at runtime.

## Focused validation and recovery

Run new Node tests and existing focused auth/lease tests, typecheck, then:

```sh
node scripts/test_native_operations_due_gate.mjs --log-dir /path/to/stage4-logs
```

The SQL harness requires an already available local Docker daemon and cached
`postgres:16-alpine` (`--pull=never`), creates one bounded disposable container,
runs sequential checks, and removes it in finally. It does not read .env files or
forward credential variables. Fixtures derive exact relevant scalar/enum types
and timestamp precision from schema.prisma, omitting unrelated fields/FKs/triggers.
cron, Vault and net are explicit local stubs; a JS asynchronous queue drainer sends
to an actual loopback HTTP recorder with a synthetic Bearer. This does not validate
real pg_cron/pg_net daemon execution, handler effects, provider delivery or Production.
Existing auth/lease Node tests also use injected database/route dependencies.

Recovery is `scripts/recover_native_operations_due_gate.sql`, applied by the
release owner as postgres on the validated database with psql ON_ERROR_STOP.
It atomically/idempotently restores the exact former unconditional authenticated
Vault/net command on the SAME job using cron.alter_job. Recheck the same job ID,
`*/2 * * * *`, owner, database and active flag. Leave additive functions/indexes in
place; no destructive reverse migration is needed. Reapplying the migration can
reactivate the gate after review. Older application readiness allowlists do not
automatically accept this migration; parent owns the compatible recovery release.
