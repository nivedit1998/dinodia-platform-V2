# Audited analytics activation and forward recovery

Use only after an independent READY review of the exact release, compatible Production
schema/Platform, checksummed Hub installation, healthy sync, and drained legacy backlog.
No actuator command is part of this procedure. No generic collection enablement is approved.

## Existing authenticated Company Portal session

The operation is `POST /api/company/analytics-activation`. It requires an active CXO or
Senior Operations Manager employee session, authenticated within five minutes, and the
same-origin `Origin` header. Use the existing Company Portal session; never copy a session
token into a handoff, Git or chat. A tenant, owner or installer token is insufficient.

Read `GET /api/company/analytics-activation?homeId=<verified UUID>&hubInstallationId=<verified UUID>`
under that session. It returns current writer/collection flags, current signed configuration
revision/checksum, acknowledged revision, last successful sync and `acknowledged`.

POST exactly these fields (JSON booleans/numeric revision, not strings):

```json
{
  "homeId": "<verified existing Home UUID>",
  "hubInstallationId": "<verified existing installation UUID>",
  "operationId": "<new UUID kept for this exact operation>",
  "expectedCloudRevision": 123,
  "expectedWriterEnabled": false,
  "expectedCollectionEnabled": false,
  "writerEnabled": true,
  "collectionEnabled": false
}
```

Replace expected values with the GET result. The body is installation-bound and compare-and-swap
guarded. Reuse the identical body/operation ID after a lost response; never retry with a new ID
blindly. A conflicting revision needs a fresh GET and deliberate reconciliation.

The transaction locks the Home, seeds or renews permanent-device epochs when enabling
(a paused writer resumes in a new epoch so separated same-hour spans never merge),
updates the flags and Home management revision, constructs the exact next configuration checksum,
stores its revision/checksum, and records one `analytics_installation_activation_changed` employee
audit and one idempotency record. Construction of normal sync configuration no longer seeds epochs.
`acknowledged:false` is intentional: an HTTP response does not prove Hub receipt.

GET again after the Hub's ordinary signed sync. Require the expected flags, checksum and revision,
and `acknowledged:true`. Independently inspect the Hub's applied revision/flags and subsequent signed
v2 usage receipt, original-hour row and authenticated analytics response. Do not call GET success
activation acceptance. If identity generation changes, repeat the audited operation to renew epochs;
normal configuration reads do not silently invent generation-bound history authority.

## Exact disable / forward-recovery procedure

Use the same GET and POST operation with a new UUID, exact current expected revision/flags,
`writerEnabled:false` and `collectionEnabled:false`. Require the matching flags-off signed
configuration acknowledgement and local Hub flags-off state. New v2 recording stops; queued
well-formed evidence drains to unallocated storage rather than blocking sync or becoming measured
coverage. Do not claim the paused interval is measured Off. Fix forward while keeping compatible
Platform/schema, interval/unallocated data, Store and outbox.

Never down-migrate, restore an old Store or return to an old writer after epoch coverage exists.
The packet intentionally refuses `--rollback`. Generic reporting/configuration/polling remains
separately permission-gated even if a privileged operator can change collection flags.
