# Native V2 schema classification — Stage 3

Reviewed source is the post-Stage-2 Prisma schema and the additive migration `20261003000000_native_v2_stage3_domain_schema`. The foundation and Stage 1 migrations remain immutable. This document classifies every current Prisma model exactly once. No model is marked `Needs decision`.

## Model inventory

| Prisma model | Classification |
|---|---|
| CustomerAccount | Evolve |
| CompanyEmployeeAccount | Evolve |
| TrustedDevice | Evolve |
| CustomerSession | Reuse unchanged |
| PolicyAcceptance | Reuse unchanged |
| AuthChallenge | Reuse unchanged |
| StepUpAuthorization | Reuse unchanged |
| Home | Evolve |
| HomeMembership | Evolve |
| Area | Evolve |
| TenantAreaGrant | Reuse unchanged |
| NativeDevice | Evolve |
| DeviceAreaAssignment | Reuse unchanged |
| HubManufacturingIdentity | Reuse unchanged |
| CompanyOperationalWorkItem | Reuse unchanged |
| HubInstallation | Evolve |
| HubCredentialVersion | Reuse unchanged |
| HubProvisioningAttempt | Reuse unchanged |
| MembershipInvitation | Reuse unchanged |
| MembershipInvitationArea | Reuse unchanged |
| AreaQrCredential | Reuse unchanged |
| AreaAccessRequest | Reuse unchanged |
| HomeClaimReference | Reuse unchanged |
| HomeClaimChallenge | Reuse unchanged |
| HomeClaimReservation | Reuse unchanged |
| PendingHomeSetup | Reuse unchanged |
| HomeDocument | Reuse unchanged |
| MemberPreferenceDocument | Reuse unchanged |
| AuditEvent | Reuse unchanged |
| DeletionSecurityReceipt | Reuse unchanged |
| IdempotencyRecord | Reuse unchanged |
| ReplayNonce | Reuse unchanged |
| AuthRateLimitBucket | Reuse unchanged |
| InitialCxoBootstrap | Reuse unchanged |
| EmployeeSession | Reuse unchanged |
| OperatorHandoff | Reuse unchanged |
| OperatorBrowserAttempt | Reuse unchanged |
| StepUpChallenge | Reuse unchanged |
| SupportTicket | Evolve |
| SupportAccessRequest | Reuse unchanged |
| SupportSession | Reuse unchanged |
| SupportAccessNotification | Reuse unchanged |
| OfflineMembershipAuthorisation | Reuse unchanged |
| CloudUrlVerification | Reuse unchanged |
| AreaSourceAlias | Add native |
| NativeDeviceSourceAlias | Add native |
| PermanentDeviceInstallationRequest | Add native |
| NativeCommissioningSession | Add native |
| NativeDeviceUsageBucket | Add native |
| NativeTemperatureSample | Add native |
| NativeAutomation | Add native |
| NativeAutomationTrigger | Add native |
| NativeAutomationAction | Add native |
| NativeAutomationExecution | Add native |
| AlexaNativeLink | Add native |
| AlexaNativeHomeScope | Add native |
| AlexaNativeEndpointProjection | Add native |
| AlexaNativeDirectiveReceipt | Add native |
| NativeBackgroundTaskState | Add native |
| NativeDomainOutbox | Add native |
| NativeNotificationDeliveryReceipt | Add native |
| NativeDeviceOutageIncident | Add native |
| NativeSupportTicketTimeline | Add native |
| ExceptionalOwnershipTransfer | Add native |
| NativeTenantDeviceRecovery | Add native |

`Evolve` changes preserve the existing authority: account and membership identity remain global-account plus `HomeMembership`; Home/HubInstallation gain explicit current installation and replacement lifecycle; TrustedDevice gains APNs registration on the same installation identity; NativeDevice remains the sole inventory projection and narrows `customerLabel` to the frozen 40-character bound; SupportTicket remains the single ticket authority. Reverse Prisma relations alone do not create a second SQL authority.

## Add-native ownership, lifecycle and data boundary

