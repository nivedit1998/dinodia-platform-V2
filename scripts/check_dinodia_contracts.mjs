import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import yaml from "js-yaml";
import { assertStage2DecisionFixtures, assertPrototypeActionMatrixBindings, executeIndexedFixtureScenario } from "./dinodia_stage2_decisions.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const osContractRuntime = require(path.resolve(root, "../Dinodia OS/src/contracts/dinodiaV1.js"));
const osAnalyticsRuntime = require(path.resolve(root, "../Dinodia OS/src/contracts/analyticsV1.js"));
const typescript = require("typescript");
const platformContractSource = fs.readFileSync(path.join(root, "src/lib/contracts/dinodiaV1.ts"), "utf8");
const platformContractModule = { exports: {} };
const platformContractCompiled = typescript.transpileModule(platformContractSource, { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 } }).outputText;
new Function("require", "module", "exports", platformContractCompiled)(require, platformContractModule, platformContractModule.exports);
const platformContractRuntime = platformContractModule.exports;
const alexaContractSource = fs.readFileSync(path.resolve(root, "../dinodia-alexa-skill-V2/src/dinodiaV1.ts"), "utf8");
const alexaContractModule = { exports: {} };
const alexaContractCompiled = typescript.transpileModule(alexaContractSource, { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 } }).outputText;
new Function("require", "module", "exports", alexaContractCompiled)(require, alexaContractModule, alexaContractModule.exports);
const alexaContractRuntime = alexaContractModule.exports;
const contract = JSON.parse(
  fs.readFileSync(
    path.join(root, "contracts/dinodia-v1/contract.json"),
    "utf8",
  ),
);
if (contract.contractVersion !== "dinodia.v1")
  throw new Error("Contract version mismatch");
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validUtcTimestamp = (value) => {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const hour = Number(hourText); const minute = Number(minuteText); const second = Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day >= 1 && day <= daysInMonth && Number.isFinite(Date.parse(value));
};
ajv.addFormat("date-time", validUtcTimestamp);
ajv.addFormat("email", /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
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
  "customer-label-unicode-boundaries.json",
  "bounded-string-unicode-semantics.json",
  "notification-delivery-is-not-authority.json",
  "offline-scope-widening.json",
  "support-private-notification.json",
  "support-lifecycle.json",
  "prototype-scenarios.json",
  "index.json",
  "control-catalog-change.json",
  "unknown-interaction-kind.json",
  "invalid/area-negative-revision.json",
  "invalid/control-state-boolean-string.json",
  "invalid/control-state-option-outside-descriptor.json",
  "invalid/writable-unreadable-control.json",
  "invalid/unknown-interaction-commandable.json",
  "stale-and-unavailable-control-state.json",
  "empty-area.json",
  "duplicate-display-names.json",
  "moved-device.json",
  "deleted-device-tombstone.json",
  "replacement-hub.json",
  "invitation-pending-no-membership.json",
  "claim-first-wins.json",
  "support-access-revoke.json",
  "tenant-device-dashboard.json",
  "tenant-device-removal-pending.json",
  "invalid/support-access-revoke-extra-authority.json",
  "notification-security-mandatory.json",
  "analytics-semantics.json",
  "account-relationship-lifecycle.json",
  "claim-lifecycle.json",
  "invitation-lifecycle.json",
  "transfer-lifecycle.json",
  "notification-lifecycle.json",
  "invalid/analytics-invalid-sample.json",
  "hub-cloudurl-verified.json",
  "lan-endpoint-current.json",
  "lan-endpoint-unavailable.json",
  "out-of-order-events.json",
  "invalid/wrong-home-envelope.json",
  "invalid/stale-descriptor-command.json",
  "invalid/impossible-calendar-date-command.json",
  "invalid/unknown-required-version.json",
]) {
  if (!fs.existsSync(path.join(fixtureRoot, required)))
    throw new Error(`Required contract fixture missing: ${required}`);
}
const exampleChecks = [
  ["area", "empty-area.json", (fixture) => fixture.data],
  ["automationPropertyImpactProjection", "automation-property-impact.json", (fixture) => fixture.cases.find((item) => item.expectedDecision === "PROJECTED")?.expectedProjection],
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
  ["tenantMembershipRemovalPreview", "tenant-membership-removal-final-warning.json", (v) => v],
  ["tenantMembershipRemovalRequest", "tenant-membership-removal-request.json", (v) => v],
  ["tenantMembershipRemovalReceipt", "tenant-membership-removal-other-home-preserved.json", (v) => v],
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
  ["automation-property-impact.json", "automationPropertyImpactProjection", (v) => v.cases.find((item) => item.expectedDecision === "PROJECTED")?.expectedProjection, true],
  ["claim-first-wins.json", "claimReservation", (v) => v, true],
  ["command-result-uncertain.json", "commandResult", (v) => v, true],
  ["command-valid.json", "command", (v) => v, true],
  ["commissioning-expired.json", "commissioning", (v) => v, true],
  ["control-catalog-change.json", "controlCatalog", (v) => v.catalog, true],
  ["control-catalog-change.json", "controlCatalogEvent", (v) => ({ schemaVersion: "dinodia.v1", homeId: v.catalog.homeId, streamId: "stream:fixture", sequence: 1, generatedAt: "2026-09-27T10:00:00Z", revision: v.catalog.catalogRevision, data: v.catalog }), true],
  ["deleted-device-tombstone.json", "envelope", (v) => v, true],
  ["invalid/impossible-calendar-date-envelope.json", "envelope", (v) => v, false],
  ["empty-area.json", "envelope", (v) => v, true],
  ["empty-area.json", "area", (v) => v.data, true],
  ["error-home-denied.json", "error", (v) => v, true],
  ["hub-cloudurl-verified.json", "hubInstallation", (v) => v, true],
  ["lan-endpoint-current.json", "lanEndpointObservation", (v) => v, true],
  ["lan-endpoint-unavailable.json", "lanEndpointObservation", (v) => v, true],
  ["invalid/lan-endpoint-public-address.json", "lanEndpointObservation", (v) => v, false],
  ["invalid/lan-endpoint-extra-authority-field.json", "lanEndpointObservation", (v) => v, false],
  ["invalid/stale-descriptor-command.json", "command", (v) => v.command, true],
  ["invalid/impossible-calendar-date-command.json", "command", (v) => v.command, false],
  ["invalid/support-ticket-incomplete-home-scope.json", "supportTicket", (v) => v, false],
  ["invalid/tenant-device-wrong-owner.json", "device", (v) => v.device, true],
  ["invalid/unknown-required-version.json", "envelope", (v) => v, false],
  ["invalid/wrong-home-envelope.json", "envelope", (v) => v, true],
  ["invitation-pending-no-membership.json", "membershipInvitation", (v) => v, true],
  ["multi-control-device.json", "device", (v) => v.device, true],
  ["selected-tenant-property-device.json", "device", (v) => v.device, true],
  ["selected-tenant-private-device.json", "device", (v) => v.device, true],
  ["multi-home-memberships.json", "membership", (v) => ({ accountId: v.accountId, ...v.memberships[0] }), true],
  ["notification-security-mandatory.json", "notification", (v) => v, true],
  ["ownership-transfer-api.json", "ownershipTransferStatus", (v) => v.status, true],
  ["override-area-name.json", "override", (v) => v, true],
  ["stale-and-unavailable-control-state.json", "envelope", (v) => v, true],
  ["stale-and-unavailable-control-state.json", "controlState", (v) => v.data, true],
  ["state-event-valid.json", "stateEvent", (v) => v, true],
  ["support-access-property-scope.json", "supportAccessRequest", (v) => v, true],
  ["support-access-revoke.json", "supportAccessRevokeRequest", (v) => v.request, true],
  ["support-access-revoke.json", "supportAccessRevokeReceipt", (v) => v.receipt, true],
  ["invalid/support-access-revoke-extra-authority.json", "supportAccessRevokeRequest", (v) => v, false],
  ["support-code-exchange-test-only.json", "supportCodeExchange", (v) => v, true],
  ["support-session-revoked.json", "supportSession", (v) => v, true],
  ["support-ticket-private.json", "supportTicket", (v) => v, true],
  ["tenant-membership-removal-request.json", "tenantMembershipRemovalRequest", (v) => v, true],
  ["invalid/tenant-membership-removal-unscoped.json", "tenantMembershipRemovalRequest", (v) => v, false],
  ["tenant-membership-removal-final-warning.json", "tenantMembershipRemovalPreview", (v) => v, true],
  ["tenant-membership-removal-other-home-preserved.json", "tenantMembershipRemovalReceipt", (v) => v, true],
  ["tenant-device-dashboard.json", "tenantDeviceContext", (v) => v, true],
  ["tenant-device-removal-pending.json", "tenantDeviceRemovalRequest", (v) => v.request, true],
  ["tenant-device-removal-pending.json", "tenantDeviceRemovalReceipt", (v) => v.receipt, true],
  ["updater-maintenance-status-unprovisioned.json", "updaterMaintenanceStatus", (v) => v, true],
  ["invalid/updater-maintenance-status-exposes-authority.json", "updaterMaintenanceStatus", (v) => v, false],
  ["invalid/area-negative-revision.json", "area", (v) => v, false],
  ["invalid/control-state-boolean-string.json", "controlState", (v) => v.data, true],
  ["invalid/control-state-option-outside-descriptor.json", "controlState", (v) => v.state, true],
  ["ui-state-offline.json", "uiState", (v) => v, true],
  ["unknown-interaction-kind.json", "device", (v) => v.device, true],
];
const semanticOnlyFixturePaths = new Set([
  "account-relationship-lifecycle.json",
  "customer-recovery-lifecycle.json",
  "analytics-semantics.json",
  "claim-lifecycle.json",
  "invitation-lifecycle.json",
  "invalid/analytics-invalid-sample.json",
  "invalid/device-missing-step-up-policy.json",
  "invalid/device-invalid-step-up-policy.json",
  "invalid/writable-unreadable-control.json",
  "invalid/unknown-interaction-commandable.json",
  "invalid/duplicate-device-control-id.json",
  "invalid/automation-property-target-extra-authority.json",
  "duplicate-display-names.json",
  "notification-delivery-is-not-authority.json",
  "offline-scope-widening.json",
  "support-private-notification.json",
  "support-lifecycle.json",
  "transfer-lifecycle.json",
  "index.json",
  "moved-device.json",
  "multi-channel-mixed-controls.json",
  "customer-label-unicode-boundaries.json",
  "bounded-string-unicode-semantics.json",
  "hub-heartbeat-freshness.json",
  "notification-lifecycle.json",
  "ios-v2-distribution-identity.json",
  "out-of-order-events.json",
  "replacement-hub.json",
  "stale-policy.json",
  "trusted-device-revocation.json",
  "offline-deregistration-pending.json",
  "room-qr-lifecycle.json",
  "prototype-scenarios.json",
  "installation-request-lifecycle.json",
  "area-edit-lifecycle.json",
  "access-request-lifecycle.json",
  "stage2-decision-matrix.json",
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
const impossibleDateEnvelope = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "invalid/impossible-calendar-date-envelope.json"), "utf8"));
if (definitionValidator("envelope")(impossibleDateEnvelope) || platformContractRuntime.validateEnvelope(impossibleDateEnvelope) || osContractRuntime.validateEnvelope(impossibleDateEnvelope))
  throw new Error("Impossible calendar date must be rejected by schema, Platform and OS envelope validators");
