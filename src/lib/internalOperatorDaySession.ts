/** Temporary, explicitly opt-in Stage 1 policy. Stage 14 Section 7.2 removes this module and every consumer. */
export const INTERNAL_OPERATOR_DAY_SESSION_POLICY = 'STAGE1_INTERNAL_OPERATOR_DAY_SESSION' as const;
export const DEFAULT_EMPLOYEE_SESSION_SECONDS = 8 * 60 * 60;
export const INTERNAL_EMPLOYEE_SESSION_SECONDS = 24 * 60 * 60;
export const DEFAULT_OPERATOR_SESSION_SECONDS = 15 * 60;
export const INTERNAL_OPERATOR_SESSION_SECONDS = 24 * 60 * 60;

/** Missing, malformed, or any value other than the exact opt-in is disabled. */
export function internalOperatorDaySessionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STAGE1_INTERNAL_OPERATOR_DAY_SESSION === 'true';
}

/** Test-only deterministic clock. Production always uses the system clock. */
export function stage1NowMs(env: NodeJS.ProcessEnv = process.env): number {
  const injected = env.V2_ENVIRONMENT === 'test' ? env.STAGE1_TEST_NOW_MS : undefined;
  if (injected !== undefined && /^\d{1,16}$/.test(injected)) return Number(injected);
  return Date.now();
}
