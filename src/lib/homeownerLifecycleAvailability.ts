import { requireCustomerSelectedHome } from './customerSelectedHome';
import { Stage1AuthError } from './stage1Auth';

/**
 * Ownership transfer and full-home deregistration are sensitive global
 * capabilities. Keep them unavailable until the Stage 13 safety rehearsal
 * approves release. The disposable integration server has a separate,
 * explicit test-only switch; a test value can never enable a live V2 target.
 */
export function homeownerLifecycleMutationsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.V2_ENVIRONMENT === 'test') return env.STAGE9_LIFECYCLE_REHEARSAL === 'true';
  if (env.V2_ENVIRONMENT === 'production') return env.STAGE13_HOME_TRANSFER_RELEASED === 'true';
  return false;
}

export function homeownerDeregistrationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.V2_ENVIRONMENT === 'test') return env.STAGE13_DEREGISTRATION_REHEARSAL === 'true';
  if (env.V2_ENVIRONMENT === 'production') return env.STAGE13_HOME_DEREGISTRATION_RELEASED === 'true';
  return false;
}

// Use the shared Native V1 error vocabulary. A custom value here is silently
// normalized by the canonical error adapter and would misleadingly surface as
// HUB_UNAVAILABLE rather than a deliberately withheld lifecycle capability.
export const LIFECYCLE_REHEARSAL_REQUIRED = 'FEATURE_NOT_ENABLED';

export async function requireCurrentOwnerForDeferredLifecycle(request: Request, homeId: string) {
  const selected = await requireCustomerSelectedHome(request);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(homeId)
    || selected.homeId !== homeId || selected.role !== 'OWNER' || selected.credentialKind !== 'account_access') {
    throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'This Home lifecycle action is unavailable');
  }
  return selected;
}
