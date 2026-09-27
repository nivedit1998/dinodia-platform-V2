import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import yaml from "js-yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(
  fs.readFileSync(
    path.join(root, "contracts/dinodia-v1/contract.json"),
    "utf8",
  ),
);
if (contract.contractVersion !== "dinodia.v1")
  throw new Error("Contract version mismatch");
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
ajv.addSchema(contract);
const schemas = new Map();
const definitionValidator = (name) => ajv.compile({ $ref: `${contract.$id}#/$defs/${name}` });
for (const schema of fs
  .readdirSync(path.join(root, "contracts/dinodia-v1/schemas"))
  .filter((x) => x.endsWith(".json"))) {
  const value = JSON.parse(
    fs.readFileSync(
      path.join(root, "contracts/dinodia-v1/schemas", schema),
      "utf8",
    ),
  );
  if (
    value.$schema !== contract.$schema ||
    !value.$ref?.startsWith("./contract.json#/$defs/")
  )
    throw new Error(`Invalid schema wrapper: ${schema}`);
  const absoluteRef = value.$ref.replace("./contract.json", contract.$id);
  schemas.set(
    schema.replace(".schema.json", ""),
    ajv.compile({ $ref: absoluteRef }),
  );
}
const fixtureRoot = path.join(root, "contracts/dinodia-v1/fixtures");
const valid = JSON.parse(
  fs.readFileSync(path.join(fixtureRoot, "multi-control-device.json"), "utf8"),
);
const invalid = JSON.parse(
  fs.readFileSync(
    path.join(fixtureRoot, "invalid/tenant-device-wrong-owner.json"),
    "utf8",
  ),
);
const alexaProjection = JSON.parse(
  fs.readFileSync(
    path.join(fixtureRoot, "alexa-discovery-projection.json"),
    "utf8",
  ),
);
if (
  valid.device.managementClass !== "property_device" ||
  valid.device.controls.length < 2
)
  throw new Error("Canonical valid fixture missing multi-control example");
if (
  invalid.device.managementClass !== "tenant_device" ||
  invalid.device.ownerMembershipId === invalid.context.homeMembershipId
)
  throw new Error("Privacy rejection fixture is not adversarial");
if (!schemas.get("device")(valid.device))
  throw new Error(
    `Valid device fixture failed schema: ${JSON.stringify(schemas.get("device").errors)}`,
  );
if (schemas.get("device")(invalid.device) !== true)
  throw new Error(
    "Wrong-owner fixture must be structurally valid; membership privacy validator must reject it",
  );
const alexaSchema = schemas.get("alexa-discovery");
if (!alexaSchema || !alexaSchema(alexaProjection))
  throw new Error(
    `Alexa projection fixture failed canonical schema: ${JSON.stringify(alexaSchema?.errors)}`,
  );
const malformedAlexa = {
  ...alexaProjection,
  membership: { ...alexaProjection.membership, role: "OWNER" },
};
if (alexaSchema(malformedAlexa))
  throw new Error("Alexa discovery must be tenant-membership scoped");