const missingStepUpScenario = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "invalid/device-missing-step-up-policy.json"), "utf8"));
const missingStepUpSource = JSON.parse(fs.readFileSync(path.join(fixtureRoot, missingStepUpScenario.sourceFixture.replace(/^fixtures\//, "")), "utf8"));
const missingStepUpDevice = structuredClone(missingStepUpSource.device);
const missingStepUpControl = missingStepUpDevice.controls.find((control) => control.controlId === missingStepUpScenario.controlId);
if (!missingStepUpControl || missingStepUpScenario.removeField !== "stepUpPolicy") throw new Error("Missing-step-up fixture does not identify its source control and required field");
delete missingStepUpControl.stepUpPolicy;
if (definitionValidator("device")(missingStepUpDevice) || platformContractRuntime.validateNativeDevice(missingStepUpDevice) || osContractRuntime.validateDevice(missingStepUpDevice, { homeId: missingStepUpDevice.homeId, homeMembershipId: "membership:owner-a", role: "OWNER", areaIds: missingStepUpDevice.areaIds }))
  throw new Error("Missing stepUpPolicy must be rejected by schema, Platform and OS before control projection");
const invalidStepUpScenario = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "invalid/device-invalid-step-up-policy.json"), "utf8"));
if (typeof invalidStepUpScenario.sourceFixture !== "string" || !invalidStepUpScenario.sourceFixture.startsWith("fixtures/"))
  throw new Error("Invalid-step-up fixture must reference an exact source fixture path");
const invalidStepUpSource = JSON.parse(fs.readFileSync(path.join(fixtureRoot, invalidStepUpScenario.sourceFixture.slice("fixtures/".length)), "utf8"));
const invalidStepUpDevice = structuredClone(invalidStepUpSource.device);
const invalidStepUpControl = invalidStepUpDevice.controls.find((control) => control.controlId === invalidStepUpScenario.controlId);
if (!invalidStepUpControl || invalidStepUpScenario.field !== "stepUpPolicy" || ["none", "required"].includes(invalidStepUpScenario.invalidValue))
  throw new Error("Invalid-step-up fixture must identify a descriptor control and a forbidden enum value");
invalidStepUpControl.stepUpPolicy = invalidStepUpScenario.invalidValue;
if (definitionValidator("device")(invalidStepUpDevice) || platformContractRuntime.validateNativeDevice(invalidStepUpDevice) || osContractRuntime.validateDevice(invalidStepUpDevice, { homeId: invalidStepUpDevice.homeId, homeMembershipId: "membership:owner-a", role: "OWNER", areaIds: invalidStepUpDevice.areaIds }))
  throw new Error("Invalid stepUpPolicy must be rejected by schema, Platform and OS before projection");
const unreadableMutation = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "invalid/writable-unreadable-control.json"), "utf8"));
const unreadableSource = JSON.parse(fs.readFileSync(path.join(fixtureRoot, unreadableMutation.sourceFixture.replace(/^fixtures\//, "")), "utf8"));
const unreadableDevice = structuredClone(unreadableSource.device);
const unreadableControl = unreadableDevice.controls.find((control) => control.controlId === unreadableMutation.mutation.controlId);
if (!unreadableControl) throw new Error("Writable/unreadable negative fixture references a missing control");
Object.assign(unreadableControl, unreadableMutation.mutation);
if (definitionValidator("device")(unreadableDevice) || platformContractRuntime.validateNativeDevice(unreadableDevice) || osContractRuntime.validateDevice(unreadableDevice, { homeId: unreadableDevice.homeId, homeMembershipId: "membership:owner-a", role: "OWNER", areaIds: unreadableDevice.areaIds }))
  throw new Error("Writable-but-unreadable control was accepted by a canonical schema/runtime consumer");
const duplicateControlCase = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "invalid/duplicate-device-control-id.json"), "utf8"));
if (duplicateControlCase.expected !== "reject_descriptor_before_projection_or_dispatch" || duplicateControlCase.schemaExpected !== "structurally_valid_distinct_objects" || !duplicateControlCase.sourceFixture?.startsWith("fixtures/"))
  throw new Error("Duplicate-control fixture must state its structural-schema and semantic-consumer outcomes");
const duplicateControlSource = JSON.parse(fs.readFileSync(path.join(fixtureRoot, duplicateControlCase.sourceFixture.slice("fixtures/".length)), "utf8"));
const duplicateControlDevice = structuredClone(duplicateControlSource.device);
const duplicateControlTarget = duplicateControlDevice.controls.find((control) => control.controlId === duplicateControlCase.targetControlId);
if (duplicateControlDevice.id !== duplicateControlCase.deviceId || !duplicateControlTarget || !duplicateControlDevice.controls.some((control) => control.controlId === duplicateControlCase.duplicateControlId))
  throw new Error("Duplicate-control fixture references a missing source device/control");
duplicateControlTarget.controlId = duplicateControlCase.duplicateControlId;
if (!definitionValidator("device")(duplicateControlDevice) || platformContractRuntime.validateNativeDevice(duplicateControlDevice) || osContractRuntime.validateDevice(duplicateControlDevice, { homeId: duplicateControlDevice.homeId, homeMembershipId: duplicateControlSource.context.homeMembershipId, role: "OWNER", areaIds: duplicateControlDevice.areaIds }))
  throw new Error("Schema must accept distinct descriptor objects while Platform and OS reject duplicate canonical control IDs");
const duplicateAlexaProjection = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "alexa-discovery-projection.json"), "utf8"));
const duplicateAlexaDevice = structuredClone(duplicateAlexaProjection.data[0]);
if (duplicateAlexaDevice.controls.length < 2) throw new Error("Alexa duplicate-control projection fixture must have at least two controls");
duplicateAlexaDevice.controls[1].controlId = duplicateAlexaDevice.controls[0].controlId;
if (alexaContractRuntime.decodeNativeAlexaDevices({ schemaVersion: "dinodia.v1", homeId: duplicateAlexaProjection.homeId, streamId: "stream:duplicate-control", sequence: 1, generatedAt: "2026-09-27T10:00:00Z", revision: 1, data: [duplicateAlexaDevice] }, { homeId: duplicateAlexaProjection.homeId, homeMembershipId: duplicateAlexaProjection.membership.homeMembershipId, role: "TENANT", authorisedAreaIds: duplicateAlexaProjection.selectedAreaIds }) !== null)
  throw new Error("Alexa adapter must reject duplicate canonical control IDs before exposure projection");
const unknownSafeFixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "unknown-interaction-kind.json"), "utf8"));
if (!definitionValidator("device")(unknownSafeFixture.device) || !platformContractRuntime.validateNativeDevice(unknownSafeFixture.device) || !osContractRuntime.validateDevice(unknownSafeFixture.device, { homeId: unknownSafeFixture.device.homeId, homeMembershipId: "membership:owner-a", role: "OWNER", areaIds: unknownSafeFixture.device.areaIds }))
  throw new Error("Safe unknown interaction must remain valid read-only metadata across schema, Platform and OS");
const unknownCommandable = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "invalid/unknown-interaction-commandable.json"), "utf8"));
const unknownSource = JSON.parse(fs.readFileSync(path.join(fixtureRoot, unknownCommandable.sourceFixture.replace(/^fixtures\//, "")), "utf8"));
const unsafeUnknownDevice = structuredClone(unknownSource.device);
const unsafeUnknownControl = unsafeUnknownDevice.controls.find((control) => control.controlId === unknownCommandable.controlId);
if (!unsafeUnknownControl) throw new Error("Unknown-interaction negative fixture references a missing control");
Object.assign(unsafeUnknownControl, unknownCommandable.mutation);
if (definitionValidator("device")(unsafeUnknownDevice) || platformContractRuntime.validateNativeDevice(unsafeUnknownDevice) || osContractRuntime.validateDevice(unsafeUnknownDevice, { homeId: unsafeUnknownDevice.homeId, homeMembershipId: "membership:owner-a", role: "OWNER", areaIds: unsafeUnknownDevice.areaIds }))
  throw new Error("Unknown interaction with write authority was accepted by a canonical schema/runtime consumer");
const labelBoundaryFixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "customer-label-unicode-boundaries.json"), "utf8"));
if (labelBoundaryFixture.schemaVersion !== contract.contractVersion || labelBoundaryFixture.countingUnit !== "unicode_code_points" || labelBoundaryFixture.maximumPublicCodePoints !== 40 || labelBoundaryFixture.authority !== "presentation_only")
  throw new Error("Customer label fixture must freeze a presentation-only 40 Unicode-code-point boundary");
for (const item of labelBoundaryFixture.cases) {
  const raw = typeof item.value === "string" ? item.value : String(item.repeat || "").repeat(Number(item.repeatCount || 0));
  const projected = raw.length === 0 ? null : Array.from(raw).slice(0, labelBoundaryFixture.maximumPublicCodePoints).join("");
  const projectedCodePoints = projected === null ? 0 : Array.from(projected).length;
  const expectedRepeatedUnits = item.repeat && item.projectedRepeatCount !== undefined ? item.repeat.repeat(item.projectedRepeatCount) : undefined;
  if (item.projected !== undefined && projected !== item.projected || expectedRepeatedUnits !== undefined && projected !== expectedRepeatedUnits || projectedCodePoints !== item.projectedCodePoints)
    throw new Error(`Customer label projection mismatch: ${item.id}`);
  const candidate = { ...valid.device, customerLabel: raw };
  const expected = item.wireValid === true;
  const schemaAccepted = Boolean(schemas.get("device")(candidate));
  const platformAccepted = platformContractRuntime.validateNativeDevice(candidate);
  const osAccepted = osContractRuntime.validateDevice(candidate, { homeId: candidate.homeId, homeMembershipId: "membership:owner-a", role: "OWNER", areaIds: candidate.areaIds });
  if (schemaAccepted !== expected || platformAccepted !== expected || osAccepted !== expected)
    throw new Error(`Customer label bound differs across schema, Platform and OS: ${item.id}`);
}
const boundedStringFixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "bounded-string-unicode-semantics.json"), "utf8"));
if (boundedStringFixture.schemaVersion !== contract.contractVersion || boundedStringFixture.lengthUnit !== "unicode_code_points" || !Array.isArray(boundedStringFixture.boundaryCases) || !Array.isArray(boundedStringFixture.combiningSequenceCases))
  throw new Error("Bounded string fixture must freeze JSON Schema Unicode-code-point semantics");
