import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const canonical = read('../src/app/api/v2/homes/[homeId]/tenant-device-context/route.ts');
const hub = read('../src/app/api/hub-agent/v2/tenant-device-context/route.ts');
const helper = read('../src/lib/tenantDeviceContext.ts');
const dashboard = read('../src/lib/tenantDeviceDashboard.ts');
const vercel = JSON.parse(read('../vercel.json'));

test('the selected Home is verified once per request on both tenant-context routes', () => {
  assert.equal((canonical.match(/requireCustomerSelectedHome\(/g) || []).length, 1);
  assert.equal((hub.match(/requireCustomerSelectedHome\(/g) || []).length, 1);
  assert.match(canonical, /readTenantDeviceContextForSelectedHome\(selected, homeId\)/);
  assert.match(hub, /readTenantDeviceContextForSelectedHome\(selected, homeId\)/);
});

test('the dashboard read is one RepeatableRead transaction with no serializable retries', () => {
  assert.match(helper, /isolationLevel: Prisma\.TransactionIsolationLevel\.RepeatableRead/);
  assert.match(helper, /timeout: 10000/);
  assert.doesNotMatch(helper, /serializableTransaction/);
  assert.doesNotMatch(canonical, /serializableTransaction/);
});

test('the dashboard reader performs reads only', () => {
  assert.doesNotMatch(dashboard, /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
  assert.doesNotMatch(dashboard, /\$executeRaw|\$queryRaw/);
});

test('Platform functions are pinned to London beside the database', () => {
  assert.deepEqual(vercel.regions, ['lhr1']);
});

test('both routes return the projection through the same serializer', () => {
  assert.match(canonical, /NextResponse\.json\(projection/);
  assert.match(hub, /NextResponse\.json\(projection/);
});
