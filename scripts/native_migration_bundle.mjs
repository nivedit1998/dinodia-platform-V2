import crypto from 'node:crypto';

export const STAGE6_CUSTOMER_MIGRATIONS = Object.freeze([
  '20261005120000_stage6_customer_refresh_families',
  '20261005130000_stage6_mobile_access_credentials',
  '20261006100000_stage6_apns_registration_and_notification_preferences',
  '20261006120000_stage6_invited_tenant_username_setup',
  '20261006150000_stage6_ownership_transfer_claim',
  '20261006170000_stage6_prospective_room_access',
]);

export const STAGE8_COMMISSIONING_MIGRATION = '20261006180000_stage8_commissioning_and_installation';
export const STAGE9_DEREGISTRATION_GUARD_MIGRATION = '20261008100000_stage9_deregister_redacted_support_guard';
export const STAGE10_ANALYTICS_MAINTENANCE_MIGRATION = '20261008130000_stage10_analytics_maintenance_tasks';
export const STAGE10_PARTIAL_USAGE_COVERAGE_MIGRATION = '20261008150000_stage10_partial_usage_coverage';
export const STAGE11_AUTOMATION_ACTION_ORDER_MIGRATION = '20261009100000_stage11_automation_action_order';
export const STAGE12_ALEXA_OAUTH_SCOPE_MIGRATION = '20261009110000_stage12_alexa_oauth_scope';

export function migrationBundleIdentity(names, checksums) {
  const migrations = [...new Set(names)].sort().map((name) => {
    const sha256 = checksums.get(name);
    if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`missing reviewed checksum for migration ${name}`);
    return { name, sha256 };
  });
  if (!migrations.length) throw new Error('migration bundle cannot be empty');
  return { migrations, sha256: crypto.createHash('sha256').update(JSON.stringify(migrations)).digest('hex') };
}

export function unexpectedPendingMigrations(pendingNames, allowedNames) {
  const allowed = new Set(allowedNames);
  return [...new Set(pendingNames)].filter((name) => !allowed.has(name)).sort();
}
