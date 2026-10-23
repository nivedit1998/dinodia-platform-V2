import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import ts from 'typescript';

const require = createRequire(import.meta.url);
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });
  module._compile(compiled.outputText, filename);
};
const { buildHubCloudConfiguration, finalizeHubCloudConfiguration } = require('../src/lib/hubCloudConfiguration.ts');
const { hashSyncConfiguration } = require('../src/lib/hubSyncEnvelope.ts');

const homeId = 'a8218a24-8394-4d5b-8f23-06d205887abb';
const hubId = 'c02be433-d120-4e73-8f54-4cb0e34e3880';
const memberId = '76b31e09-ebdd-4970-959a-6b9a9423cbbd';
const areaId = 'a67b302c-6393-496f-9bf5-855f81397b51';
const deviceId = 'ef957c15-2540-4227-8dcc-523c005fdad8';
const automationId = '7c8c3697-62e8-4ab9-a392-763e85fa7792';

function database({ supportsProjection }) {
  const area = { id: areaId, osAreaId: 'os-area-room-1', originalName: 'Room 1', overrideName: null, revision: 2 };
  const automation = {
    id: automationId, createdByMembershipId: memberId, name: 'Weekday heat', status: 'ACTIVE', revision: 3,
    definitionChecksum: 'b'.repeat(64), timezone: 'Europe/London', retiredAt: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'), updatedAt: new Date('2026-10-02T00:00:00.000Z'),
    triggers: [{ id: '5f621daa-0144-4ed7-8b30-d33feef783c4', kind: 'SCHEDULE', configuration: { minuteOfDay: 420, weekdays: [1, 2, 3, 4, 5] }, revision: 1 }],
    actions: [{ id: '70378ccd-92a2-480d-930e-0421a7b1a5ac', deviceId, areaId,
      device: { osDeviceId: 'zigbee:trv', managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null, lifecycle: 'INSTALLED', descriptorRevision: 9, originalName: 'TRV', overrideName: null, customerLabel: 'Radiator' },
      area, controlId: 'heat_demand', sortOrder: 0, descriptorRevision: 9, actionValue: { value: 'heat' }, needsAttention: false }],
    executions: [{ status: 'SUCCEEDED', startedAt: new Date('2026-10-02T07:00:00.000Z'), completedAt: new Date('2026-10-02T07:00:01.000Z'), safeOutcome: { actionCount: 1, actionStatuses: { applied: 1, failed: 0, uncertain: 0, skipped: 0 } } }],
  };
  return {
    home: { findUnique: async () => ({ id: homeId, managementRevision: 12, timezone: 'Europe/London' }) },
    area: { findMany: async () => [area] },
    homeMembership: { findMany: async () => [{ id: memberId, role: 'TENANT', accessRevision: 4, tenantAreaGrants: [{ areaId, policyRevision: 4 }] }] },
    nativeDevice: { findMany: async () => [{ osDeviceId: 'zigbee:trv', managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null, analyticsCategory: 'RADIATOR', inventoryRevision: 4, lifecycle: 'INSTALLED', customerLabel: 'Radiator', overrideName: null, descriptorRevision: 9, descriptorDigest: 'a'.repeat(64), assignments: [{ areaId, area }] }] },
    nativeAutomation: { findMany: async () => [automation] },
    hubInstallation: { findUnique: async () => ({ accessPolicyRevision: 8, capabilitySummary: supportsProjection ? { nativeTenantAutomationProjectionV1: true } : {} }) },
  };
}