const fixtureFiles = [];
const collectFixtures = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) collectFixtures(file);
    else if (entry.name.endsWith(".json")) {
      JSON.parse(fs.readFileSync(file, "utf8"));
      fixtureFiles.push(file);
    }
  }
};
collectFixtures(fixtureRoot);
for (const required of [
  "multi-channel-mixed-controls.json",
  "control-catalog-change.json",
  "unknown-interaction-kind.json",
  "stale-and-unavailable-control-state.json",
  "empty-area.json",
  "duplicate-display-names.json",
  "moved-device.json",
  "deleted-device-tombstone.json",
  "replacement-hub.json",
  "invitation-pending-no-membership.json",
  "claim-first-wins.json",
  "notification-security-mandatory.json",
  "analytics-semantics.json",
  "invalid/analytics-invalid-sample.json",
  "hub-cloudurl-verified.json",
  "out-of-order-events.json",
  "invalid/wrong-home-envelope.json",
  "invalid/stale-descriptor-command.json",
  "invalid/unknown-required-version.json",
]) {
  if (!fs.existsSync(path.join(fixtureRoot, required)))
    throw new Error(`Required contract fixture missing: ${required}`);
}
const exampleChecks = [
  ["area", "empty-area.json", (fixture) => fixture.data],
  ["analyticsObservation", "analytics-unknown-on-expiry.json", (fixture) => fixture],
  ["controlCatalog", "control-catalog-change.json", (fixture) => fixture.catalog],
  ["controlCatalogEvent", "control-catalog-change.json", (fixture) => ({ schemaVersion: "dinodia.v1", homeId: fixture.catalog.homeId, streamId: "stream:fixture", sequence: 1, generatedAt: "2026-09-27T10:00:00Z", revision: 1, data: fixture.catalog })],
  ["notification", "notification-security-mandatory.json", (fixture) => fixture],
  ["membershipInvitation", "invitation-pending-no-membership.json", (fixture) => fixture],
  ["claimReservation", "claim-first-wins.json", (fixture) => fixture],
  ["hubInstallation", "hub-cloudurl-verified.json", (fixture) => fixture],
];
for (const [schemaName, fileName, select] of exampleChecks) {
  if (!select) continue;
  const example = JSON.parse(fs.readFileSync(path.join(fixtureRoot, fileName), "utf8"));
  const validator = definitionValidator(schemaName);
  if (!validator || !validator(select(example)))
    throw new Error(`Fixture ${fileName} failed ${schemaName} schema: ${JSON.stringify(validator?.errors)}`);
}
const fixtureChecks = [
  ["alexaDiscoveryProjection", "alexa-discovery-projection.json", (v) => v],
  ["accessPolicy", "access-policy-selected-tenant.json", (v) => v],
  ["analyticsObservation", "analytics-unknown-on-expiry.json", (v) => v],
  ["area", "empty-area.json", (v) => v.data],
  ["automation", "automation-full-bundle.json", (v) => v],
  ["claimReservation", "claim-first-wins.json", (v) => v],
  ["command", "command-valid.json", (v) => v],
  ["commandResult", "command-result-uncertain.json", (v) => v],
  ["commissioning", "commissioning-expired.json", (v) => v],
  ["controlCatalog", "control-catalog-change.json", (v) => v.catalog],
  ["controlCatalogEvent", "control-catalog-change.json", (v) => ({ schemaVersion: "dinodia.v1", homeId: v.catalog.homeId, streamId: "stream:fixture", sequence: 1, generatedAt: "2026-09-27T10:00:00Z", revision: 1, data: v.catalog })],
  ["controlState", "stale-and-unavailable-control-state.json", (v) => v.data],
  ["device", "multi-control-device.json", (v) => v.device],
  ["envelope", "empty-area.json", (v) => v],
  ["envelope", "deleted-device-tombstone.json", (v) => v],
  ["hubInstallation", "hub-cloudurl-verified.json", (v) => v],
  ["membershipInvitation", "invitation-pending-no-membership.json", (v) => v],
  ["notification", "notification-security-mandatory.json", (v) => v],
  ["override", "override-area-name.json", (v) => v],
  ["supportTicket", "support-ticket-private.json", (v) => v],
  ["supportAccessRequest", "support-access-property-scope.json", (v) => v],
  ["supportSession", "support-session-revoked.json", (v) => v],
  ["supportCodeExchange", "support-code-exchange-test-only.json", (v) => v],
  ["stateEvent", "state-event-valid.json", (v) => v],
  ["uiState", "ui-state-offline.json", (v) => v],
  ["error", "error-home-denied.json", (v) => v],
];
for (const [schemaName, filename, select] of fixtureChecks) {
  const fixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, filename), "utf8"));
  const validator = definitionValidator(schemaName);
  if (!validator(select(fixture)))
    throw new Error(`Fixture ${filename} failed ${schemaName} schema: ${JSON.stringify(validator.errors)}`);
}
// Every checked-in JSON example must be deliberately accounted for. This keeps
// a newly added valid or adversarial fixture from silently becoming an
// unvalidated documentation-only artifact.
const fixtureCases = [
  ["account-session-two-homes.json", "accountSessionContext", (v) => v, true],
  ["customer-session-receipt.json", "customerSessionReceipt", (v) => v, true],
  ["customer-hub-session-test-only.json", "customerHubSession", (v) => v, true],
  ["offline-home-selection.json", "offlineHomeSelection", (v) => v, true],
  ["invalid/offline-home-wrong-account.json", "offlineHomeSelection", (v) => v, true],
  ["invalid/offline-home-expired.json", "offlineHomeSelection", (v) => v, true],
  ["access-policy-selected-tenant.json", "accessPolicy", (v) => v, true],
  ["alexa-discovery-projection.json", "alexaDiscoveryProjection", (v) => v, true],
  ["analytics-unknown-on-expiry.json", "analyticsObservation", (v) => v, true],
  ["automation-full-bundle.json", "automation", (v) => v, true],
  ["claim-first-wins.json", "claimReservation", (v) => v, true],
  ["command-result-uncertain.json", "commandResult", (v) => v, true],
  ["command-valid.json", "command", (v) => v, true],
  ["commissioning-expired.json", "commissioning", (v) => v, true],
  ["control-catalog-change.json", "controlCatalog", (v) => v.catalog, true],
  ["control-catalog-change.json", "controlCatalogEvent", (v) => ({ schemaVersion: "dinodia.v1", homeId: v.catalog.homeId, streamId: "stream:fixture", sequence: 1, generatedAt: "2026-09-27T10:00:00Z", revision: v.catalog.catalogRevision, data: v.catalog }), true],
  ["deleted-device-tombstone.json", "envelope", (v) => v, true],
  ["empty-area.json", "envelope", (v) => v, true],
  ["empty-area.json", "area", (v) => v.data, true],
  ["error-home-denied.json", "error", (v) => v, true],
  ["hub-cloudurl-verified.json", "hubInstallation", (v) => v, true],
  ["invalid/stale-descriptor-command.json", "command", (v) => v.command, true],
  ["invalid/support-ticket-incomplete-home-scope.json", "supportTicket", (v) => v, false],
  ["invalid/tenant-device-wrong-owner.json", "device", (v) => v.device, true],
  ["invalid/unknown-required-version.json", "envelope", (v) => v, false],
  ["invalid/wrong-home-envelope.json", "envelope", (v) => v, true],
  ["invitation-pending-no-membership.json", "membershipInvitation", (v) => v, true],
  ["multi-control-device.json", "device", (v) => v.device, true],
  ["multi-home-memberships.json", "membership", (v) => ({ accountId: v.accountId, ...v.memberships[0] }), true],
  ["notification-security-mandatory.json", "notification", (v) => v, true],
  ["override-area-name.json", "override", (v) => v, true],
  ["stale-and-unavailable-control-state.json", "envelope", (v) => v, true],
  ["stale-and-unavailable-control-state.json", "controlState", (v) => v.data, true],
  ["state-event-valid.json", "stateEvent", (v) => v, true],
  ["support-access-property-scope.json", "supportAccessRequest", (v) => v, true],
  ["support-code-exchange-test-only.json", "supportCodeExchange", (v) => v, true],
  ["support-session-revoked.json", "supportSession", (v) => v, true],
  ["support-ticket-private.json", "supportTicket", (v) => v, true],
  ["ui-state-offline.json", "uiState", (v) => v, true],
  ["unknown-interaction-kind.json", "device", (v) => v.device, false],
];
const semanticOnlyFixturePaths = new Set([
  "analytics-semantics.json",
  "invalid/analytics-invalid-sample.json",
  "duplicate-display-names.json",
  "moved-device.json",
  "multi-channel-mixed-controls.json",
  "out-of-order-events.json",
  "replacement-hub.json",
]);
const indexedFixturePaths = new Set([...fixtureCases.map(([filename]) => filename), ...semanticOnlyFixturePaths]);
if (indexedFixturePaths.size !== fixtureFiles.length) {
  const unindexed = fixtureFiles.map((file) => path.relative(fixtureRoot, file).split(path.sep).join("/")).filter((file) => !indexedFixturePaths.has(file));
  throw new Error(`Contract fixtures lack explicit validation cases: ${unindexed.join(", ")}`);
}
for (const [filename, schemaName, select, expectedValid] of fixtureCases) {
  const fixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, filename), "utf8"));
  const validator = definitionValidator(schemaName);
  const actualValid = Boolean(validator && validator(select(fixture)));
  if (actualValid !== expectedValid)
    throw new Error(`Fixture ${filename} expected ${expectedValid ? "valid" : "invalid"} ${schemaName}; got ${actualValid}: ${JSON.stringify(validator?.errors)}`);
}
const duplicateAreas = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "duplicate-display-names.json"), "utf8"));
if (!duplicateAreas.areas.every((area) => definitionValidator("area")({ ...area, homeId: duplicateAreas.homeId })) || new Set(duplicateAreas.areas.map((area) => area.id)).size !== duplicateAreas.areas.length)
  throw new Error("Duplicate display names must remain valid distinct canonical area identities");
