import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), ts = require('typescript');

// This domain/constraint check is called ONLY by the maintained disposable Docker harness.
// It deliberately does not claim to prove the HTTP actor/session boundary.
export async function logicalDevicesDatabaseChecks({ prisma, fixture, osRoot, databaseUrl }) {
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
}
