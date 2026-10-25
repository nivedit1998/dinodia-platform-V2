/** Owner-approved absolute Company Portal and assigned OS session bounds. */
export const EMPLOYEE_SESSION_SECONDS = 24 * 60 * 60;
export const OPERATOR_SESSION_SECONDS = 30 * 60;

/** Test-only clock seam; Production always follows the system clock. */
export function stage1NowMs(env: NodeJS.ProcessEnv = process.env): number {
  if (env.V2_ENVIRONMENT === 'test') {
    const candidate = Number(env.STAGE1_TEST_NOW_MS);
    if (Number.isFinite(candidate) && candidate > 0) return candidate;
  }
  return Date.now();
}