const multiHome = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "multi-home-memberships.json"), "utf8"));
if (!multiHome.memberships.every((membership) => definitionValidator("membership")({ accountId: multiHome.accountId, ...membership })) || new Set(multiHome.memberships.map((membership) => membership.homeId)).size !== multiHome.memberships.length)
  throw new Error("Every multi-home membership must validate independently under its own home authority");
const offlineSelection = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "offline-home-selection.json"), "utf8"));
const offlineValidator = definitionValidator("offlineHomeSelection");
if (!offlineValidator(offlineSelection) || offlineSelection.candidates.some((candidate) => candidate.accountId !== offlineSelection.accountId || candidate.role !== "TENANT" || candidate.areaIds.length === 0))
  throw new Error("Offline candidates must be same-account, previously enrolled tenant memberships with area-scoped authority");
const offlineWrongAccount = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "invalid/offline-home-wrong-account.json"), "utf8"));
const offlineExpired = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "invalid/offline-home-expired.json"), "utf8"));
if (offlineValidator(offlineWrongAccount) !== true || offlineWrongAccount.candidates.every((candidate) => candidate.accountId === offlineWrongAccount.accountId))
  throw new Error("Wrong-account offline fixture must be structurally valid but fail account binding");
if (offlineValidator(offlineExpired) !== true || Date.parse(offlineExpired.candidates[0].expiresAt) > Date.parse(offlineExpired.generatedAt))
  throw new Error("Expired offline fixture must be structurally valid but fail freshness evaluation");
const invalidTenant = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "invalid/tenant-device-wrong-owner.json"), "utf8"));
if (invalidTenant.device.managementClass !== "tenant_device" || invalidTenant.device.ownerMembershipId === invalidTenant.context.homeMembershipId)
  throw new Error("Tenant privacy negative fixture must be structurally valid but owned by another membership");
const staleCommandCase = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "invalid/stale-descriptor-command.json"), "utf8"));
if (staleCommandCase.command.descriptorRevision >= staleCommandCase.currentDescriptorRevision)
  throw new Error("Stale command fixture must be rejected against the higher current descriptor revision");
const outOfOrder = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "out-of-order-events.json"), "utf8"));
if (outOfOrder.expectedAppliedSequences.join(",") !== "12" || outOfOrder.newStreamRequiresFullSnapshot !== true || outOfOrder.events[0].sequence <= outOfOrder.events[1].sequence)
  throw new Error("Out-of-order event fixture must encode latest-sequence-only application and snapshot recovery");