const repeatedCodePoints = (item, count) => item.repeat.repeat(count);
const commandBound = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "command-valid.json"), "utf8"));
const areaBound = { id: "area:living", homeId: valid.device.homeId, originalName: "Living", overrideName: null, revision: 1, lifecycle: "active" };
for (const item of [...boundedStringFixture.boundaryCases, ...boundedStringFixture.combiningSequenceCases]) {
  const at = repeatedCodePoints(item, item.validRepeatCount);
  const over = repeatedCodePoints(item, item.invalidRepeatCount);
  const outcomes = [];
  if (item.field === "opaqueId") {
    const withId = (id) => ({ ...valid.device, id, controls: valid.device.controls.map((control) => ({ ...control, deviceId: id })) });
    outcomes.push([platformContractRuntime.validateNativeDevice(withId(at)), osContractRuntime.validateDevice(withId(at))]);
    outcomes.push([platformContractRuntime.validateNativeDevice(withId(over)), osContractRuntime.validateDevice(withId(over))]);
  } else if (item.field === "areaName") {
    outcomes.push([platformContractRuntime.validateNativeArea({ ...areaBound, originalName: at }), osContractRuntime.validateArea({ ...areaBound, originalName: at }, areaBound.homeId)]);
    outcomes.push([platformContractRuntime.validateNativeArea({ ...areaBound, originalName: over }), osContractRuntime.validateArea({ ...areaBound, originalName: over }, areaBound.homeId)]);
  } else if (item.field === "controlLabel") {
    const withLabel = (label) => ({ ...valid.device, controls: valid.device.controls.map((control, index) => index ? control : { ...control, label }) });
    outcomes.push([platformContractRuntime.validateNativeDevice(withLabel(at)), osContractRuntime.validateDevice(withLabel(at))]);
    outcomes.push([platformContractRuntime.validateNativeDevice(withLabel(over)), osContractRuntime.validateDevice(withLabel(over))]);
  } else if (item.field === "constraintUnit" || item.field === "optionLabel") {
    const withConstraintText = (value) => ({ ...valid.device, controls: [{ ...valid.device.controls[0], valueType: "option", interactionKind: "picker", constraints: { unit: item.field === "constraintUnit" ? value : "mode", options: [{ value: "on", label: item.field === "optionLabel" ? value : "On" }] } }] });
    outcomes.push([platformContractRuntime.validateNativeDevice(withConstraintText(at)), osContractRuntime.validateDevice(withConstraintText(at))]);
    outcomes.push([platformContractRuntime.validateNativeDevice(withConstraintText(over)), osContractRuntime.validateDevice(withConstraintText(over))]);
  } else if (item.field === "textCommand" || item.field === "idempotencyKey") {
    const control = { ...valid.device.controls[0], valueType: item.field === "textCommand" ? "text" : "boolean", interactionKind: item.field === "textCommand" ? "text_input" : "toggle" };
    const device = { ...valid.device, controls: [control] };
    const makeCommand = (value, idempotencyKey) => ({ ...commandBound, homeId: device.homeId, deviceId: device.id, controlId: control.controlId, descriptorRevision: device.descriptorRevision, value, idempotencyKey });
    const validValue = item.field === "textCommand" ? at : true;
    const invalidValue = item.field === "textCommand" ? over : true;
    const validKey = item.field === "idempotencyKey" ? at : commandBound.idempotencyKey;
    const invalidKey = item.field === "idempotencyKey" ? over : commandBound.idempotencyKey;
    outcomes.push([platformContractRuntime.validateCommandAgainstDevice(makeCommand(validValue, validKey), device, control, commandBound.homeMembershipId), osContractRuntime.validateCommand(makeCommand(validValue, validKey), device, control, commandBound.homeMembershipId)]);
    outcomes.push([platformContractRuntime.validateCommandAgainstDevice(makeCommand(invalidValue, invalidKey), device, control, commandBound.homeMembershipId), osContractRuntime.validateCommand(makeCommand(invalidValue, invalidKey), device, control, commandBound.homeMembershipId)]);
    if (item.invalidMinimumRepeatCount !== undefined) {
      const tooShort = makeCommand(true, repeatedCodePoints(item, item.invalidMinimumRepeatCount));
      if (platformContractRuntime.validateCommandAgainstDevice(tooShort, device, control, commandBound.homeMembershipId) || osContractRuntime.validateCommand(tooShort, device, control, commandBound.homeMembershipId))
        throw new Error(`Unicode idempotency minimum mismatch: ${item.id}`);
    }
  }
  const expected = [[true, true], [false, false]];
  if (JSON.stringify(outcomes) !== JSON.stringify(expected)) throw new Error(`Unicode bounded-string semantics drift across Platform/OS: ${item.id} ${JSON.stringify(outcomes)}`);
}
const invalidBooleanState = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "invalid/control-state-boolean-string.json"), "utf8")).data;
const booleanDevice = valid.device;
const booleanControl = booleanDevice.controls.find((control) => control.valueType === "boolean");
if (!booleanControl || platformContractRuntime.validateControlState(invalidBooleanState, booleanDevice, booleanControl) ||
    osContractRuntime.validateControlState(invalidBooleanState, booleanDevice, booleanControl))
  throw new Error("A structurally valid string-valued state must be rejected by both Platform and OS against its boolean descriptor");
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
const decisionMatrix = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "stage2-decision-matrix.json"), "utf8"));
const prototypeScenarios = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "prototype-scenarios.json"), "utf8"));
const recoveryLifecycle = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "customer-recovery-lifecycle.json"), "utf8"));
if (recoveryLifecycle.authority !== "account_recovery_contract_only" || recoveryLifecycle.persistenceStage !== 3 ||
    recoveryLifecycle.cases.some((item) => item.accountExistsDisclosed !== false || item.sessionIssued !== false) ||
    recoveryLifecycle.cases[0]?.responseClass !== recoveryLifecycle.cases[1]?.responseClass)
  throw new Error("Customer recovery fixtures must conceal account existence, issue no session, and remain a Stage 3 persistence contract");
const stalePolicy = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "stale-policy.json"), "utf8"));
if (stalePolicy.currentPolicyRevision <= stalePolicy.cachedPolicyRevision || stalePolicy.expected.canMutate !== false ||
    stalePolicy.expected.canWidenOfflineScope !== false || stalePolicy.expected.clearStaleAuthorityBeforeReconnect !== true)
  throw new Error("Stale policy must block mutation and scope widening until current authority is revalidated");
const trustedRevocation = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "trusted-device-revocation.json"), "utf8"));
if (trustedRevocation.affectedMemberships.length < 2 || trustedRevocation.expected.allSessionsForInstallationRevoked !== true ||
    trustedRevocation.expected.allOfflineLanAuthorisationsForInstallationRevoked !== true || trustedRevocation.expected.unrelatedTrustedDevicePreserved !== true ||
    trustedRevocation.expected.offlineHubEnforcement !== "pending_until_acknowledged")
  throw new Error("Trusted Device removal must revoke only that app installation across all homes and preserve unrelated devices");
const pendingDeregistration = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "offline-deregistration-pending.json"), "utf8"));
if (pendingDeregistration.platformAuthority !== "revoked" || pendingDeregistration.hubAcknowledgement !== "pending" ||
    pendingDeregistration.expected.protectedCustomerReads !== false || pendingDeregistration.expected.protectedCommands !== false ||
    pendingDeregistration.expected.reportComplete !== false || pendingDeregistration.expected.retainedPhysicalPropertyPreserved !== true)
  throw new Error("Offline deregistration must deny customer authority while honestly retaining physical property state pending hub acknowledgement");
const requiredPrototypeFlows = ["support", "invitation", "room-qr", "property-actions", "area-edit", "quiet-hours", "trusted-device", "access-request", "descriptor-change", "claim", "recovery", "management-activity", "installation-request"];
const knownPrototypeRoles = new Set(["Homeowner", "Property manager", "Tenant"]);
if (prototypeScenarios.schemaVersion !== contract.contractVersion ||
    JSON.stringify(Object.keys(prototypeScenarios.flows ?? {}).sort()) !== JSON.stringify([...requiredPrototypeFlows].sort()))
  throw new Error("Rendered prototype scenario fixture must define every required flow exactly once");
for (const [flowId, flow] of Object.entries(prototypeScenarios.flows)) {
  if (typeof flow.initialOutcome !== "string" || !flow.initialOutcome.trim() || !Array.isArray(flow.actions) || flow.actions.length === 0)
    throw new Error(`Rendered prototype flow has no initial outcome or actions: ${flowId}`);
  const ids = new Set();
  for (const action of flow.actions) {
    if (typeof action.id !== "string" || !action.id.trim() || ids.has(action.id) ||
        typeof action.label !== "string" || !action.label.trim() ||
        typeof action.outcome !== "string" || !action.outcome.trim() ||
        action.allowedRoles !== undefined && (!Array.isArray(action.allowedRoles) || action.allowedRoles.length === 0 || action.allowedRoles.some((role) => !knownPrototypeRoles.has(role))))
      throw new Error(`Rendered prototype scenario is malformed or repeats an action: ${flowId}`);
    ids.add(action.id);
  }
}
const prototypeAction = (flow, action) => prototypeScenarios.flows[flow].actions.find((candidate) => candidate.id === action);
if (!prototypeAction("invitation", "accept").outcome.includes("membership must then be revalidated") ||
    !prototypeAction("invitation", "resend").outcome.includes("old link and projection are invalidated") ||
    !prototypeAction("invitation", "expire").outcome.includes("exact deadline") ||
    !prototypeAction("property-actions", "active-tenant-successor").outcome.includes("Denied before mutation") ||
    !prototypeAction("property-actions", "verified-staff-replace").outcome.includes("non-expiring transfer claim") ||
    !prototypeAction("property-actions", "alternate-replay").outcome.includes("cannot complete a second transfer") ||
    !prototypeAction("room-qr", "unclaimed-home").outcome.includes("no access request or membership") ||
    !prototypeAction("property-actions", "offline-deregister").outcome.includes("pending hub acknowledgement") ||
    !prototypeAction("claim", "noop-save").outcome.includes("No extension") ||
    !prototypeAction("recovery", "expired-proof").outcome.includes("no customer session") ||
    !prototypeAction("support", "private-request").outcome.includes("property owner is not notified") ||
    !prototypeAction("quiet-hours", "receipt").outcome.includes("grants no membership") ||
    prototypeAction("property-actions", "transfer").allowedRoles?.join(",") !== "Homeowner" ||
    prototypeAction("area-edit", "current").allowedRoles?.join(",") !== "Homeowner,Property manager")
  throw new Error("Rendered prototype scenarios contradict invitation, claim, support, privacy or role authority decisions");
if (!prototypeAction("claim", "required-save").outcome.includes("exactly 30 minutes") ||
    prototypeAction("claim", "required-save").outcome.includes("extends once"))
  throw new Error("Claim prototype must model each successful required save as a fresh 30-minute deadline; it is not a one-extension allowance");
// The decision matrix is fixture input for rendered review, not proof that its
// boolean expectations are true. Execute the overlapping identity, area,
// tenant-privacy and command cases against the real OS contract validators.
const matrixOwnerIds = decisionMatrix.identity.activeOwnerMembershipIds;
const matrixManagerIds = decisionMatrix.identity.activeManagerMembershipIds;
if (decisionMatrix.schemaVersion !== contract.contractVersion || matrixOwnerIds.length !== 1 || matrixManagerIds.length < 2 ||
    new Set([...matrixOwnerIds, ...matrixManagerIds]).size !== matrixOwnerIds.length + matrixManagerIds.length)
  throw new Error("Decision fixture must describe exactly one distinct owner and multiple manager memberships");
const decisionMemberships = [
  ...matrixOwnerIds.map((homeMembershipId) => ({ accountId: decisionMatrix.identity.accountId, homeId: decisionMatrix.property.homeId, homeMembershipId, role: "OWNER", status: "active", areaIds: duplicateAreas.areas.map((area) => area.id), revision: 1 })),
  ...matrixManagerIds.map((homeMembershipId) => ({ accountId: decisionMatrix.identity.accountId, homeId: decisionMatrix.property.homeId, homeMembershipId, role: "PROPERTY_MANAGER", status: "active", areaIds: duplicateAreas.areas.map((area) => area.id), revision: 1 })),
];
if (!decisionMemberships.every((membership) => osContractRuntime.validateMembership(membership, membership.homeId)))
  throw new Error("Decision fixture owner/manager memberships must decode through the OS runtime");
const pendingInvitation = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "invitation-pending-no-membership.json"), "utf8"));
if (!definitionValidator("membershipInvitation")(pendingInvitation) || pendingInvitation.state !== "pending" || pendingInvitation.membershipId !== null)
  throw new Error("Pending invitation must validate without creating membership authority");
const invitationLifecycle = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "invitation-lifecycle.json"), "utf8"));
const invitationInitial = invitationLifecycle.initial;
const invitationIssued = Date.parse(invitationInitial.issuedAt);
const invitationExpiry = Date.parse(invitationInitial.expiresAt);
if (invitationLifecycle.lifetimeSeconds !== 604800 || invitationExpiry - invitationIssued !== 604800_000 ||
    invitationInitial.state !== "pending" || invitationInitial.membershipId !== null || invitationInitial.areaIds.length < 1 ||
    invitationLifecycle.roleRules.tenantRequiresAtLeastOneCanonicalArea !== true || invitationLifecycle.roleRules.managerAreaIds.length !== 0 ||
    invitationLifecycle.credentialDelivery.tenantInitialPasswordServerGenerated !== true || invitationLifecycle.credentialDelivery.homeownerReceivesPlaintextTenantPassword !== false ||
    invitationLifecycle.credentialDelivery.deliveryReceiptCreatesMembership !== false)
  throw new Error("Invitation must use its exact seven-day lifetime, create no pending membership, require tenant area scope, and avoid homeowner plaintext credentials");
const allowedInvitationProjectionKeys = new Set(["fullPostcode", "proposedRole", "inviterDisplayLabel", "issuedAt", "expiresAt", "forbiddenKeys"]);
if (Object.keys(invitationLifecycle.recipientProjection).some((key) => !allowedInvitationProjectionKeys.has(key)) ||
    invitationLifecycle.recipientProjection.forbiddenKeys.some((key) => key in invitationLifecycle.recipientProjection) ||
    invitationLifecycle.recipientProjection.expiresAt !== invitationInitial.expiresAt)
  throw new Error("Pre-acceptance invitation projection disclosed property details or drifted from the durable expiry");
