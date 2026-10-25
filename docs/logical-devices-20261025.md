# Logical devices / Area deletion — implementation checkpoint

NOT RELEASE READY. Do not apply this migration/deploy this checkpoint to Production.

Base: c059aa10773f16862af43b75aedd5672519c1313. Additive parent/channel relations extend
NativeDevice rather than creating another managed-device store. Existing one-to-one rows retain
NULL parent. Parent/child Home, installation and ownership constraints are enforced by SQL and
the connected domain services. Commissioning channels require explicit feature activation;
legacy clients keep the existing response path. No reporting/polling policy is activated.

Staged deletion uses existing NativeDomainOutbox, AuditEvent and DeletionSecurityReceipt. An
online, operator-confirmed reservation precedes Hub-local fencing and cloud grant withdrawal.
The authenticated sync path batches anonymous erased-target lookups and acknowledges suppressed
payloads without re-creating household rows or rewriting immutable signed uploads.

The implementation and purge inventory are INCOMPLETE. Existing conversion/epochs, tenant
lifecycle cleanup, historical and embedded references, full HTTP/DB deletion/commissioning,
independent assignments and client UX must still pass the plan's gates. Current test fixtures
are not proof of live device operation. No reviewed artifacts or READY release exist yet.

The maintained Docker harness has a focused `LOGICAL_DEVICES_ONLY=1` mode; it still uses its
normal loopback-only target guards, current-source build, synthetic authority fixtures and
automatic container cleanup. It is not a Production test command.

Detailed local phase status:
`Code Planning/Real Testing and UAT etc/LOGICAL_DEVICES_AREA_DELETION_20261025/IMPLEMENTATION_HANDOFF.md`.