const movedDevice = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "moved-device.json"), "utf8"));
if (movedDevice.areaAssignment.revision <= movedDevice.history.priorAssignmentRevision || movedDevice.areaAssignment.currentAreaId === movedDevice.history.priorAreaId || movedDevice.history.rewriteHistory !== false)
  throw new Error("Moved-device fixture must preserve history while advancing the current area revision");
const replacementHub = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "replacement-hub.json"), "utf8"));
if (replacementHub.hubInstallationId === replacementHub.previousHubInstallationId || replacementHub.nameBasedMergeAllowed !== false)
  throw new Error("Hub replacement must use a new installation identity and prohibit name-based merge");
const mixedChannels = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "multi-channel-mixed-controls.json"), "utf8"));
if (!mixedChannels.channels.length || mixedChannels.channels.some((channel) => channel.deviceId !== mixedChannels.channels[0].deviceId || channel.controls.some((control) => !["boolean", "number", "option", "text", "invoke"].includes(control.valueType) || !["power", "brightness", "active_heat_demand", "active_heat_production", "target_temperature", "ambient_temperature", "opening_percentage", "connectivity", "security_lock", "lock_state", "operating_mode", "position", "volume", "color", "state", "unknown"].includes(control.semanticRole))))
  throw new Error("Mixed-channel controls must retain one device identity and known canonical semantic/value types");
const analyticsSemantics = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "analytics-semantics.json"), "utf8"));
const analyticsNow = Date.parse(analyticsSemantics.now);
if (analyticsSemantics.schemaVersion !== contract.contractVersion || analyticsSemantics.activityCases.length < 10)
  throw new Error("Analytics semantic fixture must cover canonical dinodia.v1 activity boundaries");
for (const item of analyticsSemantics.activityCases) {
  const deadline = Date.parse(item.validUntil);
  const signals = item.signals || {};
  const actual = item.quality !== "fresh" || !Number.isFinite(deadline) || deadline <= analyticsNow ? "unknown" :
    item.category === "light" ? (signals.powerOn === true || typeof signals.brightness === "number" && signals.brightness > 0 ? "on" : signals.powerOn === false || signals.brightness === 0 ? "off" : "unknown") :
    item.category === "radiator" ? (typeof signals.activeHeatDemand === "boolean" ? signals.activeHeatDemand ? "on" : "off" : "unknown") :
    item.category === "boiler" ? (typeof signals.activeHeatProduction === "boolean" ? signals.activeHeatProduction ? "on" : "off" : "unknown") : "unknown";
  if (actual !== item.expected) throw new Error(`Analytics activity semantic mismatch: ${item.id}`);
}
for (const key of ["periodSamples", "periodExpected", "hourSamples", "hourExpected", "displayedBuckets"])
  if (!Array.isArray(analyticsSemantics.aggregation[key])) throw new Error(`Analytics fixture is missing ${key}`);
const invalidAnalyticsSample = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "invalid/analytics-invalid-sample.json"), "utf8"));
if (invalidAnalyticsSample.schemaVersion !== contract.contractVersion || invalidAnalyticsSample.expected !== "reject" || invalidAnalyticsSample.sample.onMinutes >= 0)
  throw new Error("Invalid analytics sample must be a negative semantic fixture");
const wrongHome = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "invalid/wrong-home-envelope.json"), "utf8"));
const wrongHomeEnvelope = definitionValidator("envelope");
if (!wrongHomeEnvelope(wrongHome))
  throw new Error("Wrong-home envelope must remain structurally valid and be rejected by selected-home authorization");
const unknownRequired = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "invalid/unknown-required-version.json"), "utf8"));
if (wrongHomeEnvelope(unknownRequired)) throw new Error("Unknown required contract version was accepted");
const supportTicketValidator = definitionValidator("supportTicket");
const incompleteSupportScope = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "invalid/support-ticket-incomplete-home-scope.json"), "utf8"));
if (supportTicketValidator(incompleteSupportScope)) throw new Error("Support tickets may not carry only one half of the home/membership authority pair");
const staleCommand = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "invalid/stale-descriptor-command.json"), "utf8"));
if (staleCommand.command.descriptorRevision === staleCommand.currentDescriptorRevision)
  throw new Error("Stale-command fixture does not have a stale descriptor revision");
const claim = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "claim-first-wins.json"), "utf8"));
if (claim.state !== "reserved" || claim.firstWins !== true || Date.parse(claim.expiresAt) - Date.parse(claim.createdAt) !== 30 * 60 * 1000)
  throw new Error("Claim first-wins fixture disagrees with the frozen exact reservation window");
const membershipFixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "multi-home-memberships.json"), "utf8"));
if (membershipFixture.memberships.length < 2 || new Set(membershipFixture.memberships.map((m) => m.homeId)).size !== membershipFixture.memberships.length || new Set(membershipFixture.memberships.map((m) => m.homeMembershipId)).size !== membershipFixture.memberships.length)
  throw new Error("Multi-home membership fixture does not prove distinct per-home authority");