for (const scenario of invitationLifecycle.cases) {
  const at = Date.parse(scenario.at);
  const recipient = scenario.authenticatedAccountId === invitationInitial.recipientAccountId;
  const verified = recipient && scenario.emailVerified === true;
  const beforeDeadline = at < invitationExpiry;
  const expected = !recipient ? "INVITATION_RECIPIENT_MISMATCH"
    : !verified ? "EMAIL_VERIFICATION_REQUIRED"
      : scenario.explicitDecline === true ? "INVITATION_DECLINED"
        : !scenario.explicitAccept ? "INVITATION_PENDING"
        : !beforeDeadline ? "INVITATION_EXPIRED"
          : scenario.authorityRevalidated === true ? "MEMBERSHIP_ACTIVE" : "INVITATION_PENDING";
  const membership = expected === "MEMBERSHIP_ACTIVE" ? "membership:recipient-home" : null;
  if (scenario.expected !== expected || scenario.membershipId !== membership)
    throw new Error(`Invitation transition semantics mismatch: ${scenario.id}`);
}
const resend = invitationLifecycle.resend;
if (resend.newGeneration !== resend.oldGeneration + 1 || Date.parse(resend.newExpiresAt) - Date.parse(resend.resentAt) !== invitationLifecycle.lifetimeSeconds * 1000 ||
    resend.oldLinkOutcome !== "INVITATION_REPLACED" || resend.oldRecipientProjectionVisible !== false || resend.oldMembershipCreated !== false || resend.newCommunicationOnly !== true ||
    invitationLifecycle.resultCommunication.expiryNotificationSent !== false || invitationLifecycle.resultCommunication.resendSendsOnlyNewGeneration !== true ||
    invitationLifecycle.resultCommunication.acceptAndDeclineDeduplicatedPush !== true || invitationLifecycle.resultCommunication.acceptAndDeclineVerifiedEmail !== true)
  throw new Error("Invitation resend/expiry/result communications must invalidate the old generation and avoid expiry notification noise");
const transferLifecycle = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "transfer-lifecycle.json"), "utf8"));
const transferClaim = transferLifecycle.activeClaim;
if (transferClaim.state !== "active" || transferClaim.expiresAt !== null || Date.parse(transferClaim.validatedAt) - Date.parse(transferClaim.createdAt) < 10 * 365 * 24 * 60 * 60 * 1000 || transferClaim.concurrentTransferAllowed !== false ||
    new Set(transferLifecycle.presentations).size !== 3 || transferLifecycle.presentations.length !== 3 ||
    !transferLifecycle.presentations.includes("permanent_hub_qr_with_live_lan_challenge"))
  throw new Error("Transfer must remain one non-expiring claim across its three mutually invalidating presentations");
const transferCases = new Map(transferLifecycle.cases.map((scenario) => [scenario.id, scenario]));
const tenantSuccessor = transferCases.get("active-tenant-successor");
const managerCancel = transferCases.get("manager-cancel");
const ownerCancel = transferCases.get("owner-cancel");
const staffReplace = transferCases.get("verified-staff-replace");
const consume = transferCases.get("consume-one-presentation");
const alternateReplay = transferCases.get("retry-other-presentation");
if (!tenantSuccessor || tenantSuccessor.expected !== "ACTIVE_TENANT_SUCCESSOR_DENIED" || tenantSuccessor.mutation !== false ||
    !managerCancel || managerCancel.expected !== "SCOPE_DENIED" || managerCancel.mutation !== false ||
    !ownerCancel || ownerCancel.expected !== "CANCELLED" || ownerCancel.mutation !== true ||
    !staffReplace || staffReplace.actorMembershipId !== "employee:senior-ops" || staffReplace.verifiedStaff !== true || staffReplace.expected !== "REPLACED" ||
    !consume || consume.expected !== "TRANSFERRED" || consume.mutation !== true ||
    !alternateReplay || alternateReplay.after !== consume.id || alternateReplay.expected !== "CLAIM_ALREADY_CONSUMED" || alternateReplay.mutation !== false)
  throw new Error("Transfer lifecycle must enforce active-tenant, owner/staff authority, one presentation consumption and replay denial");
const transferCompletion = transferLifecycle.completion;
if (transferCompletion.formerOwnerRemoved !== true || transferCompletion.allPreExistingManagersRemoved !== true ||
    transferCompletion.activeTenantMembershipIdsPreserved.length < 1 || transferCompletion.canonicalAreaIdsPreserved.length < 1 ||
    transferCompletion.permanentDeviceIdsPreserved.length < 1 || transferCompletion.inProgressPermanentInstallationRequestPreserved !== true ||
    transferCompletion.pendingTenantAndManagerInvitationsCancelled !== true || transferCompletion.pendingRoomQrRequestsCancelled !== true ||
    transferCompletion.pendingAndActivePropertySupportRevoked !== true || transferCompletion.proposedSuccessorNotifiedBeforeCompletion !== false ||
    transferCompletion.outgoingOwnerAndRemovedManagersNotified !== true || transferCompletion.historyRewritten !== false)
  throw new Error("Transfer completion failed its household-preservation, grant-removal or notification privacy contract");
const notificationLifecycle = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "notification-lifecycle.json"), "utf8"));
if (notificationLifecycle.schemaVersion !== contract.contractVersion || notificationLifecycle.defaults.quietHoursEnabled !== false ||
    notificationLifecycle.defaults.mandatoryEventsDisableable !== false ||
    JSON.stringify(notificationLifecycle.roleCatalogues.owner) !== JSON.stringify(["hub_availability", "permanent_device_outages", "new_permanent_devices", "tenant_access_requests", "installation_updates", "automation_activity"]) ||
    JSON.stringify(notificationLifecycle.roleCatalogues.propertyManager) !== JSON.stringify(notificationLifecycle.roleCatalogues.owner) ||
    JSON.stringify(notificationLifecycle.roleCatalogues.tenant) !== JSON.stringify(["hub_availability", "permanent_device_outages_in_authorized_areas", "own_tenant_device_outages", "new_permanent_devices_in_authorized_areas", "automation_failure_or_skipped_run", "access_request_decisions"]) ||
    notificationLifecycle.propertyManagerPreferenceAuthority !== "original_homeowner_final_selection")
  throw new Error("Notification preference defaults or role-specific catalogue differ from the frozen contract");
for (const scenario of notificationLifecycle.cases) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(scenario.localTime) || typeof scenario.enabled !== "boolean" ||
      typeof scenario.quietHoursEnabled !== "boolean" || typeof scenario.mandatory !== "boolean")
    throw new Error(`Notification case lacks a well-formed local time or explicit preference state: ${scenario.id}`);
  const expected = scenario.mandatory ? "delivered-immediately"
    : !scenario.enabled ? "not-sent"
      : scenario.quietHoursEnabled && scenario.localTime < "07:00" ? "deferred-individually-until-quiet-hours-end"
        : "delivered-once";
  if (scenario.expected !== expected) throw new Error(`Notification quiet-hours or mandatory-family transition mismatch: ${scenario.id}`);
}
const privateNotificationAudience = notificationLifecycle.audienceCases.find(({ id }) => id === "private-tenant-device");
const infrastructureNotificationAudience = notificationLifecycle.audienceCases.find(({ id }) => id === "property-infrastructure");
if (!privateNotificationAudience || JSON.stringify(privateNotificationAudience.candidates.filter((candidate) => candidate === privateNotificationAudience.currentMembershipId)) !== JSON.stringify(privateNotificationAudience.expectedRecipients) ||
    privateNotificationAudience.privateDetailsInOwnerNotice !== false || !infrastructureNotificationAudience ||
    JSON.stringify(infrastructureNotificationAudience.expectedGenericRecipients) !== JSON.stringify([...decisionMatrix.identity.activeOwnerMembershipIds, ...decisionMatrix.identity.activeManagerMembershipIds]) ||
    infrastructureNotificationAudience.tenantPrivateDetailsIncluded !== false)
  throw new Error("Notification audience leaks a private tenant ticket or omits generic property-infrastructure recipients");
const notificationDedupe = notificationLifecycle.deduplication;
const deliveries = notificationDedupe.sameEventRecipientChannelDeliveries;
const deliveryIds = deliveries.map((delivery) => delivery.deliveryId);
const deliveryKeys = new Set(deliveries.map((delivery) => notificationDedupe.keyFields.map((field) => delivery[field]).join("|")));
const duplicateAttemptCount = deliveries.length - deliveryKeys.size;
if (JSON.stringify(notificationDedupe.keyFields) !== JSON.stringify(["eventId", "recipientId", "channel"]) ||
    deliveries.some((delivery) => typeof delivery.deliveryId !== "string" || delivery.deliveryId.length === 0 || notificationDedupe.keyFields.some((field) => typeof delivery[field] !== "string" || delivery[field].length === 0) || !notificationDedupe.channels.includes(delivery.channel)) ||
    new Set(deliveryIds).size !== deliveryIds.length || notificationDedupe.expectedDeliveryCount !== deliveryKeys.size ||
    notificationDedupe.expectedRetrySuppressionCount !== duplicateAttemptCount ||
    notificationDedupe.receiptCreatesAuthority !== false || notificationDedupe.receiptCreatesMembership !== false ||
    JSON.stringify(notificationDedupe.channels) !== JSON.stringify(["push", "verified_email"]))
  throw new Error("Notification retry must deduplicate per event/recipient/channel and a receipt must grant no authority");
const accountRelationshipLifecycle = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "account-relationship-lifecycle.json"), "utf8"));
const retainedRelationshipKinds = new Set(accountRelationshipLifecycle.retainedRelationshipKinds);
const nonRetainingKinds = new Set(accountRelationshipLifecycle.nonRetainingKinds);
const accountRelationshipDecisionRegister = JSON.parse(fs.readFileSync(path.join(root, "contracts/dinodia-v1/decisions.json"), "utf8"));
if (accountRelationshipLifecycle.schemaVersion !== contract.contractVersion ||
    JSON.stringify(accountRelationshipLifecycle.retainedRelationshipKinds) !== JSON.stringify(accountRelationshipDecisionRegister.identityLifecycle.accountRetainingRelationshipKinds) ||
    JSON.stringify(accountRelationshipLifecycle.nonRetainingKinds) !== JSON.stringify(accountRelationshipDecisionRegister.identityLifecycle.accountNonRetainingRelationshipKinds) ||
    retainedRelationshipKinds.size !== 4 || nonRetainingKinds.size !== 6 ||
    accountRelationshipLifecycle.tenantSelfRemoval.removesOnlySelectedMembership !== true ||
    accountRelationshipLifecycle.tenantSelfRemoval.preservesOtherHomeMemberships !== true ||
    accountRelationshipLifecycle.tenantSelfRemoval.preservesOtherTrustedInstallations !== true)
  throw new Error("Account relationship lifecycle does not preserve scoped removal and account-global identity decisions");
for (const scenario of accountRelationshipLifecycle.cases) {
  if (scenario.remainingRelationships.some((kind) => !retainedRelationshipKinds.has(kind) && !nonRetainingKinds.has(kind)))
    throw new Error(`Account cleanup scenario uses an unclassified relationship kind: ${scenario.id}`);
  const hasLiveRelationship = scenario.remainingRelationships.some((kind) => retainedRelationshipKinds.has(kind));
  const expected = hasLiveRelationship ? "ACCOUNT_RETAINED" : "ACCOUNT_AND_ACCOUNT_SCOPED_STATE_DELETED";
  if (scenario.expected !== expected) throw new Error(`Final-valid-relationship deletion rule failed: ${scenario.id}`);
}
const accountCleanup = accountRelationshipLifecycle.finalCleanup;
if (accountCleanup.deleteSessions !== true || accountCleanup.deleteTrustedDeviceCredentials !== true ||
    accountCleanup.deleteAccountScopedCachesAndPreferences !== true || accountCleanup.closeBoundOpenSupportTickets !== true ||
    accountCleanup.retainOnlyRedactedReceiptMonths !== 12 || accountCleanup.supportTicketKeepsAccountAlive !== false ||
    accountCleanup.freshReentryRequiresRegistrationAndEmailVerification !== true || accountCleanup.reuseDeletedIdentityWithoutRegistration !== false)
  throw new Error("Final account cleanup/re-entry differs from frozen relationship, ticket retention or identity policy");

