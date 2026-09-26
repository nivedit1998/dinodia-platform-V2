import { runtimeTargetIsValid } from './runtimeTarget.mjs';

export const FOUNDATION_MIGRATION = '00000000000000_native_v2_lean_foundation';
export const FOUNDATION_MODEL_COUNT = 32;
export const STAGE1_MIGRATION = '20260922000000_stage1_security_authorities';
export const STAGE1_MODEL_COUNT = 40;
// Readiness is a release gate: the latest completed migration and checksum
// identify the exact checked-in candidate. R11 adds durable operator-mutation
// response/target binding without changing the 44 application-table count.
export const REQUIRED_MIGRATION = '20260925230000_r11_operator_mutation_idempotency';
export const REQUIRED_MODEL_COUNT = 44;
export const CANONICAL_PRODUCTION_ORIGIN = 'https://dinodia-platform-v2.vercel.app';
export function safeBuildId(): string {
  return process.env.FOUNDATION_SOURCE_FINGERPRINT?.slice(0, 16)
    || process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12)
    || 'local';
}
export function isRuntimeTargetValid(): boolean { return runtimeTargetIsValid(process.env); }
export function isCanonicalProductionOriginValid(): boolean {
  if (process.env.NODE_ENV !== 'production') return true;
  return String(process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '') === CANONICAL_PRODUCTION_ORIGIN;
}
