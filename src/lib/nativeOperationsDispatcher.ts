// The single shared native-operations dispatcher. Stage 1 lifecycle work is
// deliberately invoked here so credential reconciliation does not create a
// provider-specific cron or an AWS/Vercel duplicate worker.
import { reconcileOperatorCredentialLifecycle } from '@/lib/credentialLifecycle';
import { releaseExpiredStage1Reservations } from '@/lib/stage1ClaimReservation';
import { reconcileSupportAccessLifecycle } from '@/lib/supportAccessLifecycle';

export async function runNativeOperationsDispatcher(now = new Date()) {
  return {
    credentialLifecycle: await reconcileOperatorCredentialLifecycle(now),
    supportAccessLifecycle: await reconcileSupportAccessLifecycle(now),
    expiredStage1ClaimReservations: (await releaseExpiredStage1Reservations(now)).count,
  };
}