const roomQrLifecycle = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "room-qr-lifecycle.json"), "utf8"));
if (roomQrLifecycle.schemaVersion !== contract.contractVersion || roomQrLifecycle.credential.onePerCanonicalOriginalArea !== true ||
    roomQrLifecycle.credential.emptyAreaAllowed !== true || roomQrLifecycle.credential.lifetime !== "until_disabled_or_replaced" ||
    roomQrLifecycle.credential.replacementInvalidatesOldPresentation !== true || roomQrLifecycle.credential.replacementChangesExistingGrants !== false ||
    roomQrLifecycle.request.emailVerificationRequiredBeforeOwnerVisibility !== true || roomQrLifecycle.request.lifetimeSeconds !== 7 * 24 * 60 * 60 ||
    roomQrLifecycle.request.latestValidPendingRequestWins !== true || roomQrLifecycle.request.grantIsExactlyRequestedCanonicalArea !== true ||
    roomQrLifecycle.request.rejectionCooldownSeconds !== 0 || roomQrLifecycle.request.ownerlessQrRequestPersists !== false ||
    roomQrLifecycle.request.retiredAreaQrEnabled !== false)
  throw new Error("Room QR credential, request visibility, grant scope or expiry differs from the frozen contract");
for (const scenario of roomQrLifecycle.cases) {
  let expected;
  if (scenario.areaLifecycle === "retired") expected = "AREA_NOT_AVAILABLE";
  else if (scenario.activeOwnerExists === false) expected = "NO_DURABLE_REQUEST";
  else if (scenario.elapsedSeconds === roomQrLifecycle.request.lifetimeSeconds) expected = "REQUEST_EXPIRED";
  else if (scenario.previousState === "REJECTED" && scenario.elapsedSeconds === 0) expected = "NEW_REQUEST_ALLOWED";
  else if (!scenario.emailVerified) expected = "WAITING_FOR_EMAIL_VERIFICATION";
  else if (scenario.approved === true) expected = "MEMBERSHIP_ACTIVE";
  else expected = "PENDING_OWNER_DECISION";
  if (scenario.expected !== expected || (scenario.membershipCreated === true && expected !== "MEMBERSHIP_ACTIVE") ||
      (typeof scenario.membershipCreated === "boolean" && scenario.membershipCreated !== (expected === "MEMBERSHIP_ACTIVE")) ||
      (expected === "NO_DURABLE_REQUEST" && scenario.persistedRequest !== false) ||
      (expected === "WAITING_FOR_EMAIL_VERIFICATION" && scenario.ownerVisible !== false) ||
      (scenario.grantedAreaIds && scenario.grantedAreaIds.some((id) => id !== scenario.requestedAreaId)))
    throw new Error(`Room QR lifecycle, request visibility, exact-area grant or terminal rejection mismatch: ${scenario.id}`);
}

const decisionAreas = duplicateAreas.areas.map((area) => ({ ...area, homeId: duplicateAreas.homeId }));
if (!decisionAreas.every((area) => osContractRuntime.validateArea(area, duplicateAreas.homeId)) ||
    new Set(decisionAreas.map((area) => area.id)).size !== decisionAreas.length ||
    new Set(decisionAreas.map((area) => area.overrideName.trim().toLowerCase())).size !== 1)
  throw new Error("Same-name areas must decode as distinct canonical IDs under the OS runtime");
const tenantOwnerContext = { ...invalidTenant.context, homeMembershipId: invalidTenant.device.ownerMembershipId, role: "TENANT", areaIds: invalidTenant.device.areaIds };
if (!osContractRuntime.validateDevice(invalidTenant.device, tenantOwnerContext))
  throw new Error("The exact owning tenant membership must decode its private device");
for (const deniedContext of [
  { ...tenantOwnerContext, role: "OWNER" },
  { ...tenantOwnerContext, role: "PROPERTY_MANAGER" },
  { ...tenantOwnerContext, homeMembershipId: "membership:tenant-other" },
  { ...tenantOwnerContext, areaIds: [] },
  { ...tenantOwnerContext, homeMembershipId: "membership:tenant-other", areaIds: ["area:private"] },
]) if (osContractRuntime.validateDevice(invalidTenant.device, deniedContext))
  throw new Error("OS runtime exposed a tenant-private device to a non-owner, wrong role or ungranted area");
const labelMutation = { ...invalidTenant.device, customerLabel: "Owner bedroom" };
if (osContractRuntime.validateDevice(labelMutation, { ...tenantOwnerContext, homeMembershipId: "membership:tenant-other" }))
  throw new Error("Changing a presentation label must not grant tenant-device authority");
const privateTicket = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "support-ticket-private.json"), "utf8"));
const claimReservation = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "claim-first-wins.json"), "utf8"));
const mandatoryNotification = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "notification-security-mandatory.json"), "utf8"));
if (!definitionValidator("supportTicket")(privateTicket) || !definitionValidator("claimReservation")(claimReservation) ||
    Date.parse(claimReservation.expiresAt) - Date.parse(claimReservation.createdAt) !== 1800_000 ||
    !definitionValidator("notification")(mandatoryNotification) || mandatoryNotification.kind !== "security" || mandatoryNotification.mandatory !== true)
  throw new Error("Support, exact claim-reservation duration or mandatory-security notification fixture is invalid");
const privateSupportScenario = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "support-private-notification.json"), "utf8"));
if (!definitionValidator("supportTicket")(privateTicket) || privateSupportScenario.ticket.homeMembershipId !== privateTicket.homeMembershipId ||
    JSON.stringify(privateSupportScenario.recipientCandidates.filter((recipient) => recipient === privateSupportScenario.ticket.homeMembershipId)) !== JSON.stringify(privateSupportScenario.expectedPrivateRecipients) ||
    privateSupportScenario.expectedPrivateRecipients.includes("membership:owner-a"))
  throw new Error("Executable private-support recipient projection disclosed a tenant-device ticket to its owner");
const supportLifecycle = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "support-lifecycle.json"), "utf8"));
const canonicalSupportCategories = contract.$defs.supportTicket.properties.category.enum;
if (JSON.stringify(supportLifecycle.categories) !== JSON.stringify(canonicalSupportCategories))
  throw new Error("Support lifecycle must exercise the complete canonical seven-category enum in order");
const privateSupport = supportLifecycle.privateTenantOnly;
const privateRecipients = privateSupport.recipientCandidates.filter((recipient) => recipient === privateSupport.ticketMembershipId);
if (privateSupport.scope !== "tenant_device_only" || privateSupport.homeId !== "home:tenant-property" ||
    privateSupport.ticketId !== "ticket:tenant-private" ||
    privateSupport.ticketMembershipId !== "membership:tenant-property" || JSON.stringify(privateRecipients) !== JSON.stringify(privateSupport.expectedRecipients) ||
    privateSupport.ownerNotice !== false || privateSupport.tenantPrivateDetailsInOwnerNotice !== false)
  throw new Error("Tenant-private-only support must project solely to its owning tenant without an owner side channel");
const infrastructureSupport = supportLifecycle.propertyInfrastructure;
const genericInfrastructureRecipients = infrastructureSupport.recipientCandidates.filter((recipient) => recipient !== supportLifecycle.privateTenantOnly.ticketMembershipId);
const expectedInfrastructureRecipients = [...decisionMatrix.identity.activeOwnerMembershipIds, ...decisionMatrix.identity.activeManagerMembershipIds];
if (infrastructureSupport.homeId !== decisionMatrix.property.homeId ||
    JSON.stringify(infrastructureSupport.expectedGenericLifecycleRecipients) !== JSON.stringify(expectedInfrastructureRecipients) ||
    !infrastructureSupport.recipientCandidates.includes("membership:tenant-property") ||
    infrastructureSupport.touchesPropertyInfrastructure !== true ||
    JSON.stringify(genericInfrastructureRecipients) !== JSON.stringify(infrastructureSupport.expectedGenericLifecycleRecipients) ||
    infrastructureSupport.noticeContainsTenantPrivateDeviceId !== false || infrastructureSupport.noticeContainsTenantPrivateTicketText !== false)
  throw new Error("Property-support lifecycle must notify authorized property recipients generically without private tenant detail");
const approval = supportLifecycle.approval;
const issuedAt = Date.parse(approval.codeIssuedAt);
const expiresAt = Date.parse(approval.codeExpiresAt);
const approvedAt = Date.parse(approval.approvedAt);
const sessionExpiresAt = Date.parse(approval.sessionExpiresAt);
if (expiresAt - issuedAt !== approval.codeLifetimeSeconds * 1000 || approval.codeLifetimeSeconds !== 600 ||
    approvedAt >= expiresAt || sessionExpiresAt - approvedAt !== approval.maxSessionSeconds * 1000 || approval.maxSessionSeconds !== 1800 ||
    approval.proofMustBeDerivedFromStoredHash !== false || approval.oneUseCodeAndProofConsumedAtomically !== true ||
    JSON.stringify(approval.proofBoundFields) !== JSON.stringify(["employeeId", "ticketId", "requestId", "homeId", "hubInstallationId", "identityGeneration", "nonce", "codeExpiresAt", "bodyDigest"]) ||
    ["wrongEmployeeDenied", "wrongTicketDenied", "wrongHomeDenied", "wrongHubDenied", "wrongGenerationDenied", "replayDenied"].some((key) => approval[key] !== true))
  throw new Error("Support one-use code/proof must bind the exact request context, expire at ten minutes and cap the approved lease at thirty minutes");
for (const boundary of supportLifecycle.approvalBoundaryCases) {
  const at = Date.parse(boundary.at);
  const expected = at < expiresAt ? "eligible-for-customer-approval" : "SUPPORT_CODE_EXPIRED";
  if (boundary.expected !== expected) throw new Error(`Support code exact-expiry boundary mismatch: ${boundary.id}`);
}
if (supportLifecycle.safetyAction.firstApproverMembershipId !== "membership:tenant-property" ||
    supportLifecycle.safetyAction.firstApproverMembershipId !== supportLifecycle.safetyAction.secondConfirmationMembershipId ||
    supportLifecycle.safetyAction.differentApproverDenied !== true || supportLifecycle.safetyAction.sameApproverRequired !== true ||
    supportLifecycle.safetyAction.missingSecondConfirmationDenied !== true)
  throw new Error("Safety-sensitive support work requires a second confirmation from the same approving membership");
const supportClosure = supportLifecycle.closure;
if (supportClosure.ticketState !== "CLOSED" || supportClosure.cloudAuthorityRevokedImmediately !== true ||
    supportClosure.hubAcknowledgement !== "pending" || supportClosure.pendingHubAcknowledgementPermitsRenewal !== false ||
    supportClosure.closedTimelineRetentionMonths !== 12 || supportClosure.ticketPreservesOtherwiseRelationshipFreeAccount !== false)
  throw new Error("Customer close must revoke cloud authority immediately, remain closed while hub ack is pending, and not retain an otherwise relationship-free account");
const deliveryReceiptScenario = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "notification-delivery-is-not-authority.json"), "utf8"));
const createsMembership = (invitation) => invitation.state === "accepted" && typeof invitation.membershipId === "string" && invitation.membershipId.length > 0;
if (deliveryReceiptScenario.receipt.deliveryState !== "sent" || createsMembership(deliveryReceiptScenario.invitation))
  throw new Error("Notification delivery receipt must not create membership or access authority");
const offlineWidening = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "offline-scope-widening.json"), "utf8"));
const offlineScopeAllowed = (grant, requested) => grant.accountId === requested.accountId && grant.homeId === requested.homeId &&
  grant.homeMembershipId === requested.homeMembershipId && grant.trustedDeviceId === requested.trustedDeviceId &&
  requested.areaIds.every((areaId) => grant.areaIds.includes(areaId));
if (offlineScopeAllowed(offlineWidening.grant, offlineWidening.requested))
  throw new Error("Offline authority adapter accepted a widened area scope");
