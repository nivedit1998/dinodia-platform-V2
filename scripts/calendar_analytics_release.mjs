/** Reviewed, scoped operator tool. Default is READ ONLY. No device traffic or
 * collection-policy activation. Credentials are read only from the maintained file. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { validateReadOnlyProductionTargets } from './read_only_production_inventory.mjs';

const [mode = 'check', hubId, expectedBuild] = process.argv.slice(2);
if (!['check', 'prepare', 'backfill', 'reads', 'prune', 'maintain'].includes(mode)
  || !/^[a-f0-9-]{36}$/i.test(hubId || '')) throw new Error('Usage: calendar_analytics_release.mjs MODE HUB_UUID EXPECTED_BUILD');
const source = process.cwd(), require = createRequire(import.meta.url);
const env = dotenv.parse(fs.readFileSync(path.resolve(source, '../../dinodia-platform-V2/.env.local')));
validateReadOnlyProductionTargets({ databaseUrl: env.DATABASE_URL, directUrl: env.DIRECT_URL,
  target: JSON.parse(fs.readFileSync('scripts/v2-target.json')) });
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (mode !== 'check' && (process.env.DINODIA_CALENDAR_RELEASE_APPROVED !== commit
  || execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()))
  throw new Error('A clean exact reviewed commit must be explicitly approved');
const db = new PrismaClient({ datasourceUrl: env.DIRECT_URL });
process.env.DINODIA_CALENDAR_ANALYTICS_ENABLED = 'true';
const cache = new Map(), ts = require('typescript');
function load(name) {
  const file = path.resolve('src/lib', name + '.ts');
  if (cache.has(file)) return cache.get(file);
  const loaded = { exports: {} }; cache.set(file, loaded.exports);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)(id => id.startsWith('.')
    ? load(path.relative(path.resolve('src/lib'), path.resolve(path.dirname(file), id))) : require(id), loaded, loaded.exports);
  cache.set(file, loaded.exports); return loaded.exports;
}
try {
  const before = await db.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const hub = await tx.hubInstallation.findUniqueOrThrow({ where: { id: hubId },
      select: { id: true, homeId: true, runtimeVersion: true, capabilitySummary: true, analyticsWriterEnabled: true,
        analyticsCollectionEnabled: true, lastSuccessfulSyncAt: true,
        home: { select: { activeHubInstallationId: true, timezone: true } } } });
    const tables = await tx.$queryRaw`SELECT to_regclass('public."NativeAnalyticsRetention"') IS NOT NULL AS ready`;
    const state = tables[0].ready ? await tx.nativeAnalyticsRetention.findUnique({ where: { hubInstallationId: hubId } }) : null;
    return { hub, state, schemaReady: tables[0].ready };
  });
  const { hub } = before;
  if (mode !== 'check') {
    if (!before.schemaReady || !expectedBuild || hub.capabilitySummary?.nativeDailyAnalyticsBuildId !== expectedBuild
      || hub.home?.activeHubInstallationId !== hubId || !hub.home.timezone
      || !hub.analyticsWriterEnabled || hub.capabilitySummary?.nativeDailyAnalyticsV1 !== true
      || !hub.lastSuccessfulSyncAt || Date.now() - hub.lastSuccessfulSyncAt.getTime() > 300000)
      throw new Error('Current compatible installed writer and recent authenticated sync are required');
    if (mode === 'prepare') await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "HubInstallation" WHERE id=${hubId}::uuid FOR UPDATE`;
      const current = await tx.hubInstallation.findUniqueOrThrow({ where: { id: hubId },
        select: { capabilitySummary: true, homeId: true, analyticsWriterEnabled: true } });
      if (current.capabilitySummary?.nativeDailyAnalyticsBuildId !== expectedBuild || current.homeId !== hub.homeId || !current.analyticsWriterEnabled)
        throw new Error('Writer changed during release');
      const existing = await tx.nativeAnalyticsRetention.findUnique({ where: { hubInstallationId: hubId } });
      if (existing) {
        if (existing.homeId !== hub.homeId || existing.timezone !== hub.home.timezone) throw new Error('Writer reconciliation required');
        if (existing.writerEnabled) return;
        throw new Error('Existing disabled writer requires explicit forward reconciliation');
      }
      const writerFrom = new Date(Math.ceil((Date.now() + 600000) / 3600000) * 3600000);
      await tx.nativeAnalyticsRetention.create({ data: { homeId: hub.homeId, hubInstallationId: hubId,
        timezone: hub.home.timezone, writerFrom, writerEnabled: true } });
      await tx.home.update({ where: { id: hub.homeId }, data: { managementRevision: { increment: 1 } } });
    });
    if (mode === 'backfill') {
      const { backfillLegacyDay } = load('dailyAnalyticsMaintenance');
      for (let n = 0; n < 8; n++) {
        const result = await db.$transaction(tx => backfillLegacyDay(tx, hubId, new Date()), { timeout: 20000 });
        if (result.completed || result.reason) break;
      }
    }
    if (mode === 'reads' || mode === 'prune') await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "hubInstallationId" FROM "NativeAnalyticsRetention" WHERE "hubInstallationId"=${hubId}::uuid FOR UPDATE`;
      const state = await tx.nativeAnalyticsRetention.findUniqueOrThrow({ where: { hubInstallationId: hubId } });
      if (!state.writerEnabled || !state.backfillVerifiedAt || !state.legacySealedThrough
        || state.backfillThrough?.getTime() !== state.writerFrom.getTime()) throw new Error('Verified sealed backfill is required');
      if (process.env.DINODIA_COMPATIBLE_TESTFLIGHT_AVAILABLE !== 'true') throw new Error('Verify compatible Owner Testing availability first');
      if (mode === 'prune' && !state.readsEnabled) throw new Error('Verify daily reads before enabling pruning');
      await tx.nativeAnalyticsRetention.update({ where: { hubInstallationId: hubId },
        data: mode === 'reads' ? { readsEnabled: true } : { pruningEnabled: true } });
    });
    if (mode === 'maintain') {
      const { compactDailyHistory } = load('dailyAnalyticsMaintenance');
      for (let n = 0; n < 8; n++) {
        const result = await db.$transaction(tx => compactDailyHistory(tx, hubId, new Date(), { retryRetained: n === 0 }), { timeout: 20000 });
        if (result.completed) break;
      }
    }
  }
  const state = before.schemaReady ? await db.nativeAnalyticsRetention.findUnique({ where: { hubInstallationId: hubId } }) : null;
  console.log(JSON.stringify({ mode, commit, schemaReady: before.schemaReady, runtimeVersion: hub.runtimeVersion,
    collectionEnabledUnchanged: hub.analyticsCollectionEnabled, state: state ? {
      writerFrom: state.writerFrom, writerEnabled: state.writerEnabled, readsEnabled: state.readsEnabled,
      pruningEnabled: state.pruningEnabled, sealed: !!state.legacySealedThrough, backfillVerified: !!state.backfillVerifiedAt,
      backfillThrough: state.backfillThrough, prunedThrough: state.prunedThrough, compactionCursor: state.compactionCursor,
      retainedDetailDays: state.retainedDetailDays, backlogReason: state.backlogReason } : null }, null, 2));
} finally { await db.$disconnect(); }
