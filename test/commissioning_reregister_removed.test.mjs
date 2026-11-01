import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/app/api/hub-agent/v2/commissioning-sessions/route.ts', 'utf8');

test('a radio removed from the same Home can be registered again', () => {
  assert.match(source, /preexisting\.lifecycle !== 'REMOVED' \|\| preexisting\.homeId !== authority\.home\.id/);
  assert.match(source, /owner\.lifecycle !== 'REMOVED' \|\| owner\.homeId !== authority\.home\.id/);
  assert.match(source, /nativeDeviceSourceAlias\.deleteMany\(\{ where: \{ hubInstallationId: hub\.installation\.id, deviceId: \{ in: removedBefore \}/);
  assert.match(source, /~retired~/);
});

test('registered radios in use or in another Home are still refused', () => {
  const guard = source.indexOf("preexisting.lifecycle !== 'REMOVED'");
  const failure = source.indexOf("fail(409, 'device_identity_conflict'", guard);
  assert.ok(guard > 0 && failure > guard && failure - guard < 160);
  assert.match(source, /already bound to another canonical device/);
  // The retiring happens before the new record is created, never after.
  assert.ok(source.indexOf('~retired~') < source.indexOf('tx.nativeDevice.create({ data: {\n        homeId: authority.home.id, hubInstallationId'));
});

test('registering an already-paired radio that was removed from this Home is allowed at session start', () => {
  assert.match(source, /const removedHere = \(record: \{ homeId: string; lifecycle: string \}\) => record\.lifecycle === 'REMOVED' && record\.homeId === authority\.home\.id/);
  assert.match(source, /existingDevice && !removedHere\(existingDevice\)/);
});

test('a hub still reporting a removed device is acknowledged instead of stalling its queue', () => {
  const ingestion = fs.readFileSync('src/lib/hubSyncIngestion.ts', 'utf8');
  assert.match(ingestion, /if \(device\.lifecycle === 'REMOVED'\) return;\n    if \(\['RETIRED', 'REMOVED', 'REMOVAL_PENDING'\]\.includes\(device\.lifecycle\)\) invalid\('hub_sync_device_retired'/);
  assert.match(ingestion, /if \(device\.lifecycle === 'REMOVED'\) return;\n    if \(\['RETIRED', 'REMOVED', 'REMOVAL_PENDING'\]\.includes\(device\.lifecycle\)\) invalid\('hub_sync_catalog_device_retired'/);
});

test('an incident notice from before a radio was registered again is ignored instead of stalling the queue', () => {
  const ingestion = fs.readFileSync('src/lib/hubSyncIngestion.ts', 'utf8');
  assert.match(ingestion, /occurredAt < device\.installedAt\.getTime\(\)\) return;\n      deviceId = device\.id;/);
});