for (const [pointer, expected] of [
  ["support.privateTenantDeviceTicketNotifiesOwner", false],
  ["notification.deliveryReceiptGrantsAuthority", false],
  ["offline.scopeCanWiden", false],
]) {
  const actual = pointer.split(".").reduce((value, key) => value?.[key], decisionMatrix);
  if (actual !== expected) throw new Error(`Contradictory executable decision fixture: ${pointer}`);
}
const matrixStepUpControl = valid.device.controls.find((control) => control.semanticRole === "security_lock");
const matrixStepUpCommandFixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "command-valid.json"), "utf8"));
const matrixStepUpCommand = { ...matrixStepUpCommandFixture, controlId: matrixStepUpControl?.controlId, descriptorRevision: valid.device.descriptorRevision, value: false };
delete matrixStepUpCommand.stepUpOperationId;
if (!matrixStepUpControl || osContractRuntime.validateCommand(matrixStepUpCommand, valid.device, matrixStepUpControl, matrixStepUpCommandFixture.homeMembershipId) ||
    !osContractRuntime.validateCommand({ ...matrixStepUpCommand, stepUpOperationId: "operation:fixture-bound" }, valid.device, matrixStepUpControl, matrixStepUpCommandFixture.homeMembershipId))
  throw new Error("OS runtime must reject app-only security control commands without exact step-up and accept the bound proof reference");
const mixedChannels = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "multi-channel-mixed-controls.json"), "utf8"));
if (!mixedChannels.channels.length || mixedChannels.channels.some((channel) => channel.deviceId !== mixedChannels.channels[0].deviceId || channel.controls.some((control) => !["boolean", "number", "option", "text", "invoke"].includes(control.valueType) || !["power", "brightness", "active_heat_demand", "active_heat_production", "target_temperature", "ambient_temperature", "opening_percentage", "connectivity", "security_lock", "lock_state", "operating_mode", "position", "volume", "color", "state", "unknown"].includes(control.semanticRole))))
  throw new Error("Mixed-channel controls must retain one device identity and known canonical semantic/value types");
const analyticsSemantics = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "analytics-semantics.json"), "utf8"));
const analyticsNow = Date.parse(analyticsSemantics.now);
if (analyticsSemantics.schemaVersion !== contract.contractVersion || analyticsSemantics.activityCases.length < 10)
  throw new Error("Analytics semantic fixture must cover canonical dinodia.v1 activity boundaries");
for (const item of analyticsSemantics.activityCases) {
  const actual = osAnalyticsRuntime.classifyActivityV1(item, analyticsNow);
  if (actual !== item.expected) throw new Error(`Analytics activity semantic mismatch: ${item.id}`);
}
const aggregation = analyticsSemantics.aggregation;
for (const key of ["periodSamples", "periodExpected", "hourSamples", "hourExpected", "displayedBuckets"])
  if (!Array.isArray(aggregation[key])) throw new Error(`Analytics fixture is missing ${key}`);
if (!aggregation.summaryExpected || typeof aggregation.summaryExpected !== "object" || Array.isArray(aggregation.summaryExpected))
  throw new Error("Analytics fixture is missing summaryExpected");
if (JSON.stringify(osAnalyticsRuntime.averageContributingSamplesV1(aggregation.periodSamples)) !== JSON.stringify(aggregation.periodExpected))
  throw new Error("OS period analytics differs from the canonical contributing-sample fixture");
if (JSON.stringify(osAnalyticsRuntime.sumSelectedDevicesPerHourV1(aggregation.hourSamples)) !== JSON.stringify(aggregation.hourExpected))
  throw new Error("OS hourly analytics differs from the canonical selected-device fixture");
if (JSON.stringify(osAnalyticsRuntime.averageDisplayedBucketsV1(aggregation.displayedBuckets)) !== JSON.stringify(aggregation.summaryExpected))
  throw new Error("OS analytics summary differs from the canonical displayed-bucket fixture");
for (const [periodName, buckets] of Object.entries(aggregation.periodFilterBuckets ?? {})) {
  const selected = aggregation.periodSamples.filter((sample) => buckets.includes(sample.bucket));
  const actual = osAnalyticsRuntime.averageContributingSamplesV1(selected);
  if (JSON.stringify(actual) !== JSON.stringify(aggregation.periodSelectionExpected?.[periodName]))
    throw new Error(`Analytics filter/drilldown expectation differs for ${periodName}`);
}
const invalidAnalyticsSample = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "invalid/analytics-invalid-sample.json"), "utf8"));
if (invalidAnalyticsSample.schemaVersion !== contract.contractVersion || invalidAnalyticsSample.expected !== "reject")
  throw new Error("Invalid analytics sample must be a negative semantic fixture");
let invalidAnalyticsRejected = false;
try { osAnalyticsRuntime.averageContributingSamplesV1([invalidAnalyticsSample.sample]); }
catch (error) { invalidAnalyticsRejected = error instanceof TypeError; }
if (!invalidAnalyticsRejected) throw new Error("OS analytics runtime did not reject the invalid semantic sample");
const wrongHome = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "invalid/wrong-home-envelope.json"), "utf8"));
const wrongHomeEnvelope = definitionValidator("envelope");
if (!wrongHomeEnvelope(wrongHome))
  throw new Error("Wrong-home envelope must remain structurally valid and be rejected by selected-home authorization");
if (osContractRuntime.validateEnvelope(wrongHome, "home:opaque-a"))
  throw new Error("OS selected-home envelope validator accepted the wrong-home semantic fixture");
const privateTenantDevice = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "invalid/tenant-device-wrong-owner.json"), "utf8"));
if (osContractRuntime.validateDevice(privateTenantDevice.device, { ...privateTenantDevice.context, role: "TENANT", areaIds: privateTenantDevice.device.areaIds }))
  throw new Error("OS runtime accepted another tenant's private device fixture");
const commandFixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "command-valid.json"), "utf8"));
const canonicalDevice = valid.device;
const commandControl = canonicalDevice.controls.find((control) => control.controlId === commandFixture.controlId);
if (!commandControl || !osContractRuntime.validateCommand(commandFixture, canonicalDevice, commandControl, commandFixture.homeMembershipId))
  throw new Error("OS runtime rejected the canonical valid command fixture");
const staleCommandFixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "invalid/stale-descriptor-command.json"), "utf8"));
if (osContractRuntime.validateCommand({ ...commandFixture, descriptorRevision: staleCommandFixture.command.descriptorRevision }, canonicalDevice, commandControl, commandFixture.homeMembershipId))
  throw new Error("OS runtime accepted the stale descriptor command fixture");
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
const claimLifecycle = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "claim-lifecycle.json"), "utf8"));
if (!assertStage2DecisionFixtures({
  support: privateSupportScenario,
  receipt: deliveryReceiptScenario,
  offline: offlineWidening,
  decisionMatrix,
  claim: claimLifecycle,
  accountRelationshipLifecycle,
})) throw new Error("Stage 2 decision fixtures were not behaviorally evaluated");
const claimState = structuredClone(claimLifecycle.initial);
const appliedClaimMutations = new Set();
if (!claimState.emailVerified || claimLifecycle.competingClaim.winnerRemains !== claimState.claimantAccountId || claimLifecycle.competingClaim.expectedOutcome !== "non_identifying_unavailable")
  throw new Error("Claim reservation must be won by the first verified claimant and hide competing claimant identity");
for (const event of claimLifecycle.events) {
  const at = Date.parse(event.at);
  const expires = Date.parse(claimState.expiresAt);
  if (!Number.isFinite(at) || !Number.isFinite(expires)) throw new Error("Claim lifecycle fixture contains an invalid timestamp");
  if (claimState.state === "reserved" && at >= expires) claimState.state = "expired";
  if (claimState.state === "reserved" && event.kind === "required_save" && event.success === true && event.changed === true) {
    if (appliedClaimMutations.has(event.idempotencyKey)) {
      // Exact retries return the durable result; they never move the deadline again.
    } else {
      appliedClaimMutations.add(event.idempotencyKey);
      claimState.expiresAt = new Date(at + 1800_000).toISOString();
      claimState.revision += 1;
    }
  }
  if (event.expectedState && claimState.state !== event.expectedState || event.expectedExpiresAt && Date.parse(claimState.expiresAt) !== Date.parse(event.expectedExpiresAt) || event.expectedRevision !== undefined && claimState.revision !== event.expectedRevision)
    throw new Error(`Claim lifecycle transition mismatch at ${event.eventId}`);
}
for (const cleanup of claimLifecycle.cleanupCases) {
  const relationshipCount = Object.values(cleanup.relationships).reduce((sum, count) => sum + count, 0);
  const result = relationshipCount > 0
    ? { account: "retained", sessionsRevoked: false, trustedDevicesRevoked: false }
    : { account: "deleted", sessionsRevoked: true, trustedDevicesRevoked: true };
  if (JSON.stringify(result) !== JSON.stringify(cleanup.expected)) throw new Error("Claim expiry must use the universal final-relationship account cleanup rule");
}
const membershipFixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "multi-home-memberships.json"), "utf8"));
if (membershipFixture.memberships.length < 2 || new Set(membershipFixture.memberships.map((m) => m.homeId)).size !== membershipFixture.memberships.length || new Set(membershipFixture.memberships.map((m) => m.homeMembershipId)).size !== membershipFixture.memberships.length)
  throw new Error("Multi-home membership fixture does not prove distinct per-home authority");
