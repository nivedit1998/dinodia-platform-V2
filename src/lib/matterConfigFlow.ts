// Architecture: Shared platform helper src/lib/matterConfigFlow.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import {
  abortConfigFlow,
  continueConfigFlow,
  HaConfigFlowStep,
  startConfigFlow,
} from '@/lib/haConfigFlow';
import type { HaConnectionLike } from '@/lib/homeAssistant';

export type { HaConfigFlowStep } from '@/lib/haConfigFlow';

export async function startMatterConfigFlow(ha: HaConnectionLike): Promise<HaConfigFlowStep> {
  return startConfigFlow(ha, 'matter', { showAdvanced: true });
}

export async function continueMatterConfigFlow(
  ha: HaConnectionLike,
  flowId: string,
  userInput: Record<string, unknown>
): Promise<HaConfigFlowStep> {
  return continueConfigFlow(ha, flowId, userInput);
}

export async function abortMatterConfigFlow(ha: HaConnectionLike, flowId: string): Promise<void> {
  await abortConfigFlow(ha, flowId);
}
