import { runtimeTargetIsValid } from './runtimeTarget.mjs';
export { safeBuildId } from './buildIdentity.mjs';

export const FOUNDATION_MIGRATION = '00000000000000_native_v2_lean_foundation';
export const FOUNDATION_MODEL_COUNT = 32;
export const STAGE1_MIGRATION = '20260922000000_stage1_security_authorities';
export const STAGE1_MODEL_COUNT = 40;
// Readiness anchors this application generation to the completed Stage 3
// schema. Exact listed later-stage migrations are accepted by THIS candidate.
// The analytics interval index/trigger migration is not an old-Platform
// rollback guarantee; use the documented compatible forward-recovery path.
export const REQUIRED_MIGRATION = '20261003000000_native_v2_stage3_domain_schema';
export const REQUIRED_MODEL_COUNT = 65;
export const COMPATIBLE_ADDITIVE_MIGRATIONS: Readonly<Record<string, string>> = Object.freeze({
  '20261025140000_calendar_daily_analytics': '9d1c37dc41f45758e84c2505210300f93e66cc42fde53f80a067e29c933b5cf0',
  '20261025010000_logical_device_parents': 'eacd06daaf9eac7f77beffd233b9f553c61c632c5717e08df3ddda641584864c',
  '20261024103000_state_evidence_policy': '905d3c72ea537e6e015743e8ba7bcc85e7353c5868053244f58ff4b272ed40da',
  '20261023210000_room_qr_plaques': 'be22f4084ab317f1dae158427e866172105c2c45a5b7272662b6aa326c53da67',
  '20261023110000_category_analytics_intervals': 'b6a25359b7bfeb9a453ccc8ecc45fc4f32de63050ac85bd31821cae58e910d05',
  '20261006120000_stage6_invited_tenant_username_setup': '9b01d403fac2d37a59fc53be24c3f6296d3f0eaced2485530123b9e09946581c',
  '20261006150000_stage6_ownership_transfer_claim': '7ec2190ff0da90755807a07683f441a8dee9063aea24234c80f5167052634226',
  '20261006170000_stage6_prospective_room_access': '9477efc725c6f6a40b509842cd6a63f77eb7e1391ea4ce8a3fe87a933c2a8620',
  '20261006100000_stage6_apns_registration_and_notification_preferences': 'ccd425dec69f71f7a56d613de4990e56f79a45d217f823098a215b64c4fdd4db',
  '20261005130000_stage6_mobile_access_credentials': 'b69e02b571c4cdf3163c5d474b429fe5d4dee28ff9600a7804c70071179facc4',
  '20261005120000_stage6_customer_refresh_families': '434892c56b3aebca319292c6dda8db58d0a6e5d5b27129f593fdc3b674b3acef',
  '20261005070000_stage5_hub_incident_deadline': 'f6c5fed31a31184e4c2ae42a98be8a89fe1628415ae4cfc1bef61033ab95b44e',
  '20261005100000_stage5_incident_source_kind': '4b7763f5906566bba108196a4fa6ef37acb3623cb2dac33193b4ee836c6bec04',
  '20261004150000_stage5_hub_sync_v2': '0043e8c7870c0afa7f4a5e5e4dd3d290387bc39514e4728f8c9a90fea8b33203',
  '20261004050000_stage4_customer_lan_tls_identity': '8b6f9a3ed68fb00805dbc54ba750fc339da3f375bb6c4a899e286c7b3844a5d1',
  '20261006180000_stage8_commissioning_and_installation': '2fbf09e82d82c8eca490738e288fc8e78f2bfba313fb895811514aa97a699044',
  '20261008100000_stage9_deregister_redacted_support_guard': '91823c54a80f39036cff929b8ab6420495cb8d0138b4b789864318a6201e42ff',
  '20261008130000_stage10_analytics_maintenance_tasks': '6c651d5b697c6ca295ed21dc9c646db7be2673bbb95e0a05fa29009123f4da2e',
  '20261008150000_stage10_partial_usage_coverage': '85df08bf3f56a01edee6ebac68ac05d61375bed6ac0ffa28e052b791fbcf73b4',
  '20261009100000_stage11_automation_action_order': '4f0630406c83d5521a9921f9fab37d0b4d44798a8a5b43b9b61a79e8d956bee1',
  '20261009110000_stage12_alexa_oauth_scope': 'b3e1523009008bcd04b11172150e0d2112b881b03d8f3f137ca2ef81b9b94593',
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
  const hasMobileAccess = newer.some((migration) => migration.migration_name === '20261005130000_stage6_mobile_access_credentials');
  if (hasMobileAccess && !newer.some((migration) => migration.migration_name === '20261005120000_stage6_customer_refresh_families')) return false;
  if (newer.some((migration) => migration.migration_name === '20261006100000_stage6_apns_registration_and_notification_preferences')
    && (!hasMobileAccess || !newer.some((migration) => migration.migration_name === '20261005120000_stage6_customer_refresh_families'))) return false;
  const hasProspectiveRoomAccess = newer.some((migration) => migration.migration_name === '20261006170000_stage6_prospective_room_access');
  const hasStage5 = newer.some((migration) => migration.migration_name === '20261004150000_stage5_hub_sync_v2');
  if (hasStage5 && !newer.some((migration) => migration.migration_name === '20261004050000_stage4_customer_lan_tls_identity')) return false;
  const hasStage8 = newer.some((migration) => migration.migration_name === '20261006180000_stage8_commissioning_and_installation');
  if (hasStage8 && (!hasStage5 || !hasProspectiveRoomAccess || !hasMobileAccess)) return false;
  const hasStage12Alexa = newer.some((migration) => migration.migration_name === '20261009110000_stage12_alexa_oauth_scope');
  const hasAnalyticsIntervals = newer.some(migration => migration.migration_name === '20261023110000_category_analytics_intervals');
  const hasRoomPlaques = newer.some(migration => migration.migration_name === '20261023210000_room_qr_plaques');
  const hasLogicalDevices = newer.some(migration => migration.migration_name === '20261025010000_logical_device_parents');
  const hasCalendarDays = newer.some(migration => migration.migration_name === '20261025140000_calendar_daily_analytics');
  if (hasCalendarDays && !hasLogicalDevices) return false;
  if (hasLogicalDevices && (!hasStage8 || !hasAnalyticsIntervals || !hasRoomPlaques
    || !newer.some(migration => migration.migration_name === '20261024103000_state_evidence_policy'))) return false;
  if (newer.some(migration => migration.migration_name === '20261024103000_state_evidence_policy') && !hasAnalyticsIntervals) return false;
  return modelCount === REQUIRED_MODEL_COUNT + (hasStage5 ? 1 : 0) + (hasProspectiveRoomAccess ? 1 : 0) + (hasStage12Alexa ? 8 : 0) + (hasAnalyticsIntervals ? 2 : 0) + (hasRoomPlaques ? 2 : 0) + (hasLogicalDevices ? 1 : 0) + (hasCalendarDays ? 2 : 0);
}
