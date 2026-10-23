# Universal analytics interval contract — candidate

User decision D11: category/source edits are immediate. Legacy absolute counters
cannot be divided at that boundary without inventing measurements. Preserve
ambiguous payloads in NativeAnalyticsUnallocated with an immutable digest, event
id, Home/Hub/device/Area authority and retention date. Receipt/cursor and evidence
commit in the same signed-sync transaction. These are authenticated payloads,
not a retained raw HTTP request or a second measured series. No reconciliation
UI or automatic proportional allocation is supplied.

NativeAnalyticsInterval retains category/source/generation revisions and a
bounded catalog snapshot. New usage includes interval id, bindingRevision and
analyticsPolicyVersion=2. Distinct same-hour epochs have distinct unique keys.
Triggers enforce matching permanent Home authority, non-overlapping intervals
and non-overlapping physical-device coverage. Legacy payloads remain accepted
under the old unchanged policy path; ambiguous cutovers and post-v2 legacy
overlap remain unallocated. A historical interval never grants current control
authority. Current tenant authorization and command paths are unchanged.

Assigned-staff category/source changes retain fresh operator/work/Home checks,
CAS, operation digest/idempotency and audit. The Home lock serializes source
changes; a source-only change advances the same management/inventory revisions.
Only one source channel is selected; no device splitting. Power overrides
brightness within a surface. Brightness without certified actual-output meaning
is unsupported. Writable mode/target is not heating evidence.

Existing chart averaging is unchanged. Epoch fragments count as one physical
device, not extra contributors. coverageStatus separately reports eligible,
reporting and missing devices and unallocated event count. Unallocated counters
are not added to measured bars or treated as inferred On/Off. Legacy client
decoders may ignore this optional field; no new UI is claimed.

## Compatibility / activation order

Migration 20261023110000_category_analytics_intervals adds two models, activation
booleans, usage version metadata and replaces the usage unique index/trigger.
It is NOT an old-Platform rollback promise. Schedule a controlled schema/code
transition: old running Platform readiness/client assumptions must not be used
after migration. New Platform must pass readiness including
analyticsUsagePolicyVersion=2 before the candidate Hub is installed.

Both installation flags default false and are not taken from Hub capabilities.
Old Hub receives its unchanged policy shape. Candidate Hub can receive intervals
for explicit edits with writer disabled. For unchanged existing devices, only
explicit server-owned activation seeds intervals; capability advertisement alone
does not. Generation renewal after activation closes/recreates interval authority.
Drain legacy telemetry before activation. Enable writer only after review and
signed configuration acknowledgement; enable generic collection separately and
only with permission for the resulting read-only management traffic. No generic
device reporting writes are enabled by this change.

## Recovery

Disable collection and writer flags, retain this compatible Platform and all
interval/unallocated data, and ship a forward correction. Writer-disabled v2
payloads can drain into unallocated evidence without silently restoring measured
coverage. Do not down-migrate the database, replay old code over interval rows,
restore Store data, or delete queued evidence. A previous Hub code switch is
only eligible before any v2 source/bucket exists, after flags-off configuration
is applied and pending events are drained; the release packet must fail closed
otherwise. Production activation, migrations and installation are excluded from
the current implementation authorization.
