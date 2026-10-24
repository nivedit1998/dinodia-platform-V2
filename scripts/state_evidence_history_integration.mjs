import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export async function verifyStateEvidenceHistory({ base, osRoot, prisma, hub, fixture, homeId, installationId,
  areaId, osAreaId, headers, changeAnalyticsInterval, machineRequest, fetchJson }) {
  assert.equal(new URL(base).hostname, '127.0.0.1');
  const require = createRequire(path.join(osRoot, 'package.json'));
  const { Store } = require(path.join(osRoot, 'src/store.js'));
  const { checkedStateFixture } = require(path.join(osRoot, 'test/helpers/checked-state-fixture.js'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'state-evidence-history-'));
  const prior = await prisma.hubInstallation.findUniqueOrThrow({ where: { id: installationId }, select: { analyticsWriterEnabled: true } });
  let device;
  try {
    const start = Math.floor((Date.now() - 7200000) / 3600000) * 3600000 + 600000;
    const store = new Store(path.join(directory, 'store.json')); store.setUsageClockTrust(() => true);
    await store.saveArea({ name: 'Synthetic measured light' }, osAreaId);
    await store.savePlatform({ homeId });
    const checked = await checkedStateFixture({ store, directory, now: start, areaId: osAreaId,
      generation: fixture.identityOneGeneration, controlId: 'power' });
    const catalogEvent = store.getSyncOutbox().events.filter(event => event.type === 'control.catalog.upsert').at(-1);
    assert.ok(catalogEvent, 'actual recorder must publish the actual bridge control catalog');
    const catalog = catalogEvent.payload;
    const selectedSignal = catalog.controls.find(control => control.semanticRole === 'power' && control.observable === true);
    assert.ok(selectedSignal, 'synthetic light must expose a genuine observable power signal');
    device = await prisma.nativeDevice.create({ data: { homeId, hubInstallationId: installationId,
      osDeviceId: checked.deviceId, originalName: 'Synthetic checked light', technicalLabel: 'Synthetic',
      managementClass: 'PROPERTY_DEVICE', analyticsCategory: 'LIGHT', lifecycle: 'INSTALLED', deviceType: 'light', protocol: 'zigbee',
      descriptorRevision: catalog.catalogRevision, descriptorDigest: catalog.descriptorDigest,
      capabilitySummary: { controlCatalog: { revision: catalog.catalogRevision, descriptorDigest: catalog.descriptorDigest, controls: catalog.controls } } } });
    await prisma.deviceAreaAssignment.create({ data: { homeId, deviceId: device.id, areaId,
      validFrom: new Date(start - 3600000), source: 'OS_SYNC' } });
    await prisma.hubInstallation.update({ where: { id: installationId }, data: { analyticsWriterEnabled: true } });
    const interval = await prisma.$transaction(tx => changeAnalyticsInterval(tx, { homeId, hubInstallationId: installationId,
      deviceId: device.id, category: 'LIGHT', selectedControlId: selectedSignal.controlId, generation: fixture.identityOneGeneration,
      analyticsPolicyVersion: 3, at: new Date(start) }));
    const platform = store.getPlatform();
    await store.savePlatform({ ...platform, devicePolicies: { ...platform.devicePolicies, [checked.deviceId]: {
      ...platform.devicePolicies[checked.deviceId], analyticsStartAt: new Date(start).toISOString(),
      analyticsInterval: { id: interval.id, revision: interval.revision, sourceGeneration: fixture.identityOneGeneration,
        validFrom: interval.validFrom.toISOString(), writerEnabled: true, genericCollectionEnabled: false, analyticsPolicyVersion: 3 } } } });
    await checked.report('OFF', { advance: 1000 });
    await store.advanceSyncUsage(checked.clock() + 60000);
    const event = store.getSyncOutbox().events.filter(event => event.type === 'usage.bucket'
      && event.payload.analyticsPolicyVersion === 3).at(-1);
    assert.ok(event, 'real Store recorder must emit policy-3 duration');
    assert.equal(event.payload.onSeconds, 0); assert.equal(event.payload.offSeconds, 60);
    await hub.store.queueSyncEvent(event.type, event.aggregateId, event.payload);
    const batch = await hub.store.prepareSyncBatch(installationId, hub.pairing.runtime, Date.now());
    const send = () => machineRequest({ base, path: '/api/hub-agent/v2/sync', machineSecret: fixture.machineSecret,
      body: { serial: fixture.identityOneSerial, identityGeneration: fixture.identityOneGeneration, ...batch } });
    const response = await send(); assert.equal(response.response.status, 200);
    assert.equal((await send()).response.status, 200, 'exact signed retry is idempotent');
    await hub.store.acknowledgeSyncBatch({ streamId: response.body.streamId, acceptedThroughSequence: Number(response.body.acceptedThroughSequence),
      cloudRevision: Number(response.body.cloudRevision), configurationAppliedRevision: Number(response.body.configurationAppliedRevision) });
    const rows = await prisma.nativeDeviceUsageBucket.findMany({ where: { deviceId: device.id } });
    assert.equal(rows.length, 1); assert.equal(rows[0].analyticsPolicyVersion, 3);
    assert.equal(rows[0].offSeconds, 60); assert.equal(rows[0].bucketStart.toISOString(), event.payload.bucketStart);
    const query = new URLSearchParams({ metric: 'light', level: 'hour', from: event.payload.bucketStart,
      to: new Date(Date.parse(event.payload.bucketStart) + 3600000).toISOString(), deviceIds: device.id, areaIds: areaId });
    const analytics = await fetchJson(`${base}/api/v2/homes/${homeId}/analytics/usage?${query}`, { headers });
    assert.equal(analytics.response.status, 200);
    assert.equal(analytics.body.buckets.reduce((sum, bucket) => sum + bucket.offMinutes, 0), 1);
    console.log('[state-evidence:integration] PASS: real checked Zigbee recorder -> policy-3 epoch -> signed outbox -> delayed original-hour ingestion/retry -> authenticated light analytics (60 seconds measured Off)');
  } finally {
    if (device) {
      await prisma.nativeDeviceUsageBucket.deleteMany({ where: { deviceId: device.id } });
      await prisma.nativeAnalyticsUnallocated.deleteMany({ where: { deviceId: device.id } });
      await prisma.nativeAnalyticsInterval.deleteMany({ where: { deviceId: device.id } });
      await prisma.deviceAreaAssignment.deleteMany({ where: { deviceId: device.id } });
      await prisma.nativeDevice.delete({ where: { id: device.id } });
    }
    await prisma.hubInstallation.update({ where: { id: installationId }, data: prior });
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
