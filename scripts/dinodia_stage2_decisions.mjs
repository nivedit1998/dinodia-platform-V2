import fs from 'node:fs';

const clone = (value) => structuredClone(value);
const decisionRegister = JSON.parse(fs.readFileSync(new URL('../contracts/dinodia-v1/decisions.json', import.meta.url), 'utf8'));

export function assertAccountRelationshipLifecycle(value) {
  const identity = decisionRegister.identityLifecycle;
  const retaining = identity.accountRetainingRelationshipKinds;
  const nonRetaining = identity.accountNonRetainingRelationshipKinds;
  assert(value?.schemaVersion === decisionRegister.version &&
    Array.isArray(value.retainedRelationshipKinds) && Array.isArray(value.nonRetainingKinds) &&
    JSON.stringify(value.retainedRelationshipKinds) === JSON.stringify(retaining) &&
    JSON.stringify(value.nonRetainingKinds) === JSON.stringify(nonRetaining),
  'account relationship fixture taxonomy differs from the canonical decision register');

  const known = new Set([...retaining, ...nonRetaining]);
  const caseIds = new Set();
  assert(Array.isArray(value.cases) && value.cases.length > 0, 'account relationship fixture has no executable cases');
  for (const item of value.cases) {
    assert(typeof item.id === 'string' && item.id.length > 0 && !caseIds.has(item.id),
      'account relationship fixture has an invalid or duplicate case ID');
    caseIds.add(item.id);
    assert(Array.isArray(item.remainingRelationships) &&
      new Set(item.remainingRelationships).size === item.remainingRelationships.length &&
      item.remainingRelationships.every((kind) => known.has(kind)),
    `account relationship ${item.id} has an unknown or duplicate relationship kind`);
    const retained = item.remainingRelationships.some((kind) => retaining.includes(kind));
    const actual = retained ? 'ACCOUNT_RETAINED' : 'ACCOUNT_AND_ACCOUNT_SCOPED_STATE_DELETED';
    assert(item.expected === actual, `account relationship ${item.id} expected ${item.expected}, got ${actual}`);
  }
  assert(value.tenantSelfRemoval?.preservesOtherHomeMemberships === true &&
    value.tenantSelfRemoval?.removesOnlySelectedMembership === true,
  'tenant account removal must remain membership-scoped');
  return { cases: caseIds.size };
}

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
  if (!isCalendarValidUtcTimestamp(state.expiresAt) || !state.emailVerified || fixture.competingClaim.winnerRemains !== state.claimantAccountId ||
      fixture.competingClaim.expectedOutcome !== "non_identifying_unavailable") {
    throw new Error("Claim reservation must have a valid UTC expiry, be first-wins and non-identifying");
  }
  for (const event of fixture.events) {
    if (!isCalendarValidUtcTimestamp(event.at) ||
        (event.expectedExpiresAt !== undefined && !isCalendarValidUtcTimestamp(event.expectedExpiresAt))) {
      throw new Error(`Invalid claim event clock: ${event.eventId}`);
    }
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

export function resolveInstallationRequestDecision(item) {
  if (!item || typeof item !== "object" || !isCalendarValidUtcTimestamp(item.at)) return "INVALID_INPUT";
  if (item.membershipCurrent !== true) return "AUTHORITY_REVOKED";
  if (item.selectedHomeId !== item.requestHomeId) return "HOME_MISMATCH";
  if (!["OWNER", "PROPERTY_MANAGER"].includes(item.actorRole)) return "ROLE_DENIED";
  if (!Number.isInteger(item.currentRevision) || !Number.isInteger(item.expectedRevision) || item.currentRevision !== item.expectedRevision) return "REVISION_CONFLICT";
  if (item.action === "retry" && item.requestState === "expired" && isCalendarValidUtcTimestamp(item.expiresAt) &&
      Number.isFinite(Date.parse(item.expiresAt)) && Date.parse(item.expiresAt) <= Date.parse(item.at)) return "RETRY_ALLOWED";
  if (item.action === "submit" && item.requestState === "not_submitted" && item.expiresAt === null) return "REQUEST_PENDING";
  return "INVALID_TRANSITION";
}

export function resolvePrototypeActionDecision(flowId, actionId, fixture, caseIds) {
  if (!fixture || !Array.isArray(caseIds) || caseIds.length === 0) return null;
  const findCase = (collection, id) => Array.isArray(collection) ? collection.find((item) => item.id === id) : null;
  const decisions = [];
  for (const caseId of caseIds) {
    let decision = null;
    switch (flowId) {
      case "support": {
        if (!caseIds.includes(actionId)) return null;
        if (actionId === "private-request") {
          const item = fixture.privateTenantOnly;
          const recipients = item?.recipientCandidates?.filter((id) => id === item.ticketMembershipId);
          decision = recipients?.length === 1 && recipients[0] === "membership:tenant-property" && item.ownerNotice === false ? "PRIVATE_TICKET_TENANT_ONLY" : null;
        } else if (actionId === "infrastructure-approval") {
          const item = fixture.propertyInfrastructure;
          decision = item && JSON.stringify(item.recipientCandidates.filter((id) => id !== "membership:tenant-property")) === JSON.stringify(item.expectedGenericLifecycleRecipients) &&
            item.noticeContainsTenantPrivateDeviceId === false && item.noticeContainsTenantPrivateTicketText === false ? "GENERIC_INFRA_NOTICE" : null;
        } else if (actionId === "wrong-approver") {
          const item = fixture.safetyAction;
          decision = item?.differentApproverDenied === true && item?.sameApproverRequired === true ? "DIFFERENT_APPROVER_DENIED" : null;
        } else if (actionId === "close-expire") {
          const item = fixture.closure;
          decision = item?.ticketState === "CLOSED" && item?.cloudAuthorityRevokedImmediately === true &&
            item?.hubAcknowledgement === "pending" && item?.pendingHubAcknowledgementPermitsRenewal === false ? "CLOSED_PENDING_HUB_ACK" : null;
        }
        if (!decision) return null;
        break;
      }
      case "invitation": {
        const item = findCase(fixture.cases, caseId);
        if (!isCalendarValidUtcTimestamp(fixture.initial?.expiresAt) ||
            (actionId !== "resend" && !isCalendarValidUtcTimestamp(item?.at))) return null;
        if (actionId === "resend") {
          const resend = fixture.resend;
          if (!resend || resend.newGeneration !== resend.oldGeneration + 1 || resend.oldRecipientProjectionVisible !== false || resend.oldMembershipCreated !== false) return null;
          decision = "NEW_GENERATION_ISSUED";
        } else if (item) {
          const actual = item.authenticatedAccountId !== fixture.initial?.recipientAccountId ? "INVITATION_RECIPIENT_MISMATCH" :
            item.emailVerified !== true ? "EMAIL_VERIFICATION_REQUIRED" :
            item.explicitDecline === true ? "INVITATION_DECLINED" :
            item.explicitAccept !== true ? "INVITATION_PENDING" :
            Date.parse(item.at) >= Date.parse(fixture.initial.expiresAt) ? "INVITATION_EXPIRED" :
            item.authorityRevalidated === true ? "MEMBERSHIP_ACTIVE" : "INVITATION_PENDING";
          const membershipCreated = actual === "MEMBERSHIP_ACTIVE";
          if (actual !== item.expected || membershipCreated !== (item.membershipId === "membership:recipient-home")) return null;
          decision = actual;
        }
        break;
      }
      case "room-qr": {
        const item = findCase(fixture.cases, caseId);
        if (!item) return null;
        decision = item.areaLifecycle === "retired" ? "AREA_NOT_AVAILABLE" : item.activeOwnerExists === false ? "NO_DURABLE_REQUEST" :
          item.previousState === "REJECTED" && item.elapsedSeconds === 0 ? "NEW_REQUEST_ALLOWED" :
          Number.isFinite(item.elapsedSeconds) && item.elapsedSeconds >= fixture.request.lifetimeSeconds ? "REQUEST_EXPIRED" :
          item.emailVerified !== true ? "WAITING_FOR_EMAIL_VERIFICATION" : item.approved === true ? "MEMBERSHIP_ACTIVE" : "PENDING_OWNER_DECISION";
        if (decision !== item.expected || item.membershipCreated === true !== (decision === "MEMBERSHIP_ACTIVE")) return null;
        break;
      }
      case "property-actions": {
        if (actionId === "offline-deregister") {
          if (fixture.platformAuthority !== "revoked" || fixture.hubAcknowledgement !== "pending" || fixture.expected?.reportComplete !== false || fixture.expected?.protectedCommands !== false) return null;
          decision = "REVOCATION_PENDING_HUB_ACK";
        } else {
          const item = findCase(fixture.cases, caseId);
          if (!item) return null;
          decision = item.successorIsActiveTenant ? "ACTIVE_TENANT_SUCCESSOR_DENIED" :
            item.actorMembershipId !== fixture.activeClaim?.outgoingOwnerMembershipId && item.verifiedStaff !== true ? "SCOPE_DENIED" :
            item.action === "cancel" ? "CANCELLED" : item.action === "replace" ? "REPLACED" :
            item.action?.startsWith("consume:") && item.after ? "CLAIM_ALREADY_CONSUMED" :
            item.action?.startsWith("consume:") ? "TRANSFERRED" : "INVALID_TRANSITION";
          if (decision !== item.expected || (item.mutation !== (decision === "CANCELLED" || decision === "REPLACED" || decision === "TRANSFERRED"))) return null;
        }
        break;
      }
      case "area-edit": {
        const item = findCase(fixture.cases, caseId);
        if (!item) return null;
        decision = item.selectedHomeId !== fixture.homeId ? "HOME_MISMATCH" : item.areaCurrent !== true ? "AREA_NOT_AVAILABLE" :
          !["OWNER", "PROPERTY_MANAGER"].includes(item.actorRole) ? "ROLE_DENIED" :
          item.expectedRevision !== fixture.currentRevision ? "REVISION_CONFLICT" : "AREA_EDITED";
        if (decision !== item.expected || item.saved !== (decision === "AREA_EDITED")) return null;
        break;
      }
      case "quiet-hours": {
        if (actionId === "receipt") {
          decision = fixture.receiptCreatesAuthority === false ? "DELIVERY_ONLY_NO_AUTHORITY" : null;
          if (!decision) return null;
          break;
        }
        const item = findCase(fixture.cases, caseId);
        if (!item) return null;
        const quietEnd = fixture.quietHours?.endLocalTime ?? "07:00";
        decision = item.mandatory ? "DELIVERED_IMMEDIATELY" : item.enabled !== true ? "NOT_SENT" :
          item.quietHoursEnabled === true && item.localTime < quietEnd ? "DEFERRED_INDIVIDUALLY_UNTIL_QUIET_HOURS_END" : "DELIVERED_ONCE";
        const expected = ({
          "delivered-immediately": "DELIVERED_IMMEDIATELY",
          "not-sent": "NOT_SENT",
          "deferred-individually-until-quiet-hours-end": "DEFERRED_INDIVIDUALLY_UNTIL_QUIET_HOURS_END",
          "delivered-once": "DELIVERED_ONCE",
        })[item.expected];
        if (decision !== expected) return null;
        break;
      }
      case "trusted-device": {
        const item = findCase(fixture.cases, caseId);
        if (!item || item.sessionsRevoked !== true || item.offlineAuthorityRevoked !== true || item.unrelatedDevicePreserved !== true) return null;
        decision = item.online ? "REVOKED_ACCOUNT_WIDE" : "REVOCATION_PENDING_HUB_ACK";
        if (decision !== item.expected) return null;
        break;
      }
      case "access-request": {
        const item = findCase(fixture.cases, caseId);
        if (!item) return null;
        decision = item.selectedHomeId !== fixture.homeId ? "HOME_MISMATCH" :
          item.requestState === "expired" ? "REQUEST_EXPIRED" :
          !["OWNER", "PROPERTY_MANAGER"].includes(item.actorRole) ? "ROLE_DENIED" :
          item.currentRevision !== item.expectedRevision ? "REVISION_CONFLICT" :
          !item.recipientVerified ? "RECIPIENT_NOT_VERIFIED" :
          item.action === "reject" ? "REJECTED" : item.action === "approve" ? "MEMBERSHIP_ACTIVE" : "INVALID_TRANSITION";
        if (decision !== item.expected || item.membershipCreated !== (decision === "MEMBERSHIP_ACTIVE") || item.protectedDataReturned !== false) return null;
        break;
      }
      case "descriptor-change": {
        const item = fixture.prototypeControls?.find((entry) => entry.id === caseId);
        if (!item) return null;
        decision = item.deleted ? "CONTROL_REMOVED" : item.writable === false ? "WRITE_DENIED_READ_ONLY" : item.replacementId ? "REPLACEMENT_HAS_NEW_IDENTITY" : null;
        if (!decision || decision !== item.expected) return null;
        break;
      }
      case "claim": {
        if (actionId === "competing") {
          decision = fixture.competingClaim?.expectedOutcome === "non_identifying_unavailable" && fixture.competingClaim.winnerRemains === fixture.initial?.claimantAccountId
            ? "COMPETING_CLAIM_DENIED" : null;
        } else {
          const item = fixture.events?.find((event) => event.eventId === caseId);
          if (!item) return null;
          const state = simulateClaimLifecycle({ ...fixture, events: fixture.events.slice(0, fixture.events.indexOf(item) + 1) });
          if (state.state !== (item.expectedState ?? state.state) ||
              item.expectedExpiresAt && Date.parse(state.expiresAt) !== Date.parse(item.expectedExpiresAt) ||
              item.expectedRevision !== undefined && state.revision !== item.expectedRevision) return null;
          decision = item.eventId === "event:exact-expiry" ? "CLAIM_EXPIRED_AND_RELEASED" :
            item.eventId === "event:noop-save" ? "NO_EXTENSION" : item.eventId === "event:required-save-replay" ? "IDEMPOTENT_RETRY_NO_SECOND_EXTENSION" :
            item.kind === "required_save" && item.success && item.changed ? "REQUIRED_SAVE_EXTENDED_EXACTLY_30_MINUTES" : "RESERVATION_REMAINS_UNCHANGED";
        }
        if (!decision) return null;
        break;
      }
      case "recovery": {
        const item = findCase(fixture.cases, caseId);
        if (!item || item.accountExistsDisclosed !== false || item.sessionIssued !== false) return null;
        decision = item.requestAccepted && item.responseClass === "generic_accepted" ? "GENERIC_ACCEPTED_NO_SESSION" :
          !item.requestAccepted && item.responseClass === "generic_denial" ? "GENERIC_DENIAL_NO_SESSION" : null;
        break;
      }
      case "management-activity": {
        if (actionId === "receipt") {
          decision = fixture.receiptCreatesAuthority === false ? "DELIVERY_ONLY_NO_AUTHORITY" : null;
        } else {
          const maxSequence = Math.max(...fixture.events.map((event) => event.sequence));
          const newest = fixture.events.filter((event) => event.sequence === maxSequence);
          decision = actionId === "newer" && newest[0]?.value === "new" ? "NEWEST_REVISION_APPLIED" :
            actionId === "duplicate" && fixture.expectedAppliedSequences?.length === 1 && fixture.expectedAppliedSequences[0] === maxSequence ? "DUPLICATE_OR_OLDER_IGNORED" : null;
        }
        if (!decision) return null;
        break;
      }
      case "installation-request": {
        const item = findCase(fixture.cases, caseId);
        if (!item || !["OWNER", "PROPERTY_MANAGER"].includes(item.actorRole)) return null;
        decision = resolveInstallationRequestDecision(item);
        if (decision !== item.expectedDecision) return null;
        break;
      }
      default: return null;
    }
    decisions.push(decision);
  }
  if (decisions.length !== caseIds.length) return null;
  if (flowId === "claim" && actionId === "required-save" &&
      JSON.stringify([...new Set(decisions)].sort()) === JSON.stringify(["IDEMPOTENT_RETRY_NO_SECOND_EXTENSION", "REQUIRED_SAVE_EXTENDED_EXACTLY_30_MINUTES"].sort())) {
    return "REQUIRED_SAVE_EXTENDED_AND_RETRY_IDEMPOTENT";
  }
  return decisions.every((decision) => decision === decisions[0]) ? decisions[0] : null;
}

export function assertPrototypeActionMatrixBindings(prototypeScenarios, fixtureIndex) {
  if (!prototypeScenarios || !fixtureIndex || fixtureIndex.schemaVersion !== "dinodia.v1" || !fixtureIndex.screenFixtures) {
    throw new Error("Prototype scenarios require the canonical screen fixture index");
  }
  for (const [flowId, flow] of Object.entries(prototypeScenarios.flows ?? {})) {
    const screens = flow.matrixScreens;
    if (!Array.isArray(screens) || screens.length === 0 || new Set(screens).size !== screens.length) {
      throw new Error(`Prototype flow ${flowId} has no unique matrix screen bindings`);
    }
    for (const screen of screens) {
      const references = fixtureIndex.screenFixtures[screen];
      if (!Array.isArray(references) || !references.includes("fixtures/prototype-scenarios.json")) {
        throw new Error(`Prototype flow ${flowId} is not indexed on rendered screen ${screen}`);
      }
    }
    const references = new Set(screens.flatMap((screen) => fixtureIndex.screenFixtures[screen] ?? []));
    for (const action of flow.actions ?? []) {
      const reference = `fixtures/${action.decisionFixture}.json`;
      if (!references.has(reference)) {
        throw new Error(`Prototype action ${flowId}/${action.id} decision fixture is not indexed for its rendered screens: ${reference}`);
      }
    }
  }
  return true;
}

function isCalendarValidUtcTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const hour = Number(hourText); const minute = Number(minuteText); const second = Number(secondText);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day >= 1 && day <= daysInMonth && Number.isFinite(Date.parse(value));
}