test('tenant automation projection is capability-gated and independent of the execution release hold', async () => {
  const previous = process.env.DINODIA_NATIVE_AUTOMATIONS_ENABLED;
  delete process.env.DINODIA_NATIVE_AUTOMATIONS_ENABLED;
  try {
    const olderHub = await buildHubCloudConfiguration(database({ supportsProjection: false }), { homeId, hubInstallationId: hubId });
    assert.equal(Object.hasOwn(olderHub, 'tenantAutomationProjection'), false, 'legacy Hub config stays byte-schema compatible');

    const upgradedHub = await buildHubCloudConfiguration(database({ supportsProjection: true }), { homeId, hubInstallationId: hubId });
    assert.equal(upgradedHub.tenantAutomationProjection?.version, 1);
    assert.equal(upgradedHub.tenantAutomationProjection?.executionEnabled, false);
    assert.equal(upgradedHub.automations.length, 0, 'tenant read support does not enable the scheduler');
    assert.equal(upgradedHub.tenantAutomationProjection?.automations.length, 1);
    assert.equal(upgradedHub.tenantAutomationProjection?.automations[0].creatorMembershipId, memberId);
    assert.equal(upgradedHub.tenantAutomationProjection?.automations[0].actions[0].deviceId, deviceId);
    assert.equal(upgradedHub.tenantAutomationProjection?.automations[0].actions[0].osDeviceId, 'zigbee:trv');
    assert.equal(upgradedHub.checksum, hashSyncConfiguration(Object.fromEntries(Object.entries(upgradedHub).filter(([key]) => key !== 'checksum'))));
    assert.equal(finalizeHubCloudConfiguration(upgradedHub, 12).revision, 12);
  } finally {
    if (previous === undefined) delete process.env.DINODIA_NATIVE_AUTOMATIONS_ENABLED;
    else process.env.DINODIA_NATIVE_AUTOMATIONS_ENABLED = previous;
  }
});

test('signed analytics config seeds existing devices and renews generation without enabling collection or churning intervals', async () => {
  const db = database({ supportsProjection: false }); let generation = 1; let writerEnabled = false; const rows = [];
  const devices = await db.nativeDevice.findMany(); devices[0].id = deviceId;
  db.nativeDevice.findMany = async () => devices;
  db.nativeDevice.findFirst = async () => ({ capabilitySummary: { controlCatalog: { controls: [
    { controlId: 'heat_demand', semanticRole: 'active_heat_demand', observable: true, writable: false, surfaceId: '1' },
  ] } } });
  db.$queryRaw = async () => [];
  db.hubInstallation.findUnique = async () => ({ accessPolicyRevision: 8, capabilitySummary: { nativeUniversalAnalyticsV2: true },
    analyticsWriterEnabled: writerEnabled, analyticsCollectionEnabled: false, manufacturingIdentity: { identityGeneration: generation } });
  db.nativeAnalyticsInterval = {
    findMany: async () => rows.filter(row => row.validUntil === null),
    findFirst: async () => rows.at(-1) || null,
    updateMany: async ({ data }) => { for (const row of rows.filter(item => item.validUntil === null)) Object.assign(row, data); },
    create: async ({ data }) => { const row = { id: `interval-${rows.length}`, validUntil: null, ...data }; rows.push(row); return row; },
  };
  await buildHubCloudConfiguration(db, { homeId, hubInstallationId: hubId }); assert.equal(rows.length, 0, 'capability advertisement cannot activate or seed a writer');
  writerEnabled = true;
  const first = await buildHubCloudConfiguration(db, { homeId, hubInstallationId: hubId });
  assert.equal(rows.length, 1); assert.equal(first.devicePolicies[0].analyticsInterval.writerEnabled, true);
  assert.equal(first.devicePolicies[0].analyticsInterval.genericCollectionEnabled, false);
  assert.deepEqual(first.devicePolicies[0].analyticsInterval.authorizedControlIds, ['heat_demand']);
  await buildHubCloudConfiguration(db, { homeId, hubInstallationId: hubId }); assert.equal(rows.length, 1);
  rows[0].validFrom = new Date(Date.now() - 1000); generation = 2;
  const renewed = await buildHubCloudConfiguration(db, { homeId, hubInstallationId: hubId });
  assert.equal(rows.length, 2); assert.ok(rows[0].validUntil);
  assert.equal(renewed.devicePolicies[0].analyticsInterval.sourceGeneration, 2);
});
