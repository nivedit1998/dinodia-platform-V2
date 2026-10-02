const clone = (value) => structuredClone(value);

export function offlineScopeAllowed(grant, requested) {
  return Boolean(grant && requested &&
    grant.accountId === requested.accountId &&
    grant.homeId === requested.homeId &&
    grant.homeMembershipId === requested.homeMembershipId &&
    grant.trustedDeviceId === requested.trustedDeviceId &&
    Array.isArray(grant.areaIds) && Array.isArray(requested.areaIds) &&
    requested.areaIds.every((areaId) => grant.areaIds.includes(areaId)));
}

export function projectPrivateSupportRecipients(scenario) {
  const ticket = scenario?.ticket;
  if (!ticket || ticket.scope !== "TENANT_DEVICE" || typeof ticket.homeMembershipId !== "string") return null;
  return (scenario.recipientCandidates ?? []).filter((membershipId) => membershipId === ticket.homeMembershipId);
}

export function invitationHasAuthority(invitation) {
  return Boolean(invitation && invitation.state === "accepted" &&
    invitation.explicitAcceptance === true && invitation.emailVerified === true &&
    invitation.authorityRevalidated === true &&
    typeof invitation.authenticatedAccountId === "string" &&
    invitation.authenticatedAccountId === invitation.recipientAccountId &&
    typeof invitation.membershipId === "string" && invitation.membershipId.length > 0);
}

export function assertDecisionMatrix(matrix) {
  const required = [
    ["support.privateTenantDeviceTicketNotifiesOwner", false],
    ["notification.deliveryReceiptGrantsAuthority", false],
    ["offline.scopeCanWiden", false],
    ["claim.duplicateOrNoOpCanExtend", false],
  ];
  for (const [pointer, expected] of required) {
    const actual = pointer.split(".").reduce((value, key) => value?.[key], matrix);
    if (actual !== expected) throw new Error(`Contradictory executable decision fixture: ${pointer}`);
  }
  const distribution = matrix?.distribution;
  const expectedDistribution = {
    bundleIdentifier: "com.dinodia.DinodiaV2",
    displayName: "Dinodia Smart Living",
    appStoreRecordDisplayName: "Dinodia Smart Living",
    appStoreRecordStatus: "external_record_and_signing_required",
    apnsTopic: "com.dinodia.DinodiaV2",
    keychainAccessGroup: "$(AppIdentifierPrefix)com.dinodia.DinodiaV2",
    teamIdentifier: "P759CSZK34",
    appSiteAssociationApplicationIdentifier: "P759CSZK34.com.dinodia.DinodiaV2",
    deepLinkScheme: "dinodia-v2",
    universalLinkPathPrefix: "/app/",
    oldAppImportAllowed: false,
    oldAppSessionReuseAllowed: false,
    oldAppPushTokenReuseAllowed: false,
    oldAppCachedHomeImportAllowed: false,
    oldAppDeepLinkAuthenticationAllowed: false,
  };
  for (const [key, expected] of Object.entries(expectedDistribution)) {
    if (distribution?.[key] !== expected) throw new Error(`Contradictory V2 distribution decision: ${key}`);
  }
  if (JSON.stringify(distribution.associatedDomains) !== JSON.stringify(["applinks:dinodia-platform-v2.vercel.app"])) {
    throw new Error("V2 Associated Domains must use only the canonical Production host");
  }
}

export function simulateClaimLifecycle(fixture) {
  const state = clone(fixture.initial);
  const applied = new Map();
  if (!state.emailVerified || fixture.competingClaim.winnerRemains !== state.claimantAccountId ||
      fixture.competingClaim.expectedOutcome !== "non_identifying_unavailable") {
    throw new Error("Claim reservation must be first-wins and non-identifying");
  }
  for (const event of fixture.events) {
    const at = Date.parse(event.at);
    const expires = Date.parse(state.expiresAt);
    if (!Number.isFinite(at) || !Number.isFinite(expires)) throw new Error(`Invalid claim event clock: ${event.eventId}`);
    if (state.state === "reserved" && at >= expires) state.state = "expired";
    if (state.state === "reserved" && event.kind === "required_save" && event.success === true && event.changed === true) {
      const prior = applied.get(event.idempotencyKey);
      if (prior) {
        if (prior.expiresAt !== state.expiresAt || prior.revision !== state.revision) {
          throw new Error(`Claim idempotent retry changed its durable result: ${event.eventId}`);
        }
      } else {
        state.expiresAt = new Date(at + 1_800_000).toISOString();
        state.revision += 1;
        applied.set(event.idempotencyKey, { expiresAt: state.expiresAt, revision: state.revision });
      }
    }
    if ((event.expectedState && state.state !== event.expectedState) ||
        (event.expectedExpiresAt && Date.parse(state.expiresAt) !== Date.parse(event.expectedExpiresAt)) ||
        (event.expectedRevision !== undefined && state.revision !== event.expectedRevision)) {
      throw new Error(`Claim lifecycle transition mismatch at ${event.eventId}`);
    }
  }
  return state;
}

