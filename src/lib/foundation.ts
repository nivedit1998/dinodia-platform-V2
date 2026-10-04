import { runtimeTargetIsValid } from './runtimeTarget.mjs';
export { safeBuildId } from './buildIdentity.mjs';

export const FOUNDATION_MIGRATION = '00000000000000_native_v2_lean_foundation';
export const FOUNDATION_MODEL_COUNT = 32;
export const STAGE1_MIGRATION = '20260922000000_stage1_security_authorities';
export const STAGE1_MODEL_COUNT = 40;
// Readiness anchors this application generation to the completed Stage 3
// schema. Exact listed additive Stage 4/5 migrations are accepted so a
// schema-compatible prior application rollback remains healthy.
export const REQUIRED_MIGRATION = '20261003000000_native_v2_stage3_domain_schema';
export const REQUIRED_MODEL_COUNT = 65;
export const COMPATIBLE_ADDITIVE_MIGRATIONS: Readonly<Record<string, string>> = Object.freeze({
  '20261004150000_stage5_hub_sync_v2': '0043e8c7870c0afa7f4a5e5e4dd3d290387bc39514e4728f8c9a90fea8b33203',
  '20261004050000_stage4_customer_lan_tls_identity': '8b6f9a3ed68fb00805dbc54ba750fc339da3f375bb6c4a899e286c7b3844a5d1',
});
export const CANONICAL_PRODUCTION_ORIGIN = 'https://dinodia-platform-v2.vercel.app';
export function isRuntimeTargetValid(): boolean { return runtimeTargetIsValid(process.env); }
export function isCanonicalProductionOriginValid(): boolean {
  if (process.env.NODE_ENV !== 'production') return true;
  return String(process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '') === CANONICAL_PRODUCTION_ORIGIN;
}

export type CompletedMigration = { migration_name: string; checksum: string };

export function isSchemaReady(migrations: readonly CompletedMigration[], modelCount: number, expectedChecksum: string): boolean {
  if (!expectedChecksum) return false;
  const requiredIndex = migrations.findIndex((migration) => migration.migration_name === REQUIRED_MIGRATION);
  if (requiredIndex < 0 || migrations[requiredIndex].checksum !== expectedChecksum) return false;
  const newer = migrations.slice(0, requiredIndex);
  if (!newer.every((migration) =>
    COMPATIBLE_ADDITIVE_MIGRATIONS[migration.migration_name] === migration.checksum,
  )) return false;
  const hasStage5 = newer.some((migration) => migration.migration_name === '20261004150000_stage5_hub_sync_v2');
  if (hasStage5 && !newer.some((migration) => migration.migration_name === '20261004050000_stage4_customer_lan_tls_identity')) return false;
  return modelCount === REQUIRED_MODEL_COUNT + (hasStage5 ? 1 : 0);
}