| Model | Authority and lifecycle | Home binding and privacy | Uniqueness, retention and consumer |
|---|---|---|---|
| AreaSourceAlias | OS protocol alias to one canonical Area; refreshed while observed, retired on replacement | Area, Home and active hub share a home; never authorization | Unique hub/protocol/source ID; retained with native alias history; OS inventory reconciliation, Stage 5 |
| NativeDeviceSourceAlias | Protocol identity to one canonical NativeDevice; immutable identity mapping | Device and hub bind to one Home; protocol ID is operationally private | Unique hub/protocol/source ID; protocol identity is a digest; retained through replacement; OS reconciliation, Stage 5 |
| PermanentDeviceInstallationRequest | Customer service request progresses SUBMITTED→IN_PROGRESS→COMPLETED/CANCELLED | Requester and optional area bind to same Home; customer notes visible to assigned installer roles only | Unique customer reference and email idempotency key; deleted with supported home lifecycle; Company Portal installer queue, Stage 5 |
| NativeCommissioningSession | Bounded pairing/recovery attempt with terminal state and final canonical device ID | Home, hub, requester, optional Area and result device are same-home; requester-only progress plus installer execution | Unique home/idempotency digest; expiry timestamp and bounded cleanup; OS commissioning flow, Stage 5 |
| NativeDeviceUsageBucket | OS-authored hourly absolute On/Off/Unknown counters, revisioned while open and immutable when closed | Permanent property device and observation-time canonical Area only; tenant devices excluded | Unique device/area/category/control/hour/source generation; purge ceiling 12 months; analytics, Stage 10 |
| NativeTemperatureSample | OS-authored temperature sample from a trustworthy permanent Radiator role | Permanent Radiator and canonical observation-time Area; homeowner projection only | Indexed by home/device/time; purge ceiling 12 months; Home Temperature, Stage 10 |
| NativeAutomation | Canonical home automation header, revision and content checksum | Creator is same-home membership; property management and privacy follow role | Opaque ID plus revision/checksum; retired records purge by bounded policy; automation composer, Stage 11 |
| NativeAutomationTrigger | Typed/versioned trigger configuration owned by one automation | Parent automation is sole access authority | Indexed by automation/kind; cascades with parent; automation engine, Stage 11 |
| NativeAutomationAction | Canonical device/control/area action and last validated descriptor revision | All targets same-home; tenant-private targets are not projected to owner/manager | Indexed by automation and device/control conflict key; cascades with parent; OS automation execution, Stage 11 |
| NativeAutomationExecution | Idempotent bounded execution receipt, not live state | Home and parent automation bound together; safe outcome only | Unique idempotency key; explicit purge timestamp; operations/automation projections, Stage 11 |
| AlexaNativeLink | Encrypted provider credentials and link status for one neutral customer identity | Account-global link; usable native homes are derived only from current tenant memberships | Unique provider subject digest; token ciphertext/key version; revoked/expired cleanup; Alexa OAuth, Stage 12 |
| AlexaNativeHomeScope | Explicit selected tenant membership, canonical areas and exposure generation | Database trigger requires link owner = active tenant membership and current area grants | Unique link/membership; revocation retained as bounded current state; discovery scope, Stage 12 |
| AlexaNativeEndpointProjection | Bounded tenant endpoint cache derived from selected current scope | Same-home link/member/device/area; excludes other tenants and app-only security controls | Unique link/device and endpoint ID; replaced by exposure generation; Alexa discovery, Stage 12 |
| AlexaNativeDirectiveReceipt | Idempotent request/event-token digest and safe result status | Link-scoped; no household data or reusable credential | Unique provider request ID and bounded expiry; Alexa report/directive replay defense, Stage 12 |
| NativeBackgroundTaskState | One current checkpoint/lease/outcome row per frozen shared dispatcher task | System-only operational state; no customer projection | Exactly four seeded fixed task IDs; cursor/outcome each ≤16 KiB; leases 120 seconds; two existing dispatchers, Stage 3/5 |
| NativeDomainOutbox | Bounded retryable domain event, payload and dedupe state | Optional Home/hub relationship is same-home; no secrets or live-state mirror | Unique idempotency key, payload ≤16 KiB, at most 12 attempts and 30-day expiry; shared dispatchers, Stage 5 |
| NativeNotificationDeliveryReceipt | Push/email delivery and dedupe receipt only | Account, optional trusted device and membership must agree; no inbox or authority | Unique event-recipient-channel key, at most 8 attempts and 30-day expiry; notification transport, Stage 9 |
| NativeDeviceOutageIncident | Durable continuous offline qualification and recovery state | Exactly one home device or hub source; tenant-device audiences remain private | One open incident per device/hub, exact 60-minute alert eligibility; bounded incident cleanup; notifications, Stage 9 |
| NativeSupportTicketTimeline | Append-only safe customer-visible or employee-only ticket transition | Ticket/home composite reference; redact private tenant device fields by audience | Indexed ticket/time and purge timestamp; 12-month ticket timeline; support activity, Stage 8 |
| ExceptionalOwnershipTransfer | Restricted staff-verification case that can issue an ordinary transfer claim but cannot mutate owner membership | Current owner and optional claim are home-bound; employee roles restricted to CXO/Senior Operations Manager | One open case per Home; encrypted proposed contact, key version, audit transitions; support/installer, Stage 8 |
| NativeTenantDeviceRecovery | Encrypted 30-day private recommission snapshot for an existing tenant-owned device | Device owner membership, replacement hub and Home are bound; invisible to owners/managers | Unique device/replacement hub; exact 30-day expiry; tenant recovery, Stage 5 |

## Absent by design

These are not Prisma models, columns, relations, SQL functions or migration targets: `HaConnection`, HA entities, HA override/analytics/automation registries, legacy `User.homeId`, a second membership/room authority, and label-registry tables. Native control/live state remains authoritative in Dinodia OS. No HA import, data backfill, duplicate customer authority or old-app session import is part of this schema.

## Migration review boundary

The migration is forward-only and additive except for the approved removal of the foundation's one-hub-per-home unique index when explicit active-hub lineage replaces it. No table, column or enum is dropped; no production rows are deleted. Existing hub rows are classified ACTIVE and backfilled into `Home.activeHubInstallationId`. New notification/task/automation/history tables start empty. Roll back application deployment to the prior schema-compatible V2 release; do not issue a reverse DROP migration. If database recovery is ever necessary, use the recorded provider backup through the separately reviewed recovery process, never an HA fallback.