for (const [schemaName, filename, select] of [
  ["envelope", "empty-area.json", (fixture) => fixture],
  ["controlState", "stale-and-unavailable-control-state.json", (fixture) => fixture.data],
  ["device", "unknown-interaction-kind.json", (fixture) => fixture.device],
  ["envelope", "invalid/unknown-required-version.json", (fixture) => fixture],
]) {
  const example = JSON.parse(fs.readFileSync(path.join(fixtureRoot, filename), "utf8"));
  const validator = definitionValidator(schemaName);
  const expected = filename.includes("unknown-interaction") || filename.includes("unknown-required-version") ? false : true;
  if (Boolean(validator?.(select(example))) !== expected)
    throw new Error(`Fixture ${filename} disagrees with ${schemaName} validity`);
}
const api = fs.readFileSync(
  path.join(root, "src/lib/contracts/dinodiaV1.ts"),
  "utf8",
);
const validatorNames = [
  "validateNativeDevice",
  "validateMembership",
  "validateAccountSessionContext",
  "validateCustomerSessionReceipt",
  "validateCustomerHubSession",
  "validateOfflineHomeSelection",
  "validateNativeArea",
  "validateEnvelope",
  "validateControlState",
  "validateCommandAgainstDevice",
  "effectiveControlQuality",
];
for (const required of validatorNames)
  if (!api.includes(required))
    throw new Error(`Missing runtime validator ${required}`);
const customerReceipt = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "customer-session-receipt.json"), "utf8"));
const customerHubSession = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "customer-hub-session-test-only.json"), "utf8"));
if (customerHubSession.token !== "TEST_ONLY_PLACEHOLDER_NOT_A_BEARER" || JSON.stringify(customerReceipt).toLowerCase().includes("token"))
  throw new Error("Session contract fixtures must not contain a reusable credential or a bearer-shaped login receipt");
const platformAuth = fs.readFileSync(path.join(root, "src/lib/stage1Auth.ts"), "utf8");
if (!platformAuth.includes("validateMembership") || !platformAuth.includes("./contracts/dinodiaV1"))
  throw new Error("Platform authentication boundary is not using the canonical membership validator");
const osRoot = path.resolve(root, "../Dinodia OS");
const osServer = fs.readFileSync(path.join(osRoot, "src/server.js"), "utf8");
if (!osServer.includes('require("./contracts/dinodiaV1")') || !osServer.includes("serializeNativeDevice") || !osServer.includes('pathname === "/api/dinodia/v1/commands"'))
  throw new Error("Dinodia OS native HTTP serializer/command route is not connected to the canonical validator");
const iosRoot = path.resolve(root, "../dinodia-ios-app-V2");
const iosMapping = fs.readFileSync(path.join(iosRoot, "Dinodia/LiveContracts/DinodiaV1Mapping.swift"), "utf8");
const iosComposition = fs.readFileSync(path.join(iosRoot, "Dinodia/ContentView.swift"), "utf8");
const iosSessionShell = fs.readFileSync(path.join(iosRoot, "Dinodia/LiveContracts/DinodiaV1SessionShell.swift"), "utf8");
if (!iosMapping.includes("decodeDeviceMetadata") || !iosMapping.includes("decodeOfflineHomeSelection") || !iosMapping.includes("validate(_ command: DinodiaV1Command") || !iosSessionShell.includes("activateAfterExactHomeChallenge") || !iosComposition.includes("DinodiaV1ProductionRootView()") || !iosComposition.includes("Stage2ContractUnavailableView()") || !iosComposition.includes("#if DEBUG") || !iosComposition.includes("StaticPreviewApplicationRoot()"))
  throw new Error("iOS must expose the canonical metadata/command adapter and keep static composition behind a debug-only preview gate");
const alexaRoot = path.resolve(root, "../dinodia-alexa-skill-V2");
const alexaRuntime = fs.readFileSync(path.join(alexaRoot, "src/index.ts"), "utf8");
const alexaAdapter = fs.readFileSync(path.join(alexaRoot, "src/dinodiaV1.ts"), "utf8");
if (!alexaRuntime.includes("decodeNativeAlexaDiscovery") || !alexaRuntime.includes("forwardNativeDirective(directive, token)") || !alexaRuntime.includes("!isNativeEndpointId(endpointId)") || !alexaRuntime.includes("https://dinodia-platform-v2.vercel.app") || !alexaRuntime.includes("NativeAlexaUnavailableError") || /\/api\/alexa\/|ha_[a-z0-9]/i.test(alexaRuntime) || !alexaAdapter.includes("d.ownerMembershipId !== context.homeMembershipId"))
  throw new Error("Alexa runtime must use the canonical dinodia.v1 adapter and origin, native endpoint IDs and tenant privacy, with no legacy fallback");
const openapi = fs.readFileSync(
  path.join(root, "contracts/dinodia-v1/openapi.yaml"),
  "utf8",
);
if (!openapi.includes("/api/v2/hub-sessions") || !openapi.includes("customerSessionReceipt") || !openapi.includes("customerHubSession"))
  throw new Error("OpenAPI must describe the login receipt and exact-home short-lived hub session");
if (
  !openapi.includes("/api/dinodia/v1/commands") ||
  openapi.includes("/api/v2/tenant/devices/{deviceId}/commands")
)
  throw new Error(
    "OpenAPI must place tenant live command transport on the OS, not Platform",
  );
const openApiDocument = yaml.load(openapi);
if (openApiDocument?.openapi !== "3.1.0" || !openApiDocument.info?.version || !openApiDocument.paths)
  throw new Error("OpenAPI document is not a complete OpenAPI 3.1 document");
