import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), ts = require('typescript');

// This domain/constraint check is called ONLY by the maintained disposable Docker harness.
// It deliberately does not claim to prove the HTTP actor/session boundary.
export async function logicalDevicesDatabaseChecks({ prisma, fixture, osRoot, databaseUrl, base, machineRequest }) {
  const url = new URL(databaseUrl);
  assert.ok(['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname), 'Disposable local DB only');
  const cache = new Map();
  function load(name) {
    const file = path.resolve('src/lib', `${name}.ts`);
    if (cache.has(file)) return cache.get(file);
    const module = { exports: {} }; cache.set(file, module.exports);
    const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function('require', 'module', 'exports', js)(id => id === './stage1Auth'
      ? { Stage1AuthError: class extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } } }
      : id.startsWith('.') ? load(path.relative(path.resolve('src/lib'), path.resolve(path.dirname(file), id))) : require(id), module, module.exports);
    cache.set(file, module.exports); return module.exports;
  }
  const { commissionLogicalChildren } = load('commissioningLogicalDevices');
  const { normalizeZigbeeDevice } = require(path.join(osRoot, 'src/integrations/zigbee/exposeNormalizer'));
  const { buildLogicalCommissioningProposal } = require(path.join(osRoot, 'src/commissioning/logicalDeviceCatalogue'));
  const adapterFixture = JSON.parse(fs.readFileSync(path.join(osRoot, 'test/fixtures/zigbee/two-gang-light.json')));
  const physical = normalizeZigbeeDevice(adapterFixture);
  const original = await prisma.nativeDevice.create({ data: {
    id: randomUUID(), homeId: fixture.homeOneId, hubInstallationId: fixture.hubOneId,
    osDeviceId: physical.id, originalName: 'Synthetic two-channel switch', technicalLabel: 'tenant_device',
    customerLabel: 'My switch', deviceType: 'switch', managementClass: 'TENANT_DEVICE', ownerMembershipId: fixture.tenantMembershipId,
    analyticsCategory: 'NONE', lifecycle: 'INSTALLED', protocol: 'zigbee', descriptorRevision: 1,
    descriptorDigest: 'a'.repeat(64), installedAt: new Date(),
    assignments: { create: { homeId: fixture.homeOneId, areaId: fixture.areaOneId, source: 'LD_SYNTHETIC_TEST', validFrom: new Date() } },
  } });
  const proposal = buildLogicalCommissioningProposal({ device: physical, homeId: fixture.homeOneId,
    membershipId: fixture.tenantMembershipId, managementClass: 'tenant_device', areaId: fixture.areaOneId,
    hubAreaId: fixture.areaOneOsId, name: 'Switch', customerLabel: 'My switch', labels: [{ id: 'tenant_device', name: 'My device' }], now: Date.now() });
  assert.ok(proposal && proposal.channels.length === 2, 'Actual Hub normalization/catalogue must produce two channels');
  const children = await prisma.$transaction(tx => commissionLogicalChildren(tx, { original, channels: proposal.channels,
    protocolIdentityHash: createHash('sha256').update(physical.id).digest('hex'), generation: 1, now: new Date() }), { isolationLevel: 'Serializable' });
  assert.equal(children.length, 2);
  const rows = await prisma.$queryRaw`SELECT "id", "physicalParentId", "sourceBinding" FROM "NativeDevice" WHERE "id" IN (${children[0].id}::uuid, ${children[1].id}::uuid)`;
  assert.equal(rows.length, 2); assert.equal(rows[0].physicalParentId, rows[1].physicalParentId);
  assert.ok(rows.every(row => row.sourceBinding && row.physicalParentId));
  const parentId = rows[0].physicalParentId;
  await assert.rejects(prisma.$executeRaw`UPDATE "NativePhysicalDevice" SET "ownerMembershipId" = ${fixture.ownerMembershipId}::uuid WHERE "id" = ${parentId}::uuid`);
  await prisma.nativeDevice.delete({ where: { id: children[0].id } });
  assert.equal((await prisma.$queryRaw`SELECT "id" FROM "NativePhysicalDevice" WHERE "id" = ${parentId}::uuid`).length, 1, 'One sibling keeps the parent');
  await prisma.nativeDevice.delete({ where: { id: children[1].id } });
  assert.equal((await prisma.$queryRaw`SELECT "id" FROM "NativePhysicalDevice" WHERE "id" = ${parentId}::uuid`).length, 0, 'Last child erases empty parent metadata');
  await prisma.nativeDevice.delete({ where: { id: original.id } });
  console.log('[logical-devices:integration] PASS actual Hub channel catalogue -> Platform transaction -> PostgreSQL parent guards and shared-parent cleanup; HTTP/conversion/deletion acceptance not claimed');
  // Exercise the actual machine-authenticated route and real coordinator, not
  // a mock transaction. The fixtures below exist only in this disposable DB.
  const { Store } = require(path.join(osRoot, 'src/store'));
  const { AreaDeletionService } = require(path.join(osRoot, 'src/lifecycle/areaDeletionService'));
  const directory = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'dinodia-ld-http-'));
  const store = new Store(path.join(directory, 'store.json'));
  try {
    const room = await prisma.area.create({ data: { homeId: fixture.homeOneId, osAreaId: `ld-room-${randomUUID()}`, originalName: 'Disposable room' } });
    await store.saveArea({ name: 'Disposable room' }, room.osAreaId);
    await store.savePlatform({ homeId: fixture.homeOneId, hubInstallId: fixture.hubOneId,
      areaBindings: [{ areaId: room.id, hubAreaId: room.osAreaId }] });
    const now = Date.now(), jti = randomUUID();
    const session = await prisma.employeeSession.create({ data: { employeeId: fixture.operatorEmployeeId,
      tokenHash: createHash('sha256').update(randomUUID()).digest('hex'), recentAuthenticatedAt: new Date(now),
      createdAt: new Date(now - 1000), expiresAt: new Date(now + 23 * 3600000) } });
    const work = await prisma.companyOperationalWorkItem.create({ data: { publicReference: `LD-${randomUUID().slice(0, 20)}`,
      kind: 'PHYSICAL_CONFIGURATION_CORRECTION', homeId: fixture.homeOneId, hubInstallationId: fixture.hubOneId,
      certifiedSerialNumber: fixture.identityOneSerial, assignedEmployeeId: fixture.operatorEmployeeId,
      createdByEmployeeId: fixture.operatorEmployeeId, reason: 'Disposable logical-device test' } });
    const issued = Math.floor(now / 1000) * 1000;
    const handoff = await prisma.operatorHandoff.create({ data: { employeeId: fixture.operatorEmployeeId,
      workflowId: work.id, homeId: fixture.homeOneId, hubInstallationId: fixture.hubOneId,
      setupAttemptId: randomUUID(), browserBindingHash: createHash('sha256').update(randomUUID()).digest('hex'),
      handoffHash: createHash('sha256').update(randomUUID()).digest('hex'), handoffEnvelope: 'disposable',
      createdAt: new Date(issued), consumedAt: new Date(now), expiresAt: new Date(now + 60000),
      scope: { scopes: ['os:admin'], employeeSessionId: session.id, workRevision: work.workRevision,
        operatorJti: jti, credentialVersion: 0, identityGeneration: fixture.identityOneGeneration,
        serialNumber: fixture.identityOneSerial, operatorIssuedAt: issued, operatorExpiresAt: issued + 1800000 } } });
    const principal = { scope: ['os:admin'], handoffId: handoff.id, jti, credentialVersion: 0 };
    const request = async (endpoint, body) => {
      const result = await machineRequest({ base, path: endpoint, machineSecret: fixture.machineSecret,
        body: { serial: fixture.identityOneSerial, identityGeneration: fixture.identityOneGeneration, ...body } });
      if (result.response.status !== 200) throw Object.assign(new Error(`Logical HTTP ${result.response.status}/${result.body.errorCode}`), { code: result.body.errorCode });
      return result.body;
    };
    const service = new AreaDeletionService({ store, platform: request,
      removePhysical: async () => { throw new Error('An empty room must not unpair anything'); } });
    const preview = await service.preview(principal, room.osAreaId);
    await assert.rejects(service.confirm({ ...principal, jti: randomUUID() }, { ...preview, confirmationName: room.originalName }));
    const input = { ...preview, confirmationName: room.originalName };
    assert.equal((await service.confirm(principal, input)).state, 'COMPLETE');
    assert.equal((await service.confirm(principal, input)).state, 'COMPLETE');
    assert.equal(await prisma.area.count({ where: { id: room.id } }), 0);
    assert.equal(store.getArea(room.osAreaId), null);
    assert.equal(await prisma.deletionSecurityReceipt.count({ where: { actionType: 'AREA_DEVICE_ERASURE' } }) > 0, true);
    console.log('[logical-devices:integration] PASS real Hub coordinator -> machine-signed HTTP -> disposable PostgreSQL preview/reserve/commit/finish, wrong-session denial and exact duplicate retry');
    const conversionArea = await prisma.area.create({ data: { homeId: fixture.homeOneId,
      osAreaId: `ld-convert-${randomUUID()}`, originalName: 'Conversion fixture room' } });
    await store.saveArea({ name: conversionArea.originalName }, conversionArea.osAreaId);
    await store.upsertDevice({ ...physical, areaId: conversionArea.osAreaId, name: 'Conversion switch', labelIds: ['light'],
      setup: { status: 'ready' }, managementClass: 'property_device' });
    const retained = await prisma.nativeDevice.create({ data: { homeId: fixture.homeOneId, hubInstallationId: fixture.hubOneId,
      osDeviceId: physical.id, originalName: 'Conversion switch', technicalLabel: 'light', deviceType: 'switch',
      managementClass: 'PROPERTY_DEVICE', protocol: 'ZIGBEE', analyticsCategory: 'LIGHT', lifecycle: 'INSTALLED',
      descriptorRevision: 1, descriptorDigest: 'a'.repeat(64),
      assignments: { create: { homeId: fixture.homeOneId, areaId: conversionArea.id, source: 'LD_CONVERSION_TEST', validFrom: new Date(Date.now() - 3600000) } } } });
    const epoch = await prisma.nativeAnalyticsInterval.create({ data: { homeId: fixture.homeOneId, hubInstallationId: fixture.hubOneId,
      deviceId: retained.id, analyticsCategory: 'LIGHT', revision: 1, sourceGeneration: fixture.identityOneGeneration,
      validFrom: new Date(Date.now() - 3600000), authorizedControls: [] } });
    await store.savePlatform({ areaBindings: [{ areaId: conversionArea.id, hubAreaId: conversionArea.osAreaId }],
      devicePolicies: { [physical.id]: { managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null,
        lifecycle: 'INSTALLED', analyticsCategory: 'LIGHT', customerLabel: 'Light', osAreaIds: [conversionArea.osAreaId],
        canonicalAreaIds: [conversionArea.id], inventoryRevision: retained.inventoryRevision } } });
    const { LogicalDeviceConversion } = require(path.join(osRoot, 'src/commissioning/logicalDeviceConversion'));
    const conversion = new LogicalDeviceConversion({ store, platform: request,
      protocolIdentity: () => ({ hash: createHash('sha256').update(physical.id).digest('hex') }) });
    const proposed = await conversion.preview(principal, physical.id);
    await request('/api/hub-agent/v2/logical-conversion', { action: 'reserve', osDeviceId: physical.id,
      operationId: proposed.operationId, digest: proposed.digest, confirmationName: proposed.confirmationName,
      handoffId: principal.handoffId, jti: principal.jti, credentialVersion: 0 });
    await assert.rejects(prisma.nativeDevice.update({ where: { id: retained.id },
      data: { analyticsCategory: 'NONE', inventoryRevision: { increment: 1 } } }),
    'A reserved conversion must reject a concurrent category/inventory edit before local fencing');
    const converted = await conversion.confirm(principal, proposed);
    assert.equal(converted.state, 'COMPLETE');
    assert.equal((await conversion.confirm(principal, proposed)).state, 'COMPLETE');
    assert.equal(store.listManagedDevices().length, 2);
    assert.equal(store.getManagedDevice(physical.id), null);
    const priorDevice = await prisma.nativeDevice.findUniqueOrThrow({ where: { id: retained.id } });
    assert.equal(priorDevice.lifecycle, 'RETIRED');
    assert.ok((await prisma.nativeAnalyticsInterval.findUniqueOrThrow({ where: { id: epoch.id } })).validUntil);
    assert.equal(await prisma.nativeAnalyticsInterval.count({ where: { deviceId: retained.id } }), 1, 'No copied or invented historical epoch');
    console.log('[logical-devices:integration] PASS real existing-device conversion HTTP, durable local fence, original epoch closure, two prospective child identities and duplicate retry');
    const secondRoom = await prisma.area.create({ data: { homeId: fixture.homeOneId,
      osAreaId: `ld-sibling-${randomUUID()}`, originalName: 'Surviving sibling room' } });
    await store.saveArea({ name: secondRoom.originalName }, secondRoom.osAreaId);
    await store.savePlatform({ areaBindings: [
      { areaId: conversionArea.id, hubAreaId: conversionArea.osAreaId },
      { areaId: secondRoom.id, hubAreaId: secondRoom.osAreaId }] });
    const channels = store.listManagedDevices();
    const moving = channels[1], erased = channels[0];
    await conversion.assign(principal, moving.id, { operationId: randomUUID(), name: 'Surviving channel',
      areaId: secondRoom.osAreaId, labelId: 'light' });
    assert.equal(store.getManagedDevice(moving.id).areaId, secondRoom.osAreaId);
    const canonicalErased = await prisma.nativeDevice.findFirstOrThrow({ where: {
      homeId: fixture.homeOneId, hubInstallationId: fixture.hubOneId, osDeviceId: erased.id } });
    await prisma.nativeDomainOutbox.create({ data: { homeId: fixture.homeOneId, hubInstallationId: fixture.hubOneId,
      aggregateType: 'Alexa', aggregateId: canonicalErased.id, eventType: 'ALEXA_CHANGE_REPORT',
      idempotencyKey: `ld-private-payload:${randomUUID()}`, state: 'PENDING', expiresAt: new Date(Date.now() + 60000),
      payload: { tenantOwnedState: { osDeviceId: erased.id, value: 'synthetic-private-value' } } } });
    let physicalRemovals = 0;
    const deleting = new AreaDeletionService({ store, platform: request,
      removePhysical: async () => { physicalRemovals++; throw new Error('Shared hardware must remain paired'); } });
    const retainedConverted = await prisma.nativeDevice.findUniqueOrThrow({ where: { id: retained.id } });
    await prisma.nativeDevice.update({ where: { id: retained.id }, data: {
      radiatorTemperature: 21, radiatorReadingAt: new Date(), capabilitySummary: {
        ...retainedConverted.capabilitySummary, alexaStateByControl: { legacy: { value: 21 } } } } });
    const deletion = await deleting.preview(principal, conversionArea.osAreaId);
    assert.equal(deletion.sharedHardwarePreserved, 1);
    // The actual coordinator will replay this exact reservation. An unrelated
    // Home revision must not strand its already-confirmed destructive intent.
    const cloudDeletion = await prisma.nativeDomainOutbox.findUniqueOrThrow({ where: {
      idempotencyKey: `area-delete:${fixture.hubOneId}:${deletion.operationId}` } });
    await request('/api/hub-agent/v2/area-deletion', { action: 'reserve', operationId: deletion.operationId,
      digest: cloudDeletion.payload.digest, confirmationName: conversionArea.originalName,
      handoffId: principal.handoffId, jti: principal.jti, credentialVersion: 0 });
    await assert.rejects(prisma.area.update({ where: { id: conversionArea.id }, data: { originalName: 'Must be rejected' } }));
    await prisma.home.update({ where: { id: fixture.homeOneId }, data: { managementRevision: { increment: 1 } } });
    assert.equal((await deleting.confirm(principal, { ...deletion, confirmationName: conversionArea.originalName })).state, 'COMPLETE');
    assert.equal(physicalRemovals, 0);
    assert.ok(store.getManagedDevice(moving.id));
    assert.equal(store.getManagedDevice(erased.id), null);
    assert.equal(await prisma.nativeDevice.count({ where: { id: canonicalErased.id } }), 0);
    assert.equal(await prisma.nativeDevice.count({ where: { id: retained.id } }), 0,
      'Converted historical parent cache and identity must not escape room erasure');
    const retainedPayloads = await prisma.nativeDomainOutbox.findMany({ where: {
      homeId: fixture.homeOneId, eventType: 'ALEXA_CHANGE_REPORT' } });
    assert.ok(retainedPayloads.every(row => !JSON.stringify(row.payload).includes(erased.id)));
    console.log('[logical-devices:integration] PASS independent assignment and shared-room deletion via real machine HTTP; sibling survives, zero unpair attempts, attributable Alexa payload removed');
    const membership = await prisma.homeMembership.findUniqueOrThrow({ where: { id: fixture.tenantMembershipId },
      include: { customerAccount: true } });
    const trustedTemplate = await prisma.trustedDevice.findFirstOrThrow({ where: { customerAccountId: membership.customerAccountId } });
    const trusted = await prisma.trustedDevice.create({ data: { customerAccountId: membership.customerAccountId,
      deviceInstallationId: `ld-http-${randomUUID()}`, publicKey: trustedTemplate.publicKey,
      publicKeyThumbprint: trustedTemplate.publicKeyThumbprint, deviceName: 'Disposable commissioning session' } });
    const accessHash = createHash('sha256').update(randomUUID()).digest('hex');
    const customerSession = await prisma.customerSession.create({ data: { customerAccountId: membership.customerAccountId,
      trustedDeviceId: trusted.id, refreshTokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
      accessTokenHash: accessHash, accessTokenExpiresAt: new Date(Date.now() + 3600000),
      expiresAt: new Date(Date.now() + 3600000), absoluteExpiresAt: new Date(Date.now() + 3600000),
      securityVersion: membership.customerAccount.securityVersion, trustedDeviceSessionVersion: trusted.sessionVersion } });
    await prisma.tenantAreaGrant.upsert({ where: { membershipId_areaId: { membershipId: membership.id, areaId: secondRoom.id } },
      create: { membershipId: membership.id, areaId: secondRoom.id, homeId: fixture.homeOneId }, update: { revokedAt: null } });
    await prisma.hubInstallation.update({ where: { id: fixture.hubOneId }, data: { capabilitySummary: {
      nativeZigbeeCommissioningV1: true, nativeLogicalDevicesV1: true } } });
    const privatePhysical = normalizeZigbeeDevice({ ...adapterFixture, ieee_address: `fixture-http-${randomUUID()}` });
    const { buildPublicCommissioningCatalogue } = require(path.join(osRoot, 'src/commissioning/publicDeviceCatalogue'));
    const cat = buildPublicCommissioningCatalogue({ device: privatePhysical, homeId: fixture.homeOneId,
      membershipId: membership.id, managementClass: 'tenant_device', areaId: secondRoom.id,
      name: 'Private switch', customerLabel: 'My switch' });
    const privateChannels = buildLogicalCommissioningProposal({ device: privatePhysical, homeId: fixture.homeOneId,
      membershipId: membership.id, managementClass: 'tenant_device', areaId: secondRoom.id,
      hubAreaId: secondRoom.osAreaId, name: 'Private switch', customerLabel: 'My switch',
      labels: [{ id: 'tenant_device', name: 'Tenant Device' }], now: Date.now() });
    const common = { sessionId: randomUUID(), homeId: fixture.homeOneId, hubInstallationId: fixture.hubOneId,
      protocol: 'zigbee', operationKind: 'PAIR_NEW', expiresAt: new Date(Date.now() + 600000).toISOString(),
      accountId: membership.customerAccountId, membershipId: membership.id, customerSessionId: customerSession.id,
      trustedDeviceId: trusted.id, accessTokenHash: accessHash };
    const commission = async input => {
      const result = await machineRequest({ base, path: '/api/hub-agent/v2/commissioning-sessions',
        machineSecret: fixture.machineSecret, body: { serial: fixture.identityOneSerial,
          identityGeneration: fixture.identityOneGeneration, ...common, ...input } });
      assert.ok([200, 201].includes(result.response.status),
        `Actual private commissioning failed: ${result.response.status}/${result.body.error?.code || result.body.errorCode}`);
      return result.body;
    };
    await commission({ action: 'create', expectedRevision: 1,
      idempotencyHash: createHash('sha256').update(randomUUID()).digest('hex'),
      requestHash: createHash('sha256').update(JSON.stringify({ operationKind: 'PAIR_NEW', protocol: 'zigbee' })).digest('hex') });
    await commission({ action: 'transition', expectedRevision: 1, status: 'ADVERTISING' });
    const candidateRef = randomUUID();
    await commission({ action: 'transition', expectedRevision: 2, status: 'READY', selectedAreaId: secondRoom.id,
      candidateRef, osDeviceId: privatePhysical.id, requestedName: 'Private switch', customerLabel: 'My switch',
      catalogueStatus: cat.capabilityStatus, catalogueRevision: cat.descriptorRevision, descriptorDigest: cat.descriptorDigest });
    const completeInput = { action: 'finalize', expectedRevision: 3, candidateRef, disposition: 'install', device: {
      osDeviceId: cat.osDeviceId, originalName: cat.originalName, technicalLabel: cat.technicalLabel, deviceType: cat.deviceType,
      manufacturer: cat.manufacturer, model: cat.model, protocol: cat.protocol,
      protocolIdentityHash: createHash('sha256').update(privatePhysical.id).digest('hex'),
      descriptorRevision: cat.descriptorRevision, descriptorDigest: cat.descriptorDigest,
      capabilitySummary: { controls: cat.controls.map(control => ({ controlId: control.controlId, kind: control.valueType,
        readable: control.readable === true, writable: control.writable === true, domain: control.semanticRole || 'unknown' })) },
      catalogueStatus: cat.capabilityStatus, usefulReadings: cat.usefulReadings,
      areaId: secondRoom.id, name: 'Private switch', customerLabel: 'My switch', channels: privateChannels.channels } };
    const completedPrivate = await commission(completeInput);
    const repeatedPrivate = await commission(completeInput);
    assert.equal(completedPrivate.logicalDevices.length, 2);
    assert.deepEqual(repeatedPrivate.logicalDevices, completedPrivate.logicalDevices);
    assert.ok(completedPrivate.logicalDevices.every(row => row.ownerMembershipId === membership.id && row.managementClass === 'TENANT_DEVICE'));
    assert.equal(await prisma.nativeAnalyticsInterval.count({ where: {
      deviceId: { in: completedPrivate.logicalDevices.map(row => row.id) } } }), 0);
    console.log('[logical-devices:integration] PASS actual new tenant commissioning HTTP create/advertise/review/finalize, two private siblings, exact retry, no analytics and no radio commands');
  } finally {
    await store.flushPersist();
    fs.rmSync(directory, { recursive: true });
  }
}
