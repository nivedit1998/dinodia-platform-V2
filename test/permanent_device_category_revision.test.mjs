import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');

function loadTypeScript(relative, overrides = {}) {
  const output = ts.transpileModule(readFileSync(path.resolve(relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) => Object.hasOwn(overrides, specifier) ? overrides[specifier] : require(specifier);
  new Function('require', 'module', 'exports', output)(localRequire, module, module.exports);
  return module.exports;
}

function categoryRouteHarness({ homeRevision = 8, inventoryRevision = 4 } = {}) {
  const ids = {
    home: '11111111-1111-4111-8111-111111111111', hub: '22222222-2222-4222-8222-222222222222',
    employee: '33333333-3333-4333-8333-333333333333', employeeSession: '44444444-4444-4444-8444-444444444444',
    handoff: '55555555-5555-4555-8555-555555555555', work: '66666666-6666-4666-8666-666666666666',
    request: '77777777-7777-4777-8777-777777777777', operation: '88888888-8888-4888-8888-888888888888',
  };
  const issuedAt = Date.now() - 20_000;
  const handoff = { id: ids.handoff, createdAt: new Date(issuedAt - 1000), scope: {
    scopes: ['os:admin'], operatorIssuedAt: issuedAt, operatorExpiresAt: issuedAt + 30 * 60_000,
    employeeSessionId: ids.employeeSession, operatorJti: 'operator-jti-12345678', workRevision: 5,
    identityGeneration: 3, serialNumber: 'DIN-HUB-TEST-1',
  } };
  const device = { id: 'permanent-device-db-id', osDeviceId: 'zigbee:permanent-radiator', analyticsCategory: 'NONE', inventoryRevision,
    assignments: [{ areaId: 'active-area-id' }] };
  const writes = {};
  const tx = {
    companyEmployeeAccount: { findFirst: async () => ({ id: ids.employee, role: 'CXO' }) },
    employeeSession: { findFirst: async () => ({ id: ids.employeeSession, employeeId: ids.employee, status: 'ACTIVE',
      createdAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 20 * 60 * 60_000) }) },
    operatorHandoff: { findFirst: async () => handoff },
    companyOperationalWorkItem: { findFirst: async () => ({ id: ids.work, homeId: ids.home, hubInstallationId: ids.hub,
      assignedEmployeeId: ids.employee, state: 'IN_PROGRESS', workRevision: 5, permanentInstallationRequestId: ids.request }) },
    permanentDeviceInstallationRequest: { findFirst: async () => ({ id: ids.request }) },
    home: {
      findFirst: async () => ({ id: ids.home, managementRevision: homeRevision }),
      updateMany: async (input) => { writes.home = input; return { count: 1 }; },
    },
    nativeDevice: {
      findFirst: async () => device,
      updateMany: async (input) => { writes.device = input; return { count: 1 }; },
    },
    idempotencyRecord: {
      findUnique: async () => null,
      create: async (input) => { writes.idempotency = input; },
    },
    auditEvent: { create: async (input) => { writes.audit = input; } },
  };
  const prisma = { $transaction: async (callback) => callback(tx) };
  class Stage1AuthError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
  }
  const route = loadTypeScript('src/app/api/hub-agent/v2/permanent-device-analytics-category/route.ts', {
    'next/server': { NextResponse: { json: (body, init = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } }) } },
    '@/lib/prisma': { prisma },
    '@/lib/stage1HubAuth': { authenticateHub: async (_request, raw) => ({
      installation: { id: ids.hub, homeId: ids.home }, identity: { identityGeneration: 3, serialNumber: 'DIN-HUB-TEST-1' }, body: JSON.parse(raw),
    }) },
    '@/lib/stage1Crypto': { sha256: (value) => `digest:${value}` },
    '@/lib/stage1Auth': { Stage1AuthError },
    '@/lib/stage1SessionPolicy': { EMPLOYEE_SESSION_SECONDS: 24 * 60 * 60, OPERATOR_SESSION_SECONDS: 30 * 60 },
  });
  const body = { serial: 'DIN-HUB-TEST-1', identityGeneration: 3, homeId: ids.home, hubInstallationId: ids.hub,
    accessScope: 'os:admin', employeeId: ids.employee, employeeSessionId: ids.employeeSession, operatorHandoffId: ids.handoff,
    operatorJti: 'operator-jti-12345678', workItemId: ids.work, workRevision: 5, osDeviceId: device.osDeviceId,
    expectedManagementRevision: 7, expectedInventoryRevision: 4, expectedAnalyticsCategory: 'NONE', analyticsCategory: 'RADIATOR', operationId: ids.operation };
  const request = new Request('https://platform.test/api/hub-agent/v2/permanent-device-analytics-category', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { route, request, writes };
}

test('a current device category update tolerates unrelated Home revision changes and advances from the latest revision', async () => {
  const { route, request, writes } = categoryRouteHarness({ homeRevision: 8 });
  const response = await route.POST(request);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.analyticsCategory, 'RADIATOR');
  assert.equal(body.managementRevision, 9);
  assert.equal(body.inventoryRevision, 5);
  assert.equal(writes.home.where.managementRevision, 8, 'the atomic Home update uses its current revision, not the stale dashboard revision');
  assert.equal(writes.home.data.managementRevision.increment, 1);
  assert.equal(writes.device.where.inventoryRevision, 4, 'the reviewed device revision remains a strict compare-and-swap');
});

test('a device category update still rejects a stale device inventory revision', async () => {
  const { route, request, writes } = categoryRouteHarness({ homeRevision: 8, inventoryRevision: 5 });
  const response = await route.POST(request);
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.error.code, 'analytics_category_revision_conflict');
  assert.equal(writes.home, undefined, 'a stale device must not advance the Home revision');
  assert.equal(writes.device, undefined, 'a stale device must not be changed');
});