const joinedSession = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "account-session-two-homes.json"), "utf8"));
for (const fixtureName of ["selected-tenant-property-device.json", "selected-tenant-private-device.json"]) {
  const joined = JSON.parse(fs.readFileSync(path.join(fixtureRoot, fixtureName), "utf8"));
  const context = joined.context;
  const membership = joinedSession.memberships.find((candidate) => candidate.homeMembershipId === context.homeMembershipId);
  if (!membership || membership.accountId !== context.accountId || membership.homeId !== context.homeId || membership.role !== context.role || membership.status !== "active" || membership.homeId !== joined.device.homeId || !joined.device.areaIds.every((areaId) => membership.areaIds.includes(areaId)))
    throw new Error(`Prototype device fixture is not joined to its active account/home/area membership: ${fixtureName}`);
  if (!platformContractRuntime.validateNativeDevice(joined.device, { homeId: context.homeId, homeMembershipId: context.homeMembershipId, role: context.role, areaIds: context.areaIds }) ||
      !osContractRuntime.validateDevice(joined.device, { homeId: context.homeId, homeMembershipId: context.homeMembershipId, role: context.role, areaIds: context.areaIds }))
    throw new Error(`Joined tenant prototype fixture must decode in Platform and OS: ${fixtureName}`);
  if (joined.device.managementClass === "tenant_device") {
    if (!platformContractRuntime.validateNativeDevice(joined.device, { homeId: context.homeId, homeMembershipId: context.homeMembershipId, role: "TENANT", areaIds: context.areaIds }) ||
        osContractRuntime.validateDevice(joined.device, { homeId: context.homeId, homeMembershipId: "membership:tenant-other", role: "TENANT", areaIds: context.areaIds }) ||
        osContractRuntime.validateDevice(joined.device, { homeId: context.homeId, homeMembershipId: context.homeMembershipId, role: "OWNER", areaIds: context.areaIds }))
      throw new Error("Joined tenant-private fixture must allow only its owning tenant membership");
  }
}
for (const [schemaName, filename, select] of [
  ["envelope", "empty-area.json", (fixture) => fixture],
  ["controlState", "stale-and-unavailable-control-state.json", (fixture) => fixture.data],
  ["device", "unknown-interaction-kind.json", (fixture) => fixture.device],
  ["envelope", "invalid/unknown-required-version.json", (fixture) => fixture],
]) {
  const example = JSON.parse(fs.readFileSync(path.join(fixtureRoot, filename), "utf8"));
  const validator = definitionValidator(schemaName);
  const expected = filename.includes("unknown-required-version") ? false : true;
  if (Boolean(validator?.(select(example))) !== expected)
    throw new Error(`Fixture ${filename} disagrees with ${schemaName} validity`);
}
const api = fs.readFileSync(
  path.join(root, "src/lib/contracts/dinodiaV1.ts"),
  "utf8",
);
const validatorNames = [
  "validateCustomerSessionLoginRequest",
  "validateCustomerSessionLogoutReceipt",
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
  "effectiveHubOnlineState",
  "validateLanEndpointObservation",
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
const customerLoginRoute = fs.readFileSync(path.join(root, "src/app/api/v2/auth/session/route.ts"), "utf8");
if (!customerLoginRoute.includes("validateCustomerSessionLoginRequest(body)"))
  throw new Error("The actual customer login route must validate its canonical request DTO before processing credentials");
const osRoot = path.resolve(root, "../Dinodia OS");
const osServer = fs.readFileSync(path.join(osRoot, "src/server.js"), "utf8");
if (!osServer.includes('require("./contracts/dinodiaV1")') || !osServer.includes("serializeNativeDevice") || !osServer.includes('pathname === "/api/dinodia/v1/commands"'))
  throw new Error("Dinodia OS native HTTP serializer/command route is not connected to the canonical validator");
const iosRoot = path.resolve(root, "../dinodia-ios-app-V2");
const iosMapping = fs.readFileSync(path.join(iosRoot, "Dinodia/LiveContracts/DinodiaV1Mapping.swift"), "utf8");
const iosComposition = fs.readFileSync(path.join(iosRoot, "Dinodia/ContentView.swift"), "utf8");
const iosSessionShell = fs.readFileSync(path.join(iosRoot, "Dinodia/LiveContracts/DinodiaV1SessionShell.swift"), "utf8");
const iosProject = fs.readFileSync(path.join(iosRoot, "Dinodia.xcodeproj/project.pbxproj"), "utf8");
if (!iosMapping.includes("decodeDeviceMetadata") || !iosMapping.includes("decodeOfflineHomeSelection") || !iosMapping.includes("decodeCanonicalError") || !iosMapping.includes("decodeCustomerSessionLogoutReceipt") || !iosMapping.includes("DinodiaV1ErrorCode") || !iosMapping.includes("validate(_ command: DinodiaV1Command") || !iosSessionShell.includes("activateAfterExactHomeChallenge") || !iosSessionShell.includes("decodeCustomerSessionLogoutReceipt") || !iosComposition.includes("DinodiaV1ProductionRootView()") || !iosComposition.includes("Stage2ContractUnavailableView()") || !iosComposition.includes("#if DEBUG") || !iosComposition.includes("StaticPreviewApplicationRoot()"))
  throw new Error("iOS must expose the canonical metadata/command adapter and keep static composition behind a debug-only preview gate");
if (iosProject.includes("DebugFixtures in Resources") || !iosProject.includes('if [ \\"$CONFIGURATION\\" = \\"Debug\\" ]') || !iosProject.includes("Copy Stage 2 fixtures in Debug builds only") || !iosProject.includes('ditto \\"$SRCROOT/Dinodia/DebugFixtures\\"'))
  throw new Error("Synthetic Stage 2 prototype fixtures must be copied into the app bundle only by the Debug-only build phase");
const prototypeSource = fs.readFileSync(path.join(iosRoot, "Dinodia/LiveContracts/Stage2ContractPrototypeView.swift"), "utf8");
const fixtureSyncSource = fs.readFileSync(path.join(root, "scripts/sync_dinodia_contract_fixtures.mjs"), "utf8");
const fixtureCopyBlock = fixtureSyncSource.match(/const iosPrototypeFixtures[\s\S]*?for \(const fixture of \[([\s\S]*?)\]\)/);
if (!fixtureCopyBlock) throw new Error("The DEBUG-only prototype fixture-copy inventory could not be resolved");
const copiedPrototypeFixtures = new Set([...fixtureCopyBlock[1].matchAll(/'([^']+\.json)'/g)].map((match) => path.basename(match[1], ".json")));
const prototypeFixtureReferences = new Set([...prototypeSource.matchAll(/Stage2PrototypeFixtures\.object\(\"([^\"]+)\"\)/g)].map((match) => match[1]));
for (const fixtureName of prototypeFixtureReferences) {
  const canonicalPath = path.join(fixtureRoot, `${fixtureName}.json`);
  const debugPath = path.join(iosRoot, "Dinodia/DebugFixtures/DinodiaV1/fixtures", `${fixtureName}.json`);
  if (!copiedPrototypeFixtures.has(fixtureName) || !fs.existsSync(canonicalPath) || !fs.existsSync(debugPath))
    throw new Error(`DEBUG prototype fixture is missing from canonical source or synchronization inventory: ${fixtureName}`);
}
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
const hubFreshness = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "hub-heartbeat-freshness.json"), "utf8"));
const hubFreshnessNow = Date.parse(hubFreshness.now);
if (hubFreshness.schemaVersion !== contract.contractVersion ||
    hubFreshness.heartbeatCadenceSeconds !== decisions.limits.heartbeatSeconds ||
    hubFreshness.onlineThroughSeconds !== decisions.limits.hubOnlineSeconds ||
    hubFreshness.cases.length < 8 ||
    hubFreshness.cases.some((scenario) => platformContractRuntime.effectiveHubOnlineState(scenario.lastHeartbeatAt, hubFreshnessNow) !== scenario.expected))
  throw new Error("Heartbeat cadence, inclusive 420-second online boundary or conservative invalid-time behavior diverged from the executable fixture");
const indexedNotificationLifecycle = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "notification-lifecycle.json"), "utf8"));
if (decisions.notifications?.deduplicateByEventRecipientAndChannel !== true ||
    JSON.stringify(decisions.notifications?.deduplicationKeyFields) !== JSON.stringify(indexedNotificationLifecycle.deduplication.keyFields) ||
    decisions.notifications?.quietHoursDefaultEnabled !== indexedNotificationLifecycle.defaults.quietHoursEnabled ||
    decisions.notifications?.mandatorySecurityEventsIgnoreQuietHours !== true ||
    decisions.notifications?.deliveryChannels?.join("|") !== indexedNotificationLifecycle.deduplication.channels.join("|"))
  throw new Error("Notification fixture, frozen decision register and delivery-channel idempotency semantics disagree");
const requiredDecisions = [
  ["identityLifecycle.activeOwnerMaximumPerHome", 1],
  ["identityAndLifecycle.finalRelationshipDeletionCleansAccount", true],
  ["identityLifecycle.accountDeletionRemovesFinalRelationshipOnly", true],
  ["identityLifecycle.accountRetainingRelationshipKinds", ["active_membership", "unexpired_invitation", "valid_pending_access_request", "durable_pending_property_setup"]],
  ["identityLifecycle.accountNonRetainingRelationshipKinds", ["expired_invitation", "rejected_invitation", "cancelled_request", "expired_claim_reservation", "open_support_ticket", "closed_support_ticket"]],
  ["identityLifecycle.invitationCreatesMembership", false],
  ["identityLifecycle.deviceIdentityMergeRequiresProtocolEvidence", true],
  ["homeLifecycle.claimReservationSeconds", 1800],
  ["homeLifecycle.roomQrRetryDays", 7],
  ["retentionAndOperations.anonymousSecurityReceiptMonths", 12],
  ["retentionAndOperations.roomRequestDays", 7],
  ["homeLifecycle.retainedAddressRequiresExplicitConfirmation", true],
  ["homeLifecycle.offlineDeregistrationRemainsPendingUntilAcknowledged", true],
  ["areaAuthority.areaWireNames", ["originalName", "overrideName"]],
  ["controlPolicy.labelAuthority", false],
  ["controlPolicy.customerLabelLengthUnit", "unicode_code_points"],
  ["controlPolicy.customerLabelMaximumCodePoints", 40],
  ["controlPolicy.boundedStringLengthUnit", "unicode_code_points"],
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
  ["automations.propertyImpactProjection.roles", ["OWNER", "PROPERTY_MANAGER"]],
  ["automations.propertyImpactProjection.requiresCurrentSelectedMembership", true],
  ["automations.propertyImpactProjection.includesTenantNameAndSchedule", true],
  ["automations.propertyImpactProjection.includesOnlyAffectedPermanentDevices", true],
  ["automations.propertyImpactProjection.omitsPrivateOnlyAutomations", true],
  ["automations.propertyImpactProjection.omitsTenantDeviceIdsAndPrivateActionValues", true],
  ["automations.propertyImpactProjection.disableDeleteRequireOperationBoundStepUp", true],
  ["automations.propertyImpactProjection.projectionIsReadOnly", true],
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
// `stage2-decision-matrix.json` is review/prototype input only. Its declared
// expected booleans are deliberately not accepted as evidence here: executable
// identity, privacy, command, claim and notification cases above exercise the
// owning validators and adapters instead.
const expectedNativeTasks = [
  { taskId: "operator_credential_lifecycle", owner: "supabase_pg_cron_two_minute" },
  { taskId: "support_expiry_and_revocation", owner: "supabase_pg_cron_two_minute" },
  { taskId: "claim_reservation_expiry", owner: "supabase_pg_cron_two_minute" },
  { taskId: "expired_dispatch_lease_cleanup", owner: "vercel_hobby_daily" },
];
if (JSON.stringify(decisions.sync.nativeTaskRegistry) !== JSON.stringify(expectedNativeTasks))
  throw new Error("Native task registry is incomplete or assigns work to multiple schedule owners");
if (decisions.sync.taskLeaseSeconds !== 180 || decisions.sync.taskFailureIsolation !== true)
  throw new Error("Operational dispatcher must use a 180-second non-overlap lease and isolate independent task failures");
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
const registerHeading = "## Screen, field, action and state register";
const registerStart = matrix.indexOf(registerHeading);
const registerEnd = matrix.indexOf("\n### Fixed native task registry", registerStart + registerHeading.length);
if (registerStart < 0 || registerEnd < 0)
  throw new Error("Static-to-live screen/action register section is missing or unterminated");
const registerText = matrix.slice(registerStart + registerHeading.length, registerEnd);
const splitMarkdownRow = (line) => {
  const cells = [];
  let current = "";
  let inCode = false;
  for (let index = 1; index < line.length - 1; index += 1) {
    const character = line[index];
    if (character === "`") inCode = !inCode;
    if (character === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
    } else current += character;
  }
  cells.push(current.trim());
  return cells;
};
const registerRows = registerText
  .split(/\r?\n/)
  .filter((line) => /^\| `[^`]+` \|/.test(line))
  .map((line) => ({ line, cells: splitMarkdownRow(line) }));
const screenKeys = registerRows.map(({ cells }) => cells[0].replace(/^`|`$/g, ""));
if (new Set(screenKeys).size !== screenKeys.length)
  throw new Error("Static-to-live screen/action register contains duplicate stable keys");
if (registerRows.length < 50)
  throw new Error(`Static-to-live screen/action register is incomplete: ${registerRows.length} rows`);
const fixtureIndex = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "index.json"), "utf8"));
const indexedKeys = Object.keys(fixtureIndex.screenFixtures ?? {}).sort();
if (fixtureIndex.schemaVersion !== contract.contractVersion || JSON.stringify(indexedKeys) !== JSON.stringify([...screenKeys].sort()))
  throw new Error("Fixture index must resolve every and only registered screen/action key");
for (const [screenKey, references] of Object.entries(fixtureIndex.screenFixtures)) {
  if (!Array.isArray(references) || references.length === 0 || new Set(references).size !== references.length)
    throw new Error(`Screen/action has no unique fixture references: ${screenKey}`);
  for (const reference of references) {
    if (typeof reference !== "string" || !reference.startsWith("fixtures/"))
      throw new Error(`Fixture index reference must be an exact fixtures/ path for ${screenKey}: ${String(reference)}`);
    const target = path.join(fixtureRoot, reference.replace(/^fixtures\//, ""));
    if (!target.startsWith(`${fixtureRoot}${path.sep}`) || !fs.existsSync(target) || !target.endsWith(".json"))
      throw new Error(`Unresolved exact fixture reference for ${screenKey}: ${reference}`);
    JSON.parse(fs.readFileSync(target, "utf8"));
  }
}
assertPrototypeActionMatrixBindings(prototypeScenarios, fixtureIndex);
const indexedScenarioResults = [];
const semanticAdapters = {
  os: osContractRuntime,
  platform: platformContractRuntime,
  alexa: alexaContractRuntime,
  schema: (name, value) => definitionValidator(name)(value),
  analytics: osAnalyticsRuntime,
  readFixture: (reference) => {
    if (typeof reference !== "string" || !reference.startsWith("fixtures/")) throw new Error(`Invalid nested fixture reference: ${String(reference)}`);
    const target = path.join(fixtureRoot, reference.slice("fixtures/".length));
    if (!target.startsWith(`${fixtureRoot}${path.sep}`) || !fs.existsSync(target)) throw new Error(`Unresolved nested fixture reference: ${reference}`);
    return JSON.parse(fs.readFileSync(target, "utf8"));
  },
};
const alexaScenarioResults = new Map();
const runAlexaFixture = (relativePath, fixture) => {
  const projectionContext = (device, role = "TENANT", homeMembershipId = "membership:tenant-a") => ({
    homeId: device.homeId,
    homeMembershipId,
    role,
    authorisedAreaIds: [...(device.areaIds || [])],
  });
  const envelope = (devices, context, generatedAt = "2026-09-27T10:00:00Z") => ({
    schemaVersion: "dinodia.v1", homeId: context.homeId, streamId: "contract-check", sequence: 1,
    generatedAt, revision: 1, data: devices,
  });
  const rejectMutatedSourceControl = (mutation, mutate) => {
    const controlId = mutation?.controlId ?? mutation?.mutation?.controlId;
    if (typeof mutation?.sourceFixture !== "string" || typeof controlId !== "string")
      throw new Error(`Alexa negative fixture lacks an exact source/control reference: ${relativePath}`);
    const source = semanticAdapters.readFixture(mutation.sourceFixture);
    const device = structuredClone(source.device);
    const control = device.controls.find((candidate) => candidate.controlId === controlId);
    if (!control) throw new Error(`Alexa negative fixture control does not exist in its source: ${relativePath}`);
    mutate(control, mutation);
    return alexaContractRuntime.decodeNativeAlexaDevices(envelope([device], projectionContext(device)), projectionContext(device)) === null;
  };
  switch (relativePath) {
    case "alexa-discovery-projection.json":
      return alexaContractRuntime.decodeNativeAlexaDiscovery(fixture);
    case "invalid/impossible-calendar-date-envelope.json":
      return alexaContractRuntime.decodeNativeAlexaDevices(fixture, { homeId: fixture.homeId, homeMembershipId: "membership:tenant-a", role: "TENANT", authorisedAreaIds: [] }) === null;
    case "invalid/device-missing-step-up-policy.json":
      return rejectMutatedSourceControl(fixture, (control, item) => { delete control[item.removeField]; });
    case "invalid/device-invalid-step-up-policy.json":
      return rejectMutatedSourceControl(fixture, (control, item) => { control[item.field] = item.invalidValue; });
    case "invalid/writable-unreadable-control.json":
      return rejectMutatedSourceControl(fixture, (control, item) => Object.assign(control, item.mutation));
    case "invalid/unknown-interaction-commandable.json":
      return rejectMutatedSourceControl(fixture, (control, item) => Object.assign(control, item.mutation));
    case "invalid/duplicate-device-control-id.json": {
      const source = semanticAdapters.readFixture(fixture.sourceFixture);
      const device = structuredClone(source.device);
      const target = device.controls.find((control) => control.controlId === fixture.targetControlId);
      if (!target || device.id !== fixture.deviceId || !device.controls.some((control) => control.controlId === fixture.duplicateControlId))
        throw new Error("Alexa duplicate-control fixture does not resolve its exact source descriptor");
      target.controlId = fixture.duplicateControlId;
      const context = projectionContext(device, "OWNER", source.context.homeMembershipId);
      return alexaContractRuntime.decodeNativeAlexaDevices(envelope([device], context), context) === null;
    }
    case "unknown-interaction-kind.json": {
      const device = { ...fixture.device, lifecycle: "installed" };
      const context = projectionContext(device, "OWNER", "membership:owner-a");
      const result = alexaContractRuntime.decodeNativeAlexaDevices(envelope([device], context), context);
      return Array.isArray(result) && result.length === 0;
    }
    case "invalid/tenant-device-wrong-owner.json": {
      const device = fixture.device;
      const context = projectionContext(device, "TENANT", fixture.context?.homeMembershipId || "membership:tenant-a");
      const result = alexaContractRuntime.decodeNativeAlexaDevices(envelope([device], context), context);
      return Array.isArray(result) && result.length === 0;
    }
    default:
      return undefined;
  }
};
for (const [screenKey, references] of Object.entries(fixtureIndex.screenFixtures)) {
  for (const reference of references) {
    const relativePath = reference.slice("fixtures/".length);
    const fixture = semanticAdapters.readFixture(reference);
    const schemaChecks = fixtureCases
      .filter(([filename]) => filename === relativePath)
      .map(([, schemaName, select, expected]) => ({
        schema: schemaName,
        select,
        expected,
        validate: (value) => definitionValidator(schemaName)(value),
      }));
    const indexedResult = executeIndexedFixtureScenario({
      screenKey,
      fixturePath: reference,
      fixture,
      schemaChecks,
      adapters: semanticAdapters,
    });
    if (screenKey === "tenant.alexa.connection") {
      const relativePath = reference.slice("fixtures/".length);
      const alexaOutcome = runAlexaFixture(relativePath, fixture);
      if (alexaOutcome !== undefined) {
        if (alexaOutcome === false || alexaOutcome === null)
          throw new Error(`Alexa's actual dinodiaV1 adapter disagrees with the indexed scenario: ${reference}`);
        alexaScenarioResults.set(relativePath, alexaOutcome);
      }
    }
    indexedScenarioResults.push(indexedResult);
  }
}
for (const required of ["alexa-discovery-projection.json", "invalid/device-missing-step-up-policy.json", "invalid/device-invalid-step-up-policy.json", "unknown-interaction-kind.json", "invalid/unknown-interaction-commandable.json"]) {
  if (!alexaScenarioResults.has(required)) throw new Error(`Alexa owning-consumer execution is missing from tenant.alexa.connection: ${required}`);
}
if (indexedScenarioResults.length !== Object.values(fixtureIndex.screenFixtures).reduce((total, refs) => total + refs.length, 0) ||
    indexedScenarioResults.some((result) => result.actualOutcome !== "matched" || result.semantic === "schema"))
  throw new Error("Every matrix screen/action fixture must execute through its owning semantic validator, adapter or decision runner");
