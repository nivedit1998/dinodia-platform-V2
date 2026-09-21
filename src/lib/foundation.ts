import { runtimeTargetIsValid } from './runtimeTarget.mjs';

export const FOUNDATION_MIGRATION = '00000000000000_native_v2_lean_foundation';
export const FOUNDATION_MODEL_COUNT = 32;
export function safeBuildId(): string {
  return process.env.FOUNDATION_SOURCE_FINGERPRINT?.slice(0, 16)
    || process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12)
    || 'local';
}
export function isRuntimeTargetValid(): boolean { return runtimeTargetIsValid(process.env); }