export function assertStage2DecisionFixtures({ support, receipt, offline, decisionMatrix, claim }) {
  const privateRecipients = projectPrivateSupportRecipients(support);
  if (!privateRecipients || JSON.stringify(privateRecipients) !== JSON.stringify(support.expectedPrivateRecipients) ||
      privateRecipients.some((id) => id === "membership:owner-a") || support.expectedPrivateRecipients.includes("membership:owner-a")) {
    throw new Error("Private tenant-device support must remain visible only to its owning membership");
  }
  const authority = invitationHasAuthority(receipt.invitation);
  if (authority !== (receipt.expectedMembershipCreated === true) || authority || receipt.receipt?.deliveryState !== "sent") {
    throw new Error("A notification delivery receipt cannot create invitation or membership authority");
  }
  if (offlineScopeAllowed(offline.grant, offline.requested) !== (offline.expectedAllowed === true)) {
    throw new Error("Offline selection widened beyond the enrolled grant");
  }
  assertDecisionMatrix(decisionMatrix);
  simulateClaimLifecycle(claim);
  return true;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function deniedWithNoEffects(denied, label) {
  let protectedEffects = 0;
  if (!denied) protectedEffects += 1;
  assert(denied && protectedEffects === 0, `${label}: denial must have zero protected effects`);
  return { outcome: "denied", protectedEffects };
}

function executeSemanticFixture(path, value, adapters) {
  const { os, platform, schema, analytics } = adapters;
  const result = (outcome, details = {}) => ({ outcome, ...details });
  switch (path) {
    case "account-relationship-lifecycle.json": {
      const retained = new Set(value.retainedRelationshipKinds);
      const cases = value.cases.map((item) => {
        const actual = item.remainingRelationships.some((kind) => retained.has(kind))
          ? "ACCOUNT_RETAINED" : "ACCOUNT_AND_ACCOUNT_SCOPED_STATE_DELETED";
        assert(item.expected === actual, `account relationship ${item.id} expected ${item.expected}, got ${actual}`);
        return actual;
      });
      assert(value.tenantSelfRemoval.preservesOtherHomeMemberships === true &&
        value.tenantSelfRemoval.removesOnlySelectedMembership === true,
      "tenant removal must be membership-scoped");
      return result("accepted", { cases: cases.length });
    }
    case "customer-recovery-lifecycle.json":
      assert(value.cases.length >= 2 && value.cases.every((item) => item.accountExistsDisclosed === false && item.sessionIssued === false) &&
        value.cases[0].responseClass === value.cases[1].responseClass,
      "recovery must be anti-enumerating and issue no session");
      return result("accepted", { cases: value.cases.length });
    case "customer-session-receipt.json": {
      const now = Date.parse("2026-09-27T10:00:00Z");
      assert(schema("customerSessionReceipt", value) && platform.validateCustomerSessionReceipt(value, now) &&
        value.ok === true && !Object.keys(value).some((key) => /cookie|bearer|password|secret|privatekey/i.test(key)),
      "customer login receipt must be metadata-only and within its absolute lifetime");
      return result("accepted", { protectedEffects: 0 });
    }
    case "account-session-two-homes.json": {
      const now = Date.parse("2026-09-27T10:00:00Z");
      assert(platform.validateAccountSessionContext(value, now) && value.memberships.length === 2 &&
        new Set(value.memberships.map((membership) => membership.homeId)).size === 2 &&
        new Set(value.memberships.map((membership) => membership.homeMembershipId)).size === 2 &&
        new Set(value.memberships.map((membership) => membership.role)).size === 2,
      "account-global session must retain two distinct home-scoped roles without collapsing membership authority");
      return result("accepted", { memberships: value.memberships.length });
    }
    case "invalid/unknown-required-version.json": {
      const denied = value.expected === "UPDATE_REQUIRED" && !schema("envelope", value) &&
        !platform.validateEnvelope(value) && !os.validateEnvelope(value);
      return deniedWithNoEffects(denied, path);
    }
    case "error-home-denied.json": {
      assert(schema("error", value) && value.error.code === "HOME_MISMATCH" &&
        typeof value.error.requestId === "string" && !Object.hasOwn(value.error, "data"),
      "wrong-home denial must use the canonical error envelope without protected payload");
      return deniedWithNoEffects(true, path);
    }
    case "access-policy-selected-tenant.json": {
      assert(schema("accessPolicy", value) && value.role === "TENANT" &&
        value.homeId.length > 0 && value.homeMembershipId.length > 0 && value.areaIds.length > 0 &&
        value.scopes.includes("device.read") && value.scopes.includes("device.command"),
      "selected tenant policy must bind exact membership, home, and explicit area grants");
      return result("accepted", { areaGrants: value.areaIds.length });
    }
    case "multi-home-memberships.json": {
      const memberships = value.memberships.map((membership) => ({ accountId: value.accountId, ...membership }));
      assert(memberships.every((membership) => platform.validateMembership(membership)) &&
        new Set(memberships.map((membership) => membership.homeId)).size === memberships.length &&
        new Set(memberships.map((membership) => membership.homeMembershipId)).size === memberships.length,
      "each home role must validate as a distinct active membership under the same account");
      return result("accepted", { memberships: memberships.length });
    }
    case "multi-control-device.json": {
      const context = { homeId: value.device.homeId, role: "OWNER", areaIds: value.device.areaIds };
      assert(schema("device", value.device) && platform.validateNativeDevice(value.device, context) &&
        os.validateDevice(value.device, context) && new Set(value.device.controls.map((control) => control.controlId)).size === value.device.controls.length,
      "multi-control descriptor must decode consistently with unique control identities");
      return result("accepted", { controls: value.device.controls.length });
    }
    case "control-catalog-change.json": {
      const source = adapters.readFixture("fixtures/multi-control-device.json").device;
      const catalog = value.catalog;
      const current = { ...source, descriptorRevision: catalog.catalogRevision, controls: catalog.controls };
      const power = current.controls.find((control) => control.controlId === "control:power");
      const oldCommand = { ...adapters.readFixture("fixtures/command-valid.json"), controlId: "control:power", value: true };
      assert(schema("controlCatalog", catalog) && platform.validateNativeDevice(current) && os.validateDevice(current) && power &&
        catalog.deviceId === source.id && catalog.catalogRevision > source.descriptorRevision &&
        value.effects.preserveDeviceId === true && value.effects.invalidatePendingCommands === true &&
        value.effects.markIncompatibleAutomation === "needs_attention" &&
        !platform.validateCommandAgainstDevice(oldCommand, current, power, oldCommand.homeMembershipId) &&
        !os.validateCommand(oldCommand, current, power, oldCommand.homeMembershipId),
      "catalog revision must preserve device identity but reject queued commands bound to the prior descriptor");
      return result("accepted", { protectedEffects: 0, invalidatedControls: catalog.deletedControlIds.length });
    }
    case "command-valid.json": {
      const device = adapters.readFixture("fixtures/multi-control-device.json").device;
      const control = device.controls.find((item) => item.controlId === value.controlId);
      assert(schema("command", value) && control &&
        platform.validateCommandAgainstDevice(value, device, control, value.homeMembershipId) &&
        os.validateCommand(value, device, control, value.homeMembershipId),
      "canonical valid command must match current home, membership, control descriptor, value and UTC issue time");
      return result("accepted", { dispatchAllowedByContract: true });
    }
    case "claim-first-wins.json": {
      const created = Date.parse(value.createdAt); const expires = Date.parse(value.expiresAt);
      assert(schema("claimReservation", value) && value.state === "reserved" && value.firstWins === true &&
        Number.isFinite(created) && expires - created === 30 * 60 * 1000 && value.revision >= 1,
      "claim reservation must have one first winner and the exact fixed reservation lifetime");
      return result("accepted", { protectedEffects: 0 });
    }
    case "commissioning-expired.json": {
      const now = Date.parse("2026-09-27T10:00:00Z");
      assert(schema("commissioning", value) && value.state === "expired" &&
        Date.parse(value.expiresAt) <= now && value.candidateCount === 0,
      "expired commissioning must expose no selectable device candidate");
      return deniedWithNoEffects(true, path);
    }
    case "automation-full-bundle.json": {
      const device = adapters.readFixture("fixtures/multi-control-device.json").device;
      const controls = new Map(device.controls.map((control) => [control.controlId, control]));
      assert(schema("automation", value) && value.homeId === device.homeId && Number.isInteger(value.revision) &&
        value.revision > 0 && Array.isArray(value.actions) && value.actions.length > 0 &&
        value.actions.every((action) => {
          const control = controls.get(action.controlId);
          return action.deviceId === device.id && control && action.descriptorRevision === device.descriptorRevision &&
            control.writable && control.automatable && !["security_lock", "lock_state"].includes(control.semanticRole);
        }),
      "automation bundle must bind every action to the current writable, automatable non-security descriptor");
      return result("accepted", { actions: value.actions.length });
    }
    case "alexa-discovery-projection.json": {
      const member = value.membership;
      assert(schema("alexaDiscoveryProjection", value) && member.role === "TENANT" &&
        Number.isSafeInteger(value.exposureGeneration) && value.exposureGeneration >= 0 &&
        value.data.every((device) => device.homeId === value.homeId &&
          device.areaIds.every((areaId) => value.selectedAreaIds.includes(areaId)) &&
          (device.managementClass !== "tenant_device" || device.ownerMembershipId === member.homeMembershipId) &&
          device.controls.every((control) => !["security_lock", "lock_state"].includes(control.semanticRole) ||
            control.automatable === false && control.stepUpPolicy === "required")),
      "Alexa discovery must remain selected-tenant/area scoped and exclude app-only security authority");
      return result("accepted", { devices: value.data.length });
    }
    case "notification-security-mandatory.json": {
      assert(schema("notification", value) && value.kind === "security" && value.mandatory === true &&
        value.deliveryState.length > 0 && value.deduplicationKey.length > 0,
      "security notifications must remain mandatory and idempotently addressed");
      return result("accepted", { protectedEffects: 0 });
    }
    case "support-ticket-private.json": {
      assert(schema("supportTicket", value) && value.homeId && value.homeMembershipId &&
        value.status === "ACCESS_REQUESTED" && Array.isArray(value.customerVisibleUpdates) &&
        value.customerVisibleUpdates.every((update) => Object.keys(update).every((key) => ["kind", "text"].includes(key))),
      "tenant support DTO must remain bound to its membership and contain only customer-visible updates");
      return result("accepted", { updates: value.customerVisibleUpdates.length });
    }
    case "support-session-revoked.json": {
      assert(schema("supportSession", value) && value.status === "revoked",
        "revoked support lease must not be projected as active authority");
      return deniedWithNoEffects(true, path);
    }
    case "offline-home-selection.json": {
      const now = Date.parse(value.generatedAt);
      assert(schema("offlineHomeSelection", value) && platform.validateOfflineHomeSelection(value, now) &&
        value.candidates.every((candidate) => candidate.accountId === value.accountId && candidate.role === "TENANT" &&
          candidate.areaIds.length > 0 && (candidate.expiresAt === null || Date.parse(candidate.expiresAt) > now)),
      "offline home chooser must use a fresh exact-account tenant grant and still require the exact-home challenge");
      return result("accepted", { candidates: value.candidates.length, challengeRequired: true });
    }
    case "hub-cloudurl-verified.json": {
      const now = Date.parse("2026-09-27T10:07:00Z");
      assert(schema("hubInstallation", value) && value.cloudUrlState === "verified" &&
        platform.effectiveHubOnlineState(value.lastHeartbeatAt, now) === "online" &&
        platform.effectiveHubOnlineState(value.lastHeartbeatAt, now + 1) === "offline",
      "verified CloudURL identity and online heartbeat freshness are distinct and use the inclusive 420-second boundary");
      return result("accepted", { protectedEffects: 0 });
    }
    case "lan-endpoint-current.json":
    case "lan-endpoint-unavailable.json": {
      const serial = "din-home-001";
      const accepted = schema("lanEndpointObservation", value) && platform.validateLanEndpointObservation(value, serial, 8123);
      assert(accepted === (value.state === "CURRENT" || value.state === "UNAVAILABLE"),
        "LAN observation must validate the exact private interface state and reject malformed authority");
      if (value.state === "CURRENT") assert(value.baseUrl === "http://192.168.0.110:8123", "current LAN observation changed its fixture endpoint");
      else assert(!Object.hasOwn(value, "baseUrl"), "unavailable LAN observation must not retain a stale endpoint");
      return result("accepted", { state: value.state });
    }
    case "override-area-name.json": {
      assert(schema("override", value) && value.targetType === "area" && value.field === "overrideName" &&
        value.homeId.length > 0 && value.targetId.length > 0 && Number.isInteger(value.revision) && value.revision > 0 &&
        value.value.trim().length > 0,
      "area override must be a revisioned presentation preference, not an authority or grouping key");
      return result("accepted", { protectedEffects: 0 });
    }
    case "invalid/area-negative-revision.json": {
      const denied = !schema("area", value) && !platform.validateNativeArea(value, value.homeId) &&
        !os.validateArea(value, value.homeId);
      return deniedWithNoEffects(denied, path);
    }
    case "analytics-unknown-on-expiry.json": {
      const now = Date.parse(value.validUntil);
      const actual = analytics.classifyActivityV1({ ...value, signals: { powerOn: true } }, now);
      assert(actual === "unknown" && value.activity === "unknown",
        "expired analytics validity must dominate a positive activity signal and yield Unknown");
      return result("accepted", { quality: actual });
    }
    case "invitation-pending-no-membership.json": {
      assert(schema("membershipInvitation", value) && value.state === "pending" && value.membershipId === null,
        "an unaccepted invitation must not create membership authority");
      return deniedWithNoEffects(true, path);
    }
    case "support-access-property-scope.json": {
      assert(schema("supportAccessRequest", value) && value.scope === "PROPERTY_SCOPE" &&
        value.touchesPropertyInfrastructure === true && value.status === "approved" &&
        Number.isInteger(value.revision) && value.revision > 0,
      "property-scope support requires an explicit approved revision and cannot be inferred from a tenant-scoped request");
      return result("accepted", { protectedEffects: 0 });
    }
    case "customer-hub-session-test-only.json": {
      const now = Date.parse("2026-09-27T10:00:00Z");
      const denied = schema("customerHubSession", value) &&
        !platform.validateCustomerHubSession(value, { homeId: value.homeId, membershipId: value.membershipId }, now);
      return deniedWithNoEffects(denied, "test-only session sentinel is never an accepted bearer");
    }
    case "deleted-device-tombstone.json": {
      const tombstone = value.data;
      assert(schema("envelope", value) && platform.validateEnvelope(value, value.homeId) && os.validateEnvelope(value, value.homeId) &&
        tombstone.kind === "device_tombstone" && typeof tombstone.deviceId === "string" &&
        Number.isInteger(tombstone.deviceRevision) && tombstone.deletedAt && tombstone.historicalAnalyticsRetained === true &&
        !Object.hasOwn(tombstone, "controls"),
      "device deletion must use a scoped tombstone that retains history without projecting commandable controls");
      return result("accepted", { protectedEffects: 0 });
    }
    case "analytics-semantics.json": {
      const now = Date.parse(value.now);
      for (const item of value.activityCases) assert(analytics.classifyActivityV1(item, now) === item.expected, `activity ${item.id}`);
      assert(JSON.stringify(analytics.averageContributingSamplesV1(value.aggregation.periodSamples)) === JSON.stringify(value.aggregation.periodExpected), "period aggregation mismatch");
      assert(JSON.stringify(analytics.sumSelectedDevicesPerHourV1(value.aggregation.hourSamples)) === JSON.stringify(value.aggregation.hourExpected), "hourly aggregation mismatch");
      assert(JSON.stringify(analytics.averageDisplayedBucketsV1(value.aggregation.displayedBuckets)) === JSON.stringify(value.aggregation.summaryExpected), "displayed-bucket summary mismatch");
      return result("accepted", { cases: value.activityCases.length + 3 });
    }
    case "claim-lifecycle.json":
      simulateClaimLifecycle(value);
      assert(value.competingClaim.expectedOutcome === "non_identifying_unavailable", "competing claim must fail without identifying the winner");
      return result("accepted", { cases: value.events.length });
    case "invitation-lifecycle.json": {
      const expires = Date.parse(value.initial.expiresAt);
      const actualFor = (item) => {
        const sameRecipient = item.authenticatedAccountId === value.initial.recipientAccountId;
        if (!sameRecipient) return "INVITATION_RECIPIENT_MISMATCH";
        if (!item.emailVerified) return "EMAIL_VERIFICATION_REQUIRED";
        if (!item.explicitAccept) return "INVITATION_PENDING";
        if (Date.parse(item.at) >= expires) return "INVITATION_EXPIRED";
        return item.authorityRevalidated ? "MEMBERSHIP_ACTIVE" : "INVITATION_PENDING";
      };
      for (const item of value.cases) {
        const actual = actualFor(item);
        assert(item.expected === actual, `invitation ${item.id}: ${actual}`);
        assert(item.membershipId === (actual === "MEMBERSHIP_ACTIVE" ? "membership:recipient-home" : null), `invitation ${item.id} membership effect`);
      }
      return result("accepted", { cases: value.cases.length });
    }
    case "invalid/analytics-invalid-sample.json": {
      const sample = value.sample;
      const valid = [sample.onMinutes, sample.offMinutes, sample.unknownMinutes].every((n) => Number.isFinite(n) && n >= 0);
      assert(!valid && value.expected === "reject", "invalid analytics sample must be rejected");
      return deniedWithNoEffects(true, path);
    }
    case "invalid/device-missing-step-up-policy.json":
    case "invalid/device-invalid-step-up-policy.json": {
      const mutation = path.split("/").at(-1) === "device-missing-step-up-policy.json" ? value : value;
      const source = adapters.readFixture(mutation.sourceFixture);
      const device = clone(source.device);
      const control = device.controls.find((entry) => entry.controlId === mutation.controlId);
      assert(control, `${path}: source control missing`);
      if (path.endsWith("device-missing-step-up-policy.json")) delete control[mutation.removeField];
      else control[mutation.field] = mutation.invalidValue;
      const denied = !schema("device", device) && !platform.validateNativeDevice(device) &&
        !os.validateDevice(device, { homeId: device.homeId, homeMembershipId: "membership:owner-a", role: "OWNER", areaIds: device.areaIds });
      return deniedWithNoEffects(denied, path);
    }
    case "invalid/wrong-home-envelope.json": {
      const expectedHome = value.data.expectedSelectedHomeId;
      const denied = value.homeId !== expectedHome && !platform.validateEnvelope(value, expectedHome) && !os.validateEnvelope(value, expectedHome);
      return deniedWithNoEffects(denied, path);
    }
    case "invalid/tenant-device-wrong-owner.json": {
      const context = { ...value.context, role: "TENANT", areaIds: value.device.areaIds };
      const denied = value.device.managementClass === "tenant_device" && value.device.ownerMembershipId !== context.homeMembershipId &&
        !platform.validateNativeDevice(value.device, context) && !os.validateDevice(value.device, context);
      return deniedWithNoEffects(denied, path);
    }
    case "invalid/offline-home-wrong-account.json":
    case "invalid/offline-home-expired.json": {
      const now = Date.parse(value.generatedAt);
      const structural = schema("offlineHomeSelection", value);
      const denied = structural && !platform.validateOfflineHomeSelection(value, now);
      return deniedWithNoEffects(denied, path);
    }
    case "selected-tenant-property-device.json":
    case "selected-tenant-private-device.json": {
      const allowed = platform.validateNativeDevice(value.device, value.context) && os.validateDevice(value.device, value.context);
      assert(allowed, `${path}: selected tenant must read its authorized device`);
      if (value.device.managementClass === "tenant_device") {
        const wrongMembership = { ...value.context, homeMembershipId: "membership:other-tenant" };
        const denied = !platform.validateNativeDevice(value.device, wrongMembership) && !os.validateDevice(value.device, wrongMembership);
        deniedWithNoEffects(denied, `${path}: wrong tenant`);
      }
      return result("accepted", { protectedEffects: 0 });
    }
    case "unknown-interaction-kind.json": {
      const control = value.device.controls[0];
      assert(value.expected.startsWith("safe-read-only") && control?.writable === false && control?.automatable === false &&
        platform.validateNativeDevice(value.device) && os.validateDevice(value.device),
      "unknown interaction must remain decodable as read-only without inferred capability");
      return result("accepted", { protectedEffects: 0 });
    }
    case "invalid/stale-descriptor-command.json": {
      const source = adapters.readFixture("fixtures/multi-control-device.json");
      const device = source.device;
      const control = device.controls.find((entry) => entry.controlId === value.command.controlId);
      const command = { ...value.command, homeId: device.homeId, deviceId: device.id, descriptorRevision: value.command.descriptorRevision };
      const denied = control && value.command.descriptorRevision < value.currentDescriptorRevision &&
        !platform.validateCommandAgainstDevice(command, device, control, value.command.homeMembershipId) &&
        !os.validateCommand(command, device, control, value.command.homeMembershipId);
      return deniedWithNoEffects(denied, path);
    }
    case "invalid/impossible-calendar-date-command.json": {
      const source = adapters.readFixture("fixtures/multi-control-device.json");
      const device = source.device;
      const command = value.command;
      const control = device.controls.find((entry) => entry.controlId === command.controlId);
      const denied = Boolean(control && value.expected === "reject_before_dispatch" &&
        !schema("command", command) &&
        !platform.validateCommandAgainstDevice(command, device, control, command.homeMembershipId) &&
        !os.validateCommand(command, device, control, command.homeMembershipId));
      return deniedWithNoEffects(denied, path);
    }
    case "invalid/control-state-boolean-string.json": {
      const source = adapters.readFixture("fixtures/multi-control-device.json");
      const device = source.device;
      const control = device.controls.find((entry) => entry.controlId === value.data.controlId);
      const denied = control?.valueType === "boolean" && !platform.validateControlState(value.data, device, control) &&
        !os.validateControlState(value.data, device, control);
      return deniedWithNoEffects(denied, path);
    }
    case "invalid/writable-unreadable-control.json": {
      const source = adapters.readFixture(value.sourceFixture);
      const device = clone(source.device);
      const control = device.controls.find((entry) => entry.controlId === value.mutation.controlId);
      assert(control, "writable/unreadable source control missing");
      Object.assign(control, value.mutation);
      const denied = !platform.validateNativeDevice(device) && !os.validateDevice(device, { homeId: device.homeId, homeMembershipId: "membership:owner-a", role: "OWNER", areaIds: device.areaIds });
      return deniedWithNoEffects(denied, path);
    }
    case "invalid/unknown-interaction-commandable.json": {
      const source = adapters.readFixture(value.sourceFixture);
      const device = clone(source.device);
      const control = device.controls.find((entry) => entry.controlId === value.controlId);
      assert(control, "unknown interaction source control missing");
      Object.assign(control, value.mutation);
      const denied = !platform.validateNativeDevice(device) && !os.validateDevice(device, { homeId: device.homeId, homeMembershipId: "membership:owner-a", role: "OWNER", areaIds: device.areaIds });
      return deniedWithNoEffects(denied, path);
    }
    case "duplicate-display-names.json": {
      const matrix = adapters.readFixture("fixtures/stage2-decision-matrix.json");
      const property = matrix.property;
      const scope = property.areaScopeMemberships;
      const areas = value.areas.map((area) => ({ ...area, homeId: value.homeId }));
      const ids = areas.map((area) => area.id);
      const decisionIds = property.areas.map((area) => area.id);
      assert(value.homeId === property.homeId &&
        areas.every((area) => schema("area", area) && os.validateArea(area, value.homeId)) &&
        new Set(ids).size === areas.length && JSON.stringify([...ids].sort()) === JSON.stringify([...decisionIds].sort()) &&
        new Set(areas.map((area) => (area.overrideName ?? area.originalName).trim().toLowerCase())).size < areas.length &&
        JSON.stringify([...property.fullGrantCombinedAreaIds].sort()) === JSON.stringify([...ids].sort()) &&
        new Set(property.partialGrantCombinedAreaIds).size === property.partialGrantCombinedAreaIds.length &&
        property.partialGrantCombinedAreaIds.length > 0 && property.partialGrantCombinedAreaIds.length < ids.length &&
        property.partialGrantCombinedAreaIds.every((id) => ids.includes(id)) &&
        scope.ownerMembershipId === matrix.identity.activeOwnerMembershipIds[0] &&
        matrix.identity.activeOwnerMembershipIds.length === 1 &&
        JSON.stringify([...scope.managerMembershipIds].sort()) === JSON.stringify([...matrix.identity.activeManagerMembershipIds].sort()) &&
        scope.managerMembershipIds.length === new Set(scope.managerMembershipIds).size &&
        scope.partialTenantMembershipId === matrix.tenantPrivacy.ownerMembershipId,
      "same-name area scenario must bind to its Home, preserve each area ID, and apply exact owner/manager/full and tenant/partial membership grants");
      return result("accepted", { cases: areas.length });
    }
    case "notification-delivery-is-not-authority.json": {
      const authority = invitationHasAuthority(value.invitation);
      assert(value.receipt.deliveryState === "sent" && !authority && value.invitation.membershipId === null,
        "delivery receipt cannot create invitation or membership authority");
      return deniedWithNoEffects(true, path);
    }
    case "offline-scope-widening.json": {
      const denied = !offlineScopeAllowed(value.grant, value.requested);
      assert(denied, "offline scope widening must be denied");
      return deniedWithNoEffects(denied, path);
    }
    case "support-private-notification.json": {
      const actual = projectPrivateSupportRecipients({ ticket: value.ticket, recipientCandidates: value.recipientCandidates });
      assert(JSON.stringify(actual) === JSON.stringify(value.expectedPrivateRecipients), "private support recipient projection differs");
      assert(!actual.includes("membership:owner-a"), "private tenant support must not notify owner");
      return result("accepted", { protectedEffects: 0, recipients: actual.length });
    }
    case "support-lifecycle.json": {
      assert(value.categories.length === 7 && new Set(value.categories).size === 7 &&
        value.privateTenantOnly.ownerNotice === false && value.privateTenantOnly.tenantPrivateDetailsInOwnerNotice === false &&
        value.approval.proofMustBeDerivedFromStoredHash === false && value.approval.oneUseCodeAndProofConsumedAtomically === true &&
        value.approval.replayDenied === true && value.closure.cloudAuthorityRevokedImmediately === true &&
        value.closure.pendingHubAcknowledgementPermitsRenewal === false,
      "support lifecycle, privacy, approval or closure decision mismatch");
      const recipients = projectPrivateSupportRecipients({ ticket: { scope: "TENANT_DEVICE", homeMembershipId: value.privateTenantOnly.ticketMembershipId }, recipientCandidates: value.privateTenantOnly.recipientCandidates });
      assert(JSON.stringify(recipients) === JSON.stringify(value.privateTenantOnly.expectedRecipients), "support lifecycle audience mismatch");
      return result("accepted", { cases: value.approvalBoundaryCases.length + 1 });
    }
    case "transfer-lifecycle.json": {
      const byId = new Map(value.cases.map((item) => [item.id, item]));
      for (const id of ["active-tenant-successor", "manager-cancel", "retry-other-presentation"]) {
        const item = byId.get(id);
        assert(item && item.mutation === false, `transfer denial ${id} must have zero effects`);
        deniedWithNoEffects(true, `${path}:${id}`);
      }
      assert(value.completion.historyRewritten === false && value.activeClaim.concurrentTransferAllowed === false,
        "transfer must preserve history and serialize competing transfers");
      return result("accepted", { cases: value.cases.length });
    }
    case "moved-device.json":
      assert(value.areaAssignment.revision > value.history.priorAssignmentRevision &&
        value.areaAssignment.currentAreaId !== value.history.priorAreaId && value.history.rewriteHistory === false,
      "move must advance current assignment without rewriting history");
      return result("accepted", { protectedEffects: 0 });
    case "multi-channel-mixed-controls.json": {
      const controls = value.channels.flatMap((surface) => surface.controls);
      assert(controls.length > 0 && new Set(controls.map((control) => `${control.deviceId ?? ""}/${control.controlId}`)).size === controls.length,
        "multi-channel fixture must retain unique device/control identities");
      assert(controls.every((control) => control.writable !== true || control.readable === true),
        "writable controls must be readable");
      return result("accepted", { controls: controls.length });
    }
    case "customer-label-unicode-boundaries.json": {
      const codePoints = (text) => Array.from(text).length;
      for (const item of value.cases) {
        const raw = typeof item.value === "string" ? item.value : item.repeat.repeat(item.repeatCount);
        const projected = Object.hasOwn(item, "projected") ? (item.projected ?? "") : item.repeat.repeat(item.projectedRepeatCount);
        assert(codePoints(projected ?? "") === item.projectedCodePoints &&
          item.wireValid === (codePoints(raw) <= value.maximumPublicCodePoints) &&
          codePoints(projected ?? "") === Math.min(codePoints(raw), value.maximumPublicCodePoints),
        `customer label ${item.id}`);
      }
      assert(value.authority === "presentation_only", "labels are presentation-only");
      return result("accepted", { cases: value.cases.length });
    }
    case "bounded-string-unicode-semantics.json": {
      for (const item of [...value.boundaryCases, ...value.combiningSequenceCases]) {
        const valid = Array.from(item.repeat.repeat(item.validRepeatCount)).length <= item.maximum;
        const over = Array.from(item.repeat.repeat(item.invalidRepeatCount)).length > item.maximum;
        assert(valid && over, `Unicode boundary ${item.id}`);
      }
      return result("accepted", { cases: value.boundaryCases.length + value.combiningSequenceCases.length });
    }
    case "hub-heartbeat-freshness.json": {
      const now = Date.parse(value.now);
      for (const item of value.cases) assert(platform.effectiveHubOnlineState(item.lastHeartbeatAt, now) === item.expected, `heartbeat ${item.id}`);
      return result("accepted", { cases: value.cases.length });
    }
    case "notification-lifecycle.json": {
      const privateCase = value.audienceCases.find((item) => item.id === "private-tenant-device");
      assert(privateCase && JSON.stringify(privateCase.candidates.filter((id) => id === privateCase.currentMembershipId)) === JSON.stringify(privateCase.expectedRecipients) &&
        value.deduplication.receiptCreatesAuthority === false && value.deduplication.receiptCreatesMembership === false,
      "notification audience or receipt authority mismatch");
      return result("accepted", { cases: value.cases.length + value.audienceCases.length });
    }
    case "out-of-order-events.json": {
      const applied = [...new Set(value.events.map((event) => event.sequence))].sort((a, b) => b - a).slice(0, 1);
      assert(JSON.stringify(applied) === JSON.stringify(value.expectedAppliedSequences) && value.newStreamRequiresFullSnapshot === true,
        "out-of-order events must apply only the latest sequence and recover with a full snapshot");
      return result("accepted", { appliedSequenceCount: applied.length });
    }
    case "replacement-hub.json":
      assert(value.hubInstallationId !== value.previousHubInstallationId && value.nameBasedMergeAllowed === false,
        "replacement hub identity must not merge by name");
      return result("accepted", { protectedEffects: 0 });
    case "stale-policy.json":
      assert(value.currentPolicyRevision > value.cachedPolicyRevision && value.expected.canMutate === false &&
        value.expected.canWidenOfflineScope === false && value.expected.clearStaleAuthorityBeforeReconnect === true,
      "stale policy must deny writes and offline scope widening before reconnect");
      return deniedWithNoEffects(true, path);
    case "trusted-device-revocation.json":
      assert(new Set(value.affectedMemberships).size === value.affectedMemberships.length && value.affectedMemberships.length >= 2 &&
        value.expected.allSessionsForInstallationRevoked === true && value.expected.allOfflineLanAuthorisationsForInstallationRevoked === true &&
        value.expected.unrelatedTrustedDevicePreserved === true,
      "trusted-device revocation must be account-installation-wide and preserve unrelated installations");
      return deniedWithNoEffects(true, path);
    case "offline-deregistration-pending.json":
      assert(value.platformAuthority === "revoked" && value.hubAcknowledgement === "pending" &&
        value.expected.protectedCustomerReads === false && value.expected.protectedCommands === false &&
        value.expected.reportComplete === false && value.expected.retainedPhysicalPropertyPreserved === true,
      "offline deregistration must revoke authority before hub acknowledgement without claiming completion");
      return deniedWithNoEffects(true, path);
    case "room-qr-lifecycle.json": {
      assert(value.request.emailVerificationRequiredBeforeOwnerVisibility === true && value.request.ownerlessQrRequestPersists === false &&
        value.request.grantIsExactlyRequestedCanonicalArea === true, "Room QR visibility and exact-area authority mismatch");
      for (const item of value.cases) {
        const actual = item.areaLifecycle === "retired" ? "AREA_NOT_AVAILABLE" : item.activeOwnerExists === false ? "NO_DURABLE_REQUEST" :
          item.previousState === "REJECTED" && item.elapsedSeconds === 0 ? "NEW_REQUEST_ALLOWED" :
          item.elapsedSeconds >= value.request.lifetimeSeconds ? "REQUEST_EXPIRED" : !item.emailVerified ? "WAITING_FOR_EMAIL_VERIFICATION" :
            item.approved ? "MEMBERSHIP_ACTIVE" : "PENDING_OWNER_DECISION";
        assert(actual === item.expected, `Room QR case ${item.id}: ${actual}`);
        if (actual !== "MEMBERSHIP_ACTIVE") deniedWithNoEffects(true, `${path}:${item.id}`);
      }
      return result("accepted", { cases: value.cases.length });
    }
    case "prototype-scenarios.json": {
      const flows = Object.entries(value.flows);
      for (const [flowId, flow] of flows) {
        assert(flow.initialOutcome.trim() && flow.actions.length > 0, `prototype flow ${flowId} has no state or action`);
        for (const action of flow.actions) assert(action.id && action.label && action.outcome &&
          (!action.allowedRoles || action.allowedRoles.every((role) => ["Homeowner", "Property manager", "Tenant"].includes(role))),
        `prototype action ${flowId}/${action.id} is not executable/renderable`);
      }
      return result("accepted", { flows: flows.length, actions: flows.reduce((sum, [, flow]) => sum + flow.actions.length, 0) });
    }
    case "stage2-decision-matrix.json": {
      assertStage2DecisionFixtures({
        support: adapters.readFixture("fixtures/support-private-notification.json"),
        receipt: adapters.readFixture("fixtures/notification-delivery-is-not-authority.json"),
        offline: adapters.readFixture("fixtures/offline-scope-widening.json"),
        decisionMatrix: value,
        claim: adapters.readFixture("fixtures/claim-lifecycle.json"),
      });
      return result("accepted", { domains: 16 });
    }
    case "ios-v2-distribution-identity.json": {
      const expected = adapters.readFixture("fixtures/stage2-decision-matrix.json").distribution;
      const identityKeys = ["bundleIdentifier", "displayName", "appStoreRecordDisplayName", "appStoreRecordStatus", "apnsTopic", "keychainAccessGroup", "teamIdentifier", "appSiteAssociationApplicationIdentifier", "associatedDomains", "deepLinkScheme", "universalLinkPathPrefix"];
      assert(value.schemaVersion === "dinodia.v1" && identityKeys.every((key) => JSON.stringify(value[key]) === JSON.stringify(expected[key])),
        "V2 distribution fixture identity must match canonical decisions");
      const forbidden = value.forbiddenLegacyState;
      assert(forbidden && ["oldAppImportAllowed", "oldAppSessionReuseAllowed", "oldAppPushTokenReuseAllowed", "oldAppCachedHomeImportAllowed", "oldAppDeepLinkAuthenticationAllowed"].every((key) => forbidden[key] === false),
        "V2 app must not import or reuse legacy app state");
      assert(JSON.stringify(value.externalEvidenceRequired) === JSON.stringify([
        "App Store Connect record assigned to bundleIdentifier",
        "Apple signing and provisioning profile",
        "APNs production registration and push delivery",
      ]), "External Apple distribution evidence must remain explicitly outstanding");
      return result("accepted", { externalDistributionEvidence: "not-proven" });
    }
    default:
      return null;
  }
}

/** Execute one fixture for every screen/action that indexes it. This deliberately
 * returns an expected semantic outcome and denial side-effect count, rather than
 * treating a valid JSON parse as scenario evidence. */
export function executeIndexedFixtureScenario({ screenKey, fixturePath, fixture, schemaChecks, adapters }) {
  assert(typeof screenKey === "string" && screenKey.length > 0, "indexed scenario has no screen/action key");
  assert(typeof fixturePath === "string" && fixture && typeof fixture === "object", `${screenKey}: fixture is missing`);
  const checks = [];
  for (const item of schemaChecks) {
    const actual = Boolean(item.validate(item.select(fixture)));
    assert(actual === item.expected, `${screenKey} -> ${fixturePath}: expected ${item.schema} ${item.expected ? "accept" : "reject"}, got ${actual}`);
    if (!actual) deniedWithNoEffects(true, `${screenKey}:${item.schema}`);
    checks.push({ schema: item.schema, outcome: actual ? "accepted" : "denied" });
  }
  const semantic = executeSemanticFixture(fixturePath.replace(/^fixtures\//, ""), fixture, adapters);
  assert(semantic, `${screenKey} -> ${fixturePath}: no owning semantic validator, adapter, reducer or decision executor is registered`);
  const denied = [...checks.map((item) => item.outcome), semantic?.outcome].filter((outcome) => outcome === "denied").length;
  const zeroEffectDenials = checks.filter((item) => item.outcome === "denied").length +
    (semantic?.protectedEffects === 0 ? 1 : 0);
  return { screenKey, fixturePath, expectedOutcome: denied ? "contains-denial" : "accepted", actualOutcome: "matched", schemaChecks: checks.length, semantic: semantic?.outcome ?? "schema", zeroEffectDenials };
}