export function assertStage2DecisionFixtures({ support, receipt, offline, decisionMatrix, claim, accountRelationshipLifecycle }) {
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
  if (accountRelationshipLifecycle) assertAccountRelationshipLifecycle(accountRelationshipLifecycle);
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

export function projectAutomationPropertyImpact(fixture, request) {
  const denied = { decision: "DENIED_NO_PROJECTION", projection: { automations: [] }, protectedEffects: 0 };
  const keysEqual = (value, expected) => value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
  const boundedText = (value, maximum) => typeof value === "string" && Array.from(value).length <= maximum;
  const opaqueId = (value) => boundedText(value, 160) && value.trim().length > 0;
  if (!keysEqual(fixture, ["schemaVersion", "homes", "cases"]) || fixture.schemaVersion !== "dinodia.v1" ||
      !request || request.membershipCurrent !== true ||
      !["OWNER", "PROPERTY_MANAGER"].includes(request.role) || typeof request.homeId !== "string" ||
      typeof request.membershipId !== "string" || !opaqueId(request.homeId) || !opaqueId(request.membershipId)) return denied;

  const homes = fixture.homes;
  if (!Array.isArray(homes) || homes.some((home) => !keysEqual(home, ["homeId", "revision", "ownerMembershipIds", "managerMembershipIds", "automations"])) ||
      homes.filter((home) => home?.homeId === request.homeId).length !== 1) return denied;
  const home = homes.find((candidate) => candidate.homeId === request.homeId);
  const authorisedMemberships = request.role === "OWNER" ? home.ownerMembershipIds : home.managerMembershipIds;
  if (!Number.isInteger(home.revision) || home.revision < 0 || !Array.isArray(authorisedMemberships) ||
      new Set(authorisedMemberships).size !== authorisedMemberships.length ||
      authorisedMemberships.some((id) => !opaqueId(id)) || !authorisedMemberships.includes(request.membershipId)) return denied;
  if (!Array.isArray(home.automations) || home.automations.length > 100) return denied;

  const automationIds = home.automations.map((automation) => automation?.automationId);
  if (automationIds.some((id) => !opaqueId(id)) || new Set(automationIds).size !== automationIds.length) return denied;
  const projected = [];
  for (const automation of home.automations) {
    if (!keysEqual(automation, ["automationId", "homeId", "tenantName", "name", "schedule", "targets"]) ||
        automation.homeId !== home.homeId || !opaqueId(automation.automationId) || !boundedText(automation.name, 60) || !automation.name.trim() ||
        !boundedText(automation.tenantName, 80) || !automation.tenantName.trim() ||
        !keysEqual(automation.schedule, ["timezone", "daysOfWeek", "localTime"]) ||
        !Array.isArray(automation.schedule.daysOfWeek) || !automation.schedule.daysOfWeek.length ||
        new Set(automation.schedule.daysOfWeek).size !== automation.schedule.daysOfWeek.length ||
        automation.schedule.daysOfWeek.some((day) => !Number.isInteger(day) || day < 1 || day > 7) ||
        typeof automation.schedule.localTime !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(automation.schedule.localTime) ||
        !boundedText(automation.schedule.timezone, 64) || !automation.schedule.timezone.trim() ||
        !Array.isArray(automation.targets)) return denied;
    try { new Intl.DateTimeFormat("en", { timeZone: automation.schedule.timezone }); } catch { return denied; }
    const targetIds = automation.targets.map((target) => target?.deviceId);
    if (targetIds.some((id) => !opaqueId(id)) || new Set(targetIds).size !== targetIds.length ||
        automation.targets.some((target) => {
          const allowedKeys = target?.managementClass === "tenant_device"
            ? ["deviceId", "managementClass", "displayName", "privateActionValue"]
            : ["deviceId", "managementClass", "displayName"];
          return !keysEqual(target, allowedKeys) || !["property_device", "tenant_device"].includes(target.managementClass) ||
            !boundedText(target.displayName, 80) || !target.displayName.trim() ||
            (Object.hasOwn(target, "privateActionValue") &&
              (typeof target.privateActionValue !== "string" || Array.from(target.privateActionValue).length > 240));
        })) return denied;
    const permanentDevices = automation.targets
      .filter((target) => target.managementClass === "property_device")
      .map((target) => ({ deviceId: target.deviceId, displayName: target.displayName }))
      .sort((left, right) => left.deviceId.localeCompare(right.deviceId));
    if (permanentDevices.length === 0) continue;
    projected.push({
      automationId: automation.automationId,
      tenantName: automation.tenantName,
      name: automation.name,
      schedule: {
        timezone: automation.schedule.timezone,
        daysOfWeek: [...automation.schedule.daysOfWeek],
        localTime: automation.schedule.localTime,
      },
      affectedPermanentDevices: permanentDevices,
      availableActions: ["disable", "delete"],
      stepUpRequired: true,
    });
  }
  projected.sort((left, right) => left.automationId.localeCompare(right.automationId));
  return {
    decision: "PROJECTED",
    projection: {
      schemaVersion: "dinodia.v1",
      homeId: home.homeId,
      membershipId: request.membershipId,
      role: request.role,
      revision: home.revision,
      automations: projected,
    },
    protectedEffects: 0,
  };
}

function executeSemanticFixture(path, value, adapters) {
  const { os, platform, alexa, schema, analytics } = adapters;
  const result = (outcome, details = {}) => ({ outcome, ...details });
  switch (path) {
    case "account-relationship-lifecycle.json": {
      return result("accepted", assertAccountRelationshipLifecycle(value));
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
    case "invalid/impossible-calendar-date-envelope.json": {
      const denied = !schema("envelope", value) && !platform.validateEnvelope(value) &&
        !os.validateEnvelope(value);
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
    case "automation-property-impact.json": {
      assert(Array.isArray(value.cases) && value.cases.length >= 6, "property automation fixture is missing role/privacy cases");
      for (const item of value.cases) {
        const actual = projectAutomationPropertyImpact(value, item.request);
        assert(actual.decision === item.expectedDecision && JSON.stringify(actual.projection) === JSON.stringify(item.expectedProjection) &&
          actual.protectedEffects === item.expectedProtectedEffects && actual.protectedEffects === 0,
        `property automation projection case ${item.id} diverged or produced an effect`);
        if (actual.decision === "PROJECTED")
          assert(adapters.schema("automationPropertyImpactProjection", actual.projection),
            `property automation projection case ${item.id} failed its canonical output schema`);
        const serialized = JSON.stringify(actual.projection);
        for (const automation of value.homes.flatMap((home) => home.automations)) {
          const propertyTargetCount = automation.targets.filter((target) => target.managementClass === "property_device").length;
          if (propertyTargetCount === 0 && item.request.homeId === automation.homeId)
            assert(!serialized.includes(automation.automationId) && !serialized.includes(automation.name),
              `private-only automation ${automation.automationId} leaked into the property projection`);
          for (const target of automation.targets.filter((candidate) => candidate.managementClass === "tenant_device"))
            assert(!serialized.includes(target.deviceId) && !serialized.includes(target.displayName) &&
              !(target.privateActionValue && serialized.includes(target.privateActionValue)),
            `tenant-private automation target ${target.deviceId} leaked into the property projection`);
        }
      }
      return result("accepted", { cases: value.cases.length, protectedEffects: 0, privacyFiltered: true });
    }
    case "invalid/automation-property-target-extra-authority.json": {
      const source = adapters.readFixture(value.sourceFixture);
      const scenario = source.cases.find((item) => item.id === value.caseId);
      const automation = source.homes.find((home) => home.homeId === scenario?.request.homeId)?.automations
        ?.find((item) => item.automationId === value.automationId);
      const target = automation?.targets.find((item) => item.deviceId === value.targetDeviceId);
      assert(scenario && target && typeof value.addField === "string" && value.addField.length > 0,
        "extra-authority denial fixture must resolve a real shared target");
      target[value.addField] = structuredClone(value.addValue);
      const actual = projectAutomationPropertyImpact(source, scenario.request);
      assert(actual.decision === value.expectedDecision &&
        JSON.stringify(actual.projection) === JSON.stringify(value.expectedProjection) &&
        actual.protectedEffects === value.expectedProtectedEffects && actual.protectedEffects === 0,
      "automation target authority extension must be denied before projection with no protected effects");
      return deniedWithNoEffects(actual.decision === "DENIED_NO_PROJECTION", path);
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
    case "support-access-revoke.json": {
      assert(platform.validateSupportAccessRevokeRequest(value.request) &&
        platform.validateSupportAccessRevokeReceipt(value.receipt) &&
        ["OWNER", "PROPERTY_MANAGER"].includes(value.decision?.actorRole) &&
        value.decision.approvedBySameMembership === true &&
        value.decision.operationKind === "support_access_revoke" &&
        JSON.stringify(value.decision.targetTypes) === JSON.stringify(["ticket", "request"]) &&
        value.decision.cloudAuthority === "revoked_immediately" && value.decision.hubAcknowledgement === "pending",
      "support revocation must use its exact DTO, approving membership, operation-bound targets and pending hub acknowledgement");
      return result("accepted", { protectedEffects: 0 });
    }
    case "invalid/support-access-revoke-extra-authority.json":
      return deniedWithNoEffects(!platform.validateSupportAccessRevokeRequest(value), path);
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
      if (!isCalendarValidUtcTimestamp(value.initial?.expiresAt) ||
          !value.cases.every((item) => isCalendarValidUtcTimestamp(item.at))) {
        throw new Error("Invitation lifecycle contains an invalid UTC calendar timestamp");
      }
      const expires = Date.parse(value.initial.expiresAt);
      const actualFor = (item) => {
        const sameRecipient = item.authenticatedAccountId === value.initial.recipientAccountId;
        if (!sameRecipient) return "INVITATION_RECIPIENT_MISMATCH";
        if (!item.emailVerified) return "EMAIL_VERIFICATION_REQUIRED";
        if (item.explicitDecline === true) return "INVITATION_DECLINED";
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
    case "invalid/control-state-option-outside-descriptor.json": {
      const device = value.device;
      const control = device.controls.find((entry) => entry.controlId === value.state.controlId);
      assert(control?.valueType === "option" && platform.validateNativeDevice(device) && os.validateDevice(device),
        "option-state scenario must use a valid current descriptor; both state DTOs are independently schema-checked by the contract gate");
      assert(platform.validateControlState(value.validState, device, control) && os.validateControlState(value.validState, device, control),
        "a current option value must be accepted by Platform and OS");
      const denied = !platform.validateControlState(value.state, device, control) && !os.validateControlState(value.state, device, control);
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
    case "invalid/duplicate-device-control-id.json": {
      const source = adapters.readFixture(value.sourceFixture);
      const device = clone(source.device);
      const target = device.controls.find((entry) => entry.controlId === value.targetControlId);
      assert(target && device.id === value.deviceId && device.controls.some((entry) => entry.controlId === value.duplicateControlId),
        "duplicate-control fixture must resolve its exact source device and both control identities");
      target.controlId = value.duplicateControlId;
      const context = { homeId: device.homeId, homeMembershipId: source.context.homeMembershipId, role: "OWNER", areaIds: device.areaIds };
      const schemaAcceptsDistinctRows = schema("device", device);
      const platformDenies = !platform.validateNativeDevice(device, context);
      const osDenies = !os.validateDevice(device, context);
      const alexaDenies = alexa.decodeNativeAlexaDevices({
        schemaVersion: "dinodia.v1", homeId: device.homeId, streamId: "stream:duplicate-control",
        sequence: 1, generatedAt: "2026-09-27T10:00:00Z", revision: 1, data: [device],
      }, { homeId: device.homeId, homeMembershipId: context.homeMembershipId, role: "OWNER", authorisedAreaIds: device.areaIds }) === null;
      assert(value.schemaExpected === "structurally_valid_distinct_objects" && schemaAcceptsDistinctRows && platformDenies && osDenies && alexaDenies,
        "JSON Schema may accept distinct objects, but Platform, OS and Alexa must reject repeated public control IDs before projection or dispatch");
      return deniedWithNoEffects(true, path);
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
        for (const action of flow.actions) {
          assert(action.id && action.label && action.outcome &&
            (!action.allowedRoles || action.allowedRoles.every((role) => ["Homeowner", "Property manager", "Tenant"].includes(role))),
          `prototype action ${flowId}/${action.id} is not executable/renderable`);
          assert(typeof action.decisionFixture === "string" && Array.isArray(action.decisionCases) && action.decisionCases.length > 0,
            `prototype action ${flowId}/${action.id} has no executable decision binding`);
          assert(typeof action.expectedDecision === "string" && action.expectedDecision.trim(),
            `prototype action ${flowId}/${action.id} has no expected decision code`);
          const source = adapters.readFixture(`fixtures/${action.decisionFixture}.json`);
          const decision = source && resolvePrototypeActionDecision(flowId, action.id, source, action.decisionCases);
          assert(decision && decision === action.expectedDecision,
            `prototype action ${flowId}/${action.id} did not resolve through its owning fixture decision`);
        }
      }
      const installation = adapters.readFixture("fixtures/installation-request-lifecycle.json");
      const decisions = new Map();
      for (const item of installation.cases) {
        const effects = item.expectedEffects;
        const actual = resolveInstallationRequestDecision(item);
        assert(actual === item.expectedDecision, `installation request ${item.id}: expected ${item.expectedDecision}, derived ${actual}`);
        assert(effects && effects.homeCreated === false && effects.installationCompleted === false &&
          effects.requestCreated === ["REQUEST_PENDING", "RETRY_ALLOWED"].includes(actual),
        `installation request ${item.id} has contradictory side effects`);
        decisions.set(item.id, actual);
      }
      const installFlow = value.flows["installation-request"];
      assert(installFlow.actions.every((action) => action.decisionFixture === "installation-request-lifecycle" &&
        Array.isArray(action.decisionCases) && action.decisionCases.length > 0 &&
        action.decisionCases.every((caseId) => decisions.has(caseId))),
      "every rendered installation action must resolve to executable lifecycle inputs");
      assert(installFlow.actions.find((action) => action.id === "submit").decisionCases.every((caseId) =>
        ["REQUEST_PENDING"].includes(decisions.get(caseId))), "installation submission must remain pending, never imply completion");
      assert(installFlow.actions.find((action) => action.id === "expire").decisionCases.every((caseId) =>
        decisions.get(caseId) === "RETRY_ALLOWED"), "expired installation retry requires current owner/manager authority");
      return result("accepted", { flows: flows.length, actions: flows.reduce((sum, [, flow]) => sum + flow.actions.length, 0) });
    }
    case "installation-request-lifecycle.json": {
      assert(value.schemaVersion === "dinodia.v1" && value.decisionId === "installation_request" && value.cases.length >= 7,
        "installation request fixture must contain the complete Stage 2 decision matrix");
      for (const item of value.cases) {
        const actual = resolveInstallationRequestDecision(item);
        assert(actual === item.expectedDecision && item.expectedEffects?.homeCreated === false &&
          item.expectedEffects?.installationCompleted === false &&
          item.expectedEffects?.requestCreated === ["REQUEST_PENDING", "RETRY_ALLOWED"].includes(actual),
        `installation request decision/effect mismatch: ${item.id}`);
      }
      return result("accepted", { cases: value.cases.length, productionEffects: 0 });
    }
    case "area-edit-lifecycle.json": {
      for (const item of value.cases) {
        const actual = item.selectedHomeId !== value.homeId ? "HOME_MISMATCH" : item.areaCurrent !== true ? "AREA_NOT_AVAILABLE" :
          !["OWNER", "PROPERTY_MANAGER"].includes(item.actorRole) ? "ROLE_DENIED" :
          item.expectedRevision !== value.currentRevision ? "REVISION_CONFLICT" : "AREA_EDITED";
        assert(actual === item.expected && item.saved === (actual === "AREA_EDITED"), `area edit ${item.id}: decision/effect mismatch`);
      }
      return result("accepted", { cases: value.cases.length });
    }
    case "access-request-lifecycle.json": {
      for (const item of value.cases) {
        const actual = item.selectedHomeId !== value.homeId ? "HOME_MISMATCH" : item.requestState === "expired" ? "REQUEST_EXPIRED" :
          !["OWNER", "PROPERTY_MANAGER"].includes(item.actorRole) ? "ROLE_DENIED" :
          item.currentRevision !== item.expectedRevision ? "REVISION_CONFLICT" : !item.recipientVerified ? "RECIPIENT_NOT_VERIFIED" :
          item.action === "reject" ? "REJECTED" : item.action === "approve" ? "MEMBERSHIP_ACTIVE" : "INVALID_TRANSITION";
        assert(actual === item.expected && item.membershipCreated === (actual === "MEMBERSHIP_ACTIVE") && item.protectedDataReturned === false,
          `access request ${item.id}: decision/effect mismatch`);
      }
      return result("accepted", { cases: value.cases.length });
    }
    case "stage2-decision-matrix.json": {
      assertStage2DecisionFixtures({
        support: adapters.readFixture("fixtures/support-private-notification.json"),
        receipt: adapters.readFixture("fixtures/notification-delivery-is-not-authority.json"),
        offline: adapters.readFixture("fixtures/offline-scope-widening.json"),
        decisionMatrix: value,
        claim: adapters.readFixture("fixtures/claim-lifecycle.json"),
        accountRelationshipLifecycle: adapters.readFixture("fixtures/account-relationship-lifecycle.json"),
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