for (const { line, cells } of registerRows) {
  const screenKey = cells[0].replace(/^`|`$/g, "");
  const references = [...cells[5].matchAll(/`(fixtures\/[A-Za-z0-9._/-]+\.json)`/g)].map((match) => match[1]);
  const indexedReferences = fixtureIndex.screenFixtures[screenKey] ?? [];
  if (JSON.stringify([...references].sort()) !== JSON.stringify([...indexedReferences].sort()))
    throw new Error(`Matrix must enumerate every exact executable fixture path for ${screenKey}: ${JSON.stringify(references)} vs ${JSON.stringify(indexedReferences)}`);
  for (const reference of references) {
    const target = path.join(fixtureRoot, reference.replace(/^fixtures\//, ""));
    if (!fs.existsSync(target) || !indexedReferences.includes(reference) || !indexedFixturePaths.has(reference.replace(/^fixtures\//, "")))
      throw new Error(`Matrix fixture reference must resolve to an indexed executable fixture for ${screenKey}: ${reference} (${line})`);
  }
}
const matrixWithoutExactFixturePaths = matrix.replace(/`fixtures\/[A-Za-z0-9._/-]+\.json`/g, "");
for (const unresolved of ["recovery valid/expired fixtures", "stale-policy", "trusted-device-revocation", "offline-deregistration fixtures"])
  if (matrixWithoutExactFixturePaths.includes(unresolved)) throw new Error(`Static-to-live matrix contains an unresolved fixture shorthand: ${unresolved}`);
const expectedTaskFixtureIds = expectedNativeTasks.map(({ taskId }) => taskId).sort();
if (JSON.stringify(Object.keys(fixtureIndex.taskFixtures ?? {}).sort()) !== JSON.stringify(expectedTaskFixtureIds))
  throw new Error("Fixture index must resolve every and only active native scheduler task");
for (const [taskId, references] of Object.entries(fixtureIndex.taskFixtures)) {
  if (!Array.isArray(references) || references.length === 0) throw new Error(`Scheduler task lacks fixture evidence: ${taskId}`);
  for (const reference of references) {
    if (typeof reference !== "string" || !reference.startsWith("fixtures/"))
      throw new Error(`Task fixture index reference must be an exact fixtures/ path for ${taskId}: ${String(reference)}`);
    const target = path.join(fixtureRoot, reference.replace(/^fixtures\//, ""));
    if (!target.startsWith(`${fixtureRoot}${path.sep}`) || !fs.existsSync(target) || !target.endsWith(".json"))
      throw new Error(`Unresolved task fixture reference for ${taskId}: ${reference}`);
  }
}
const hasCompleteOwnerDetails = (value) => {
  const ownerDetails = value.split(";").map((part) => part.trim());
  return /(?:Stages? \d+|all stages)/i.test(ownerDetails[0]) && ownerDetails.length >= 3 &&
    ownerDetails.every((part) => part && !/^,\s*,?$/.test(part)) && cellsHasFixtureClause(ownerDetails.at(-1)) && value.length >= 16;
};
function cellsHasFixtureClause(value) {
  return value.startsWith("Executable fixtures:");
}
for (const malformed of [
  "Stage 3; , ,; Executable fixtures: `fixtures/example.json`",
  "Stage 3 contract fixture:; Executable fixtures: `fixtures/example.json`",
  "Stage 3; ; Executable fixtures: `fixtures/example.json`",
]) {
  if (hasCompleteOwnerDetails(malformed))
    throw new Error("Static-to-live owner metadata validator accepted an empty or placeholder clause");
}
for (const { line, cells } of registerRows) {
  if (cells.length !== 6 || cells.some((cell) => !cell))
    throw new Error(`Static-to-live screen/action row must define all six contract columns: ${line}`);
  if (!hasCompleteOwnerDetails(cells[5]))
    throw new Error(`Static-to-live screen/action row must name an owning stage and fixture reference: ${line}`);
}
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
const iosPrototypeMatrix = path.resolve(root, "../dinodia-ios-app-V2/Dinodia/DebugFixtures/V2_STATIC_TO_LIVE_MATRIX.md");
if (fs.readFileSync(iosPrototypeMatrix, "utf8") !== matrix)
  throw new Error("iOS DEBUG contract prototype matrix differs from the canonical Platform matrix");
const iosPrototypeSource = path.resolve(root, "../dinodia-ios-app-V2/Dinodia/LiveContracts/Stage2ContractPrototypeView.swift");
const iosPrototypeText = fs.readFileSync(iosPrototypeSource, "utf8");
const iosFixtureSyncScript = fs.readFileSync(path.join(root, "scripts/sync_dinodia_contract_fixtures.mjs"), "utf8");
const debugFixtureList = iosFixtureSyncScript.match(/for \(const fixture of \[([\s\S]*?)\]\) \{/);
if (!debugFixtureList) throw new Error("iOS DEBUG fixture synchronization list is missing");
const synchronizedDebugFixtures = new Set([...debugFixtureList[1].matchAll(/'([^']+\.json)'/g)].map((match) => match[1].replace(/\.json$/, "")));
const iosPrototypeFixtureReferences = new Set([...iosPrototypeText.matchAll(/Stage2PrototypeFixtures\.object\("([A-Za-z0-9._-]+)"\)/g)].map((match) => match[1]));
for (const name of iosPrototypeFixtureReferences) {
  if (!fs.existsSync(path.join(fixtureRoot, `${name}.json`)))
    throw new Error(`iOS prototype references a missing canonical fixture: ${name}.json`);
  if (!synchronizedDebugFixtures.has(name))
    throw new Error(`iOS prototype fixture is not copied into the DEBUG bundle: ${name}.json`);
}
const uniqueIndexedFixturePaths = new Set(
  Object.values(fixtureIndex.screenFixtures).flat(),
);
console.log(
  `dinodia.v1 schemas=${schemas.size} JSON fixtures=${fixtureFiles.length} runtime validators=${validatorNames.length}; indexed screen/action references=${indexedScenarioResults.length}; unique indexed fixture paths=${uniqueIndexedFixturePaths.size}; semantic decision-runner executions=${indexedScenarioResults.length} (not one distinct consumer behavior per reference); Alexa actual adapter executions=${alexaScenarioResults.size}; modeled-denial assertions=${indexedScenarioResults.reduce((sum, result) => sum + result.zeroEffectDenials, 0)} (not a route side-effect proof); iOS DEBUG fixture references=${iosPrototypeFixtureReferences.size}`,
);
