import { runtimeTargetIsValid } from './runtimeTarget.mjs';

export const FOUNDATION_MIGRATION = '00000000000000_native_v2_lean_foundation';
export const FOUNDATION_MODEL_COUNT = 32;
export const STAGE1_MIGRATION = '20260922000000_stage1_security_authorities';
export const STAGE1_MODEL_COUNT = 40;
// Readiness is a release gate, so it must identify the complete checked-in
// Stage 1 candidate rather than the first Stage 1 migration. The later R3/R4
// the R6 browser-attempt migration adds one durable application table, giving
// the native candidate 44 application tables, including the durable
// operator-browser attempt used by the R6 handoff protocol.
// application tables in total.
export const REQUIRED_MIGRATION = '20260925040000_r7_support_notifications';
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
