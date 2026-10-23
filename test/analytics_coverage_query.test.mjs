import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url); const ts = require('typescript');
test('historical contributors do not hide missing currently eligible devices or change the denominator', async () => {
  const now = new Date('2026-10-23T11:00:00Z');
  const row = { deviceId: 'retired', areaId: 'a', bucketStart: new Date('2026-10-23T10:00:00Z'), coverageStartAt: new Date('2026-10-23T10:00:00Z'), coverageEndAt: new Date('2026-10-23T10:10:00Z'), closedAt: null, onSeconds: 600, offSeconds: 0, unknownSeconds: 0 };
  const prisma = {
    nativeDeviceUsageBucket: { findMany: async () => [row] },
    deviceAreaAssignment: { findMany: async () => [{ deviceId: 'retired', areaId: 'a', validFrom: row.bucketStart, validUntil: null }] },
    nativeDevice: { findMany: async () => [{ id: 'retired', originalName: 'old', overrideName: null, customerLabel: null, lifecycle: 'RETIRED' }],
      count: async ({ where }) => where.AND ? 0 : 1 },
    nativeAnalyticsUnallocated: { count: async () => 1 },
  };
  const dependencies = {
    './prisma': { prisma }, './nativeDisplayNames': { currentNativeDisplayName: original => original },
    './nativeAnalytics': { aggregateNativeUsage: () => [], parseAnalyticsWindow: () => ({ from: row.bucketStart, to: now, retentionStart: row.bucketStart }) },
    './nativeAnalyticsAccess': { metricCategory: () => 'LIGHT', parseUuidList: () => null, ANALYTICS_MAX_ROWS: 100 },
    './stage1Auth': { Stage1AuthError: class extends Error {} },
  };
  const compiled = ts.transpileModule(fs.readFileSync('src/lib/nativeAnalyticsQueries.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} }; new Function('require', 'module', 'exports', compiled)(name => dependencies[name] || require(name), module, module.exports);
  const response = await module.exports.readNativeUsageDetail('home', 'UTC', new URLSearchParams('metric=light'), now);
  assert.deepEqual(response.coverageStatus, { eligibleDeviceCount: 1, reportingDeviceCount: 0, missingDeviceCount: 1, unallocatedEventCount: 1 });
  assert.equal(response.selectedDeviceCount, 1, 'the historical contributor still belongs to the existing chart denominator');
});