const pointerValue = (rootValue, pointer) => pointer.split("/").slice(1).reduce((value, part) => value?.[part.replaceAll("~1", "/").replaceAll("~0", "~")], rootValue);
for (const [route, pathItem] of Object.entries(openApiDocument.paths)) {
  const templateParameters = [...route.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  for (const [method, operation] of Object.entries(pathItem || {})) {
    if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
    if (!operation.operationId || !operation.responses || !Object.keys(operation.responses).length)
      throw new Error(`OpenAPI operation is missing operationId/responses: ${method.toUpperCase()} ${route}`);
    const parameters = [...(pathItem.parameters || []), ...(operation.parameters || [])].map((parameter) => parameter.$ref ? pointerValue(openApiDocument, parameter.$ref.slice(1)) : parameter);
    for (const name of templateParameters) {
      if (!parameters.some((parameter) => parameter?.in === "path" && parameter.name === name && parameter.required === true))
        throw new Error(`OpenAPI path parameter {${name}} is not declared required: ${route}`);
    }
  }
}
const verifyRefs = (value, location = "OpenAPI") => {
  if (!value || typeof value !== "object") return;
  if (typeof value.$ref === "string") {
    const ref = value.$ref;
    if (ref.startsWith("#/")) {
      if (pointerValue(openApiDocument, ref) === undefined) throw new Error(`Unresolved OpenAPI reference at ${location}: ${ref}`);
    } else if (ref.startsWith("./contract.json#/$defs/")) {
      const name = ref.split("/").at(-1);
      if (!contract.$defs[name]) throw new Error(`Unresolved contract schema reference at ${location}: ${ref}`);
    } else throw new Error(`Unreviewed external OpenAPI reference at ${location}: ${ref}`);
  }
  for (const [key, child] of Object.entries(value)) verifyRefs(child, `${location}.${key}`);
};
verifyRefs(openApiDocument);
const commandOperation = openApiDocument.paths["/api/dinodia/v1/commands"]?.post;
if (!commandOperation?.servers?.some((server) => server.url.includes("dinodia-") && server.url.endsWith(".local:8123")))
  throw new Error("Native command operation must target the selected local OS origin");
const decisions = JSON.parse(
  fs.readFileSync(
    path.join(root, "contracts/dinodia-v1/decisions.json"),
    "utf8",
  ),
);
if (
  decisions.version !== contract.contractVersion ||
  decisions.limits.sensitiveStepUpSeconds !== 120 ||
  decisions.limits.hubOnlineSeconds !== 420
)
  throw new Error(
    "Frozen decision register diverges from the Stage 2 contract",
  );
const requiredDecisions = [
  ["identityLifecycle.activeOwnerMaximumPerHome", 1],
  ["identityLifecycle.invitationCreatesMembership", false],
  ["identityLifecycle.deviceIdentityMergeRequiresProtocolEvidence", true],
  ["homeLifecycle.claimReservationSeconds", 1800],
  ["homeLifecycle.retainedAddressRequiresExplicitConfirmation", true],
  ["homeLifecycle.offlineDeregistrationRemainsPendingUntilAcknowledged", true],
  ["areaAuthority.areaWireNames", ["originalName", "overrideName"]],
  ["controlPolicy.labelAuthority", false],
  ["controlPolicy.currentDescriptorRequiredForWrites", true],
  ["controlPolicy.appOnlySecurityAlexa", false],
  ["uiStates.staleOrOfflineCommandsAllowed", false],
  ["notifications.mandatorySecurityEventsIgnoreQuietHours", true],
  ["provisioning.cloudUrlMustBeIndependentlyVerified", true],
  ["distribution.oldAppImportAllowed", false],
  ["transportPolicy.installerSetup.scheme", "http"],
  ["transportPolicy.installerSetup.path", "/setup"],
  ["transportPolicy.tenantRuntimeLan.scheme", "https"],
  ["transportPolicy.tenantRuntimeLan.port", 8123],
  ["transportPolicy.tenantRuntimeLan.spkiPinRequired", true],
  ["transportPolicy.tenantRuntimeCloud.platformVerifiedCloudUrlRequired", true],
  ["transportPolicy.thirdTransportFallbackAllowed", false],
  ["offlineAuthority.requiresPreviouslyEnrolledTrustedInstallation", true],
  ["offlineAuthority.bindsExactHomeAndMembership", true],
  ["offlineAuthority.scopeCannotWidenOffline", true],
  ["offlineAuthority.applyRevocationAndCurrentPolicyBeforeConnected", true],
  ["analytics.periodAggregation", "average contributing device samples for year/month/week/day"],
  ["analytics.hourAggregation", "sum selected devices per hour"],
  ["analytics.summaryAggregation", "average displayed buckets"],
  ["analytics.expiredOrUnreliableTelemetryIsUnknown", true],
  ["analytics.targetTemperatureIsActivity", false],
  ["analytics.tenantDeviceIncluded", false],
  ["commandPolicy.valueMustMatchDescriptorTypeAndConstraints", true],
  ["commandPolicy.currentDescriptorAndWritabilityRequiredAtDispatch", true],
  ["commandPolicy.sensitiveProofOperationBoundAndSingleUse", true],
  ["commandPolicy.labelsGrantCapability", false],
  ["commandPolicy.uncertainMutationQueriesReceiptBeforeRetry", true],
  ["consumerEligibility.tenantOwnSupportedTenantDeviceMayUseAlexa", true],
  ["consumerEligibility.otherTenantDeviceMayUseAlexa", false],
  ["consumerEligibility.nativeCloudOrigin", "https://dinodia-platform-v2.vercel.app"],
  ["consumerEligibility.alternateCloudOrigin", false],
  ["consumerEligibility.legacyHaRuntime", false],
  ["consumerEligibility.productionStaticDataFallback", false],
  ["identityAndLifecycle.ownerAuthority", "one_active_OWNER_HomeMembership_per_active_home"],
  ["identityAndLifecycle.homeMembershipInvitedStatusAllowed", false],
  ["identityAndLifecycle.homeOwnerUserIdAuthority", false],
  ["identityAndLifecycle.tenantDeviceVisibility", "owning_membership_only"],
  ["uiAndConnectionStates.ownerManagerHomeCloudIndicatorIsSolePersistentConnectionCue", true],
  ["uiAndConnectionStates.localLanRuntimeUsesPinnedHttps", true],
  ["uiAndConnectionStates.installerSetupUsesHttpOnlyOnLan", true],
  ["uiAndConnectionStates.offlineCandidateMustMatchAccountMembershipAndTrustedDevice", true],
  ["uiAndConnectionStates.offlineCandidateSelectionRequiresExactHomeChallenge", true],
  ["uiAndConnectionStates.offlineCandidateMayNotCreateOrWidenAuthority", true],
  ["uiAndConnectionStates.commandsAllowedWhenStaleOrOffline", false],
];
for (const [pointer, expected] of requiredDecisions) {
  const actual = pointer.split(".").reduce((value, key) => value?.[key], decisions);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Missing or conflicting frozen decision: ${pointer}`);
}
const expectedNativeTasks = [
  { taskId: "operator_credential_lifecycle", owner: "supabase_pg_cron_two_minute" },
  { taskId: "support_expiry_and_revocation", owner: "supabase_pg_cron_two_minute" },
  { taskId: "claim_reservation_expiry", owner: "supabase_pg_cron_two_minute" },
  { taskId: "expired_dispatch_lease_cleanup", owner: "vercel_hobby_daily" },
];
if (JSON.stringify(decisions.sync.nativeTaskRegistry) !== JSON.stringify(expectedNativeTasks))
  throw new Error("Native task registry is incomplete or assigns work to multiple schedule owners");
const expectedStage2Allocation = [
  { taskId: "healthAndIncidentQualification", dispatcher: "operations", primaryPath: "signed_heartbeat_or_incident_ingestion", implementationStage: 4 },
  { taskId: "deliveryAndEnforcement", dispatcher: "operations", primaryPath: "durable_outbox_and_hub_sync", implementationStage: 3 },
  { taskId: "credentialLifecycle", dispatcher: "operations", primaryPath: "staff_mutation_inline", implementationStage: 1 },
  { taskId: "alexaProactiveDelivery", dispatcher: "operations", primaryPath: "native_event_ingestion", implementationStage: 7 },
  { taskId: "retentionCleanup", dispatcher: "maintenance", primaryPath: "domain_expiry_metadata", implementationStage: 3 },
  { taskId: "expiryAndOrphanCleanup", dispatcher: "maintenance", primaryPath: "request_completion_or_cancellation", implementationStage: 3 },
  { taskId: "analyticsAndStorageMaintenance", dispatcher: "maintenance", primaryPath: "analytics_ingestion", implementationStage: 10 },
];
if (JSON.stringify(decisions.sync.stage2TaskAllocation) !== JSON.stringify(expectedStage2Allocation))
  throw new Error("Stage 2 fixed task allocation is incomplete, reordered or has conflicting owners");
if (decisions.sync.nativeTaskRegistry.some((task) =>
  decisions.sync.stage2TaskAllocation.some((allocation) => allocation.taskId === task.taskId && allocation.implementationStage !== 1)))
  throw new Error("A later-stage task was activated in the Stage 1 runtime registry");
if (decisions.analytics.activityCategories.join(",") !== "light,radiator,boiler" || decisions.analytics.initialRollupTable !== false || decisions.analytics.usageUnits.join(",") !== "minutes_on,minutes_off,minutes_unknown" || decisions.analytics.temperature !== "radiator temperature only")
  throw new Error("Analytics activity, unit, or initial persistence decision drifted");
if (decisions.transportPolicy.cloudFallbackAfterLanFailures !== decisions.mobile.cloudFallbackAfterLanFailures || decisions.transportPolicy.preferLanAfterSuccessfulProbes !== decisions.mobile.lanPreferAfterSuccesses || decisions.transportPolicy.preferLanAgainAfterSeconds !== decisions.mobile.preferLanAgainAfterSeconds)
  throw new Error("iOS connection hysteresis differs from the shared transport policy");
if (decisions.sensitiveOperations.proofLifetimeSeconds !== decisions.limits.sensitiveStepUpSeconds || decisions.sensitiveOperations.reusableGrace !== false || decisions.sensitiveOperations.singleUse !== true)
  throw new Error("Sensitive-operation proof lifetime or consumption semantics diverged");
const nativeOperations = fs.readFileSync(path.join(root, "src/lib/nativeOperations.ts"), "utf8");
for (const task of expectedNativeTasks)
  if (!nativeOperations.includes(task.taskId) || !nativeOperations.includes(task.owner))
    throw new Error(`Native operations implementation is missing registered task/owner: ${task.taskId}`);
const operationsRoute = fs.readFileSync(path.join(root, "src/app/api/cron/native-operations/route.ts"), "utf8");
const maintenanceRoute = fs.readFileSync(path.join(root, "src/app/api/cron/native-maintenance/route.ts"), "utf8");
if (!operationsRoute.includes("runNativeOperations") || !maintenanceRoute.includes("runNativeMaintenance") || maintenanceRoute.includes("runNativeOperations"))
  throw new Error("The two schedule routes must dispatch disjoint task registries");
const vercelConfig = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
if (!Array.isArray(vercelConfig.crons) || vercelConfig.crons.length !== 1 || vercelConfig.crons[0].path !== "/api/cron/native-maintenance" || vercelConfig.crons[0].schedule !== "0 3 * * *")
  throw new Error("Vercel must own only the daily maintenance schedule");
const stage1Migration = fs.readFileSync(path.join(root, "prisma/migrations/20260922000000_stage1_security_authorities/migration.sql"), "utf8");
if ((stage1Migration.match(/cron\.schedule\s*\(/g) || []).length !== 1 || !stage1Migration.includes("dinodia-native-operations") || !stage1Migration.includes("'*/2 * * * *'"))
  throw new Error("Supabase must own exactly one two-minute operational dispatcher");
const edgeRoot = path.resolve(root, "../dinodia-edge-worker-V2");
const edgeConfig = fs.readFileSync(path.join(edgeRoot, "wrangler.toml"), "utf8");
if (/\[\[triggers\]\]|\bcrons\s*=/.test(edgeConfig))
  throw new Error("The Edge Worker must not own a schedule");
const osExample = fs.readFileSync(path.resolve(root, "../Dinodia OS/.env.example"), "utf8");
if (/^(?:DATABASE_URL|DIRECT_URL|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_DB_PASSWORD)=/m.test(osExample))
  throw new Error("Dinodia OS environment inventory must not request a broad database credential");
if (decisions.routeFamilies.length !== new Set(decisions.routeFamilies).size)
  throw new Error("Duplicate canonical route family");
const matrix = fs.readFileSync(
  path.join(root, "contracts/dinodia-v1/V2_STATIC_TO_LIVE_MATRIX.md"),
  "utf8",
);
if (
  matrix.includes("TBC") ||
  !matrix.includes("## Screen, field, action and state register") ||
  !matrix.includes("tenant.device.command") ||
  !matrix.includes("owner.analytics.hourly") ||
  !matrix.includes("system.transport") ||
  !matrix.includes("Fixed task ownership and activation boundary") ||
  !matrix.includes("stage2TaskAllocation")
)
  throw new Error("Static-to-live screen/action registry is incomplete or contains TBC");
const screenKeys = [...matrix.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]);
if (new Set(screenKeys).size !== screenKeys.length)
  throw new Error("Static-to-live screen/action register contains duplicate stable keys");
for (const key of [
  "auth.owner.sign_in", "auth.owner.registration", "home.claim.scan", "home.claim.manual_code",
  "home.claim.retained_address", "home.claim.lost_reference", "owner.home.deregister",
  "owner.users.manage", "owner.device.information", "owner.password_and_security",
  "tenant.settings", "tenant.logout_and_revoke", "tenant.device.commissioning.recovery",
  "tenant.management.pending", "employee.installation.handoff",
]) if (!screenKeys.includes(key)) throw new Error(`Missing stable V2 screen/action contract key: ${key}`);
const bundleHash = (dir) => {
  const files = [];
  const walk = (current) => {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name !== "manifest.json")
        files.push([
          path.relative(dir, file).split(path.sep).join("/"),
          fs.readFileSync(file),
        ]);
    }
  };
  walk(dir);
  const hash = crypto.createHash("sha256");
  for (const [name, bytes] of files)
    hash.update(name).update("\0").update(bytes).update("\0");
  return hash.digest("hex");
};
for (const [repo, relative] of [
  ["../Dinodia OS", "test/fixtures/contracts/dinodia-v1"],
  ["../dinodia-ios-app-V2", "DinodiaTests/Fixtures/DinodiaV1"],
  ["../dinodia-alexa-skill-V2", "test/fixtures/dinodia-v1"],
  ["../dinodia-edge-worker-V2", "test/fixtures/dinodia-v1"],
]) {
  const target = path.resolve(root, repo, relative);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(target, "manifest.json"), "utf8"),
  );
  if (
    manifest.contractVersion !== contract.contractVersion ||
    manifest.bundleSha256 !== bundleHash(target) ||
    manifest.bundleSha256 !==
      bundleHash(path.join(root, "contracts/dinodia-v1"))
  )
    throw new Error(`Consumer contract bundle drift: ${repo}`);
}
console.log(
  `dinodia.v1 schemas=${schemas.size} JSON fixtures=${fixtureFiles.length} runtime validators=${validatorNames.length}; Alexa projection valid and non-tenant rejected`,
);
