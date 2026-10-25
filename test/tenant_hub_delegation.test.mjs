import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');

test('Hub tenant projections authenticate both the active machine and current selected tenant before canonical reads', () => {
  const context = read('../src/app/api/hub-agent/v2/tenant-device-context/route.ts');
  const automation = read('../src/app/api/hub-agent/v2/tenant-automations/route.ts');
  for (const [name, source] of [['tenant context', context], ['tenant automations', automation]]) {
    assert.match(source, /authenticateHub\(request, raw/);
    assert.match(source, /hub\.installation\.state !== 'ACTIVE'/);
    assert.match(source, /requireCustomerSelectedHome\(authorityRequest\)/);
    assert.match(source, /selected\.role !== 'TENANT'/);
    assert.match(source, /selected\.hubInstallationId !== hub\.installation\.id/);
    assert.match(source, /body\.schemaVersion !== 'dinodia\.v1'/);
    assert.match(source, /Cache-Control/);
    assert.doesNotMatch(source, /console\.(?:log|error|warn).*accountAccessToken/);
  }
  assert.match(context, /readTenantDeviceContextForSelectedHome\(selected, homeId\)/);
  assert.doesNotMatch(context, /readTenantDeviceContext\(/, 'the hub must not re-run the canonical GET');
  assert.match(automation, /listTenantAutomations\(authorityRequest\)/);
});

test('Hub tenant automation delegation is a fixed operation allowlist, never an arbitrary URL or generic proxy', () => {
  const source = read('../src/app/api/hub-agent/v2/tenant-automations/route.ts');
  for (const operation of ['list', 'create', 'update', 'enable', 'delete']) assert.match(source, new RegExp(`operation === '${operation}'`));
  assert.match(source, /updateTenantAutomation\(/);
  assert.match(source, /setTenantAutomationEnabled\(/);
  assert.match(source, /deleteTenantAutomation\(/);
  assert.match(source, /MAX_BODY_BYTES = 48 \* 1024/);
  assert.doesNotMatch(source, /fetch\s*\(/);
  assert.doesNotMatch(source, /new URL\(String\(body\./);
});

test('Hub tenant device intents reuse the fixed canonical preference and device mutation owners', () => {
  const source = read('../src/app/api/hub-agent/v2/tenant-device-intents/route.ts');
  assert.match(source, /saveHomePreference\(/);
  assert.match(source, /mutateTenantDevice\(/);
  assert.match(source, /removeTenantDevice\(/);
  assert.match(source, /operation === 'layout_save'/);
  assert.match(source, /operation === 'presentation'/);
  assert.match(source, /operation === 'remove'/);
  assert.match(source, /selected\.role !== 'TENANT'/);
  assert.match(source, /selected\.hubInstallationId !== hub\.installation\.id/);
  assert.doesNotMatch(source, /fetch\s*\(/);
});

test('Hub-delegated tenant routes are inventoried as machine-authenticated production surfaces', () => {
  const source = read('../test/stage1_route_inventory.mjs');
  for (const route of ['tenant-device-context', 'tenant-device-intents', 'tenant-automations']) {
    assert.match(source, new RegExp(`\\['POST', '/api/hub-agent/v2/${route}', 'machine'\\]`));
  }
});
