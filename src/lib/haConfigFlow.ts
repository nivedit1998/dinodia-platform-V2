// Architecture: Shared platform helper src/lib/haConfigFlow.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { HaWsClient } from '@/lib/haWebSocket';
import type { HaConnectionLike } from '@/lib/homeAssistant';
import { callHomeAssistantAPI } from '@/lib/homeAssistant';
import { hashForLog, safeLog } from '@/lib/safeLogger';

export type HaConfigFlowStep = {
  type: string;
  flow_id?: string;
  handler?: string;
  step_id?: string;
  reason?: string;
  data_schema?: unknown;
  description_placeholders?: Record<string, unknown>;
  errors?: Record<string, string>;
  progress_action?: string;
};

export type HaConfigFlowProgress = {
  flow_id: string;
  handler: string;
  context: { source?: string | null } | null;
  title?: string | null;
  description?: string | null;
};

function isUnknownCommandError(err: unknown) {
  if (!err || typeof err !== 'object') return false;
  const obj = err as Record<string, unknown>;
  const error = obj.error && typeof obj.error === 'object' ? (obj.error as Record<string, unknown>) : null;
  return typeof error?.code === 'string' && error.code === 'unknown_command';
}

async function continueConfigFlowRest(
  ha: HaConnectionLike,
  flowId: string,
  userInput: Record<string, unknown>
): Promise<HaConfigFlowStep> {
  const body: Record<string, unknown> = {};
  if (userInput && Object.keys(userInput).length > 0) {
    body.user_input = userInput;
  }
  const step = await callHomeAssistantAPI<unknown>(
    ha,
    `/api/config/config_entries/flow/${encodeURIComponent(flowId)}`,
    {
      method: 'POST',
      body: JSON.stringify(body),
      timeoutMs: 12000,
    }
  );
  return sanitizeFlowStep(step);
}

async function startConfigFlowRest(
  ha: HaConnectionLike,
  handler: string,
  opts?: { showAdvanced?: boolean; context?: Record<string, unknown>; data?: Record<string, unknown> }
): Promise<HaConfigFlowStep> {
  const body: Record<string, unknown> = {
    handler,
    show_advanced_options: opts?.showAdvanced ?? false,
  };
  if (opts?.context && Object.keys(opts.context).length > 0) {
    body.context = opts.context;
  }
  if (opts?.data && Object.keys(opts.data).length > 0) {
    body.data = opts.data;
  }
  const step = await callHomeAssistantAPI<unknown>(ha, '/api/config/config_entries/flow', {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: 12000,
  });
  return sanitizeFlowStep(step);
}

async function abortConfigFlowRest(ha: HaConnectionLike, flowId: string): Promise<void> {
  await callHomeAssistantAPI<unknown>(
    ha,
    `/api/config/config_entries/flow/${encodeURIComponent(flowId)}`,
    { method: 'DELETE', timeoutMs: 12000 }
  );
}

export function sanitizeFlowStep(step: unknown): HaConfigFlowStep {
  if (!step || typeof step !== 'object') {
    return { type: 'unknown' };
  }
  const obj = step as Record<string, unknown>;
  return {
    type: typeof obj.type === 'string' ? obj.type : 'unknown',
    flow_id: typeof obj.flow_id === 'string' ? obj.flow_id : undefined,
    handler: typeof obj.handler === 'string' ? obj.handler : undefined,
    step_id: typeof obj.step_id === 'string' ? obj.step_id : undefined,
    reason: typeof obj.reason === 'string' ? obj.reason : undefined,
    data_schema: obj.data_schema,
    description_placeholders:
      obj.description_placeholders && typeof obj.description_placeholders === 'object'
        ? (obj.description_placeholders as Record<string, unknown>)
        : undefined,
    errors:
      obj.errors && typeof obj.errors === 'object'
        ? (obj.errors as Record<string, string>)
        : undefined,
    progress_action: typeof obj.progress_action === 'string' ? obj.progress_action : undefined,
  };
}

function sanitizeFlowProgress(item: unknown): HaConfigFlowProgress | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  const flow_id = typeof obj.flow_id === 'string' ? obj.flow_id : null;
  const handler = typeof obj.handler === 'string' ? obj.handler : null;
  const context =
    obj.context && typeof obj.context === 'object'
      ? { source: typeof (obj.context as Record<string, unknown>).source === 'string'
            ? ((obj.context as Record<string, unknown>).source as string)
            : null }
      : null;
  if (!flow_id || !handler) return null;
  return {
    flow_id,
    handler,
    context,
    title: typeof obj.title === 'string' ? obj.title : null,
    description: typeof obj.description === 'string' ? obj.description : null,
  };
}

export async function startConfigFlow(
  ha: HaConnectionLike,
  handler: string,
  opts?: { showAdvanced?: boolean; context?: Record<string, unknown>; data?: Record<string, unknown> }
): Promise<HaConfigFlowStep> {
  const client = await HaWsClient.connect(ha);
  try {
    const payload: Record<string, unknown> = {
      handler,
      show_advanced_options: opts?.showAdvanced ?? false,
    };
    if (opts?.context && Object.keys(opts.context).length > 0) {
      payload.context = opts.context;
    }
    if (opts?.data && Object.keys(opts.data).length > 0) {
      payload.data = opts.data;
    }
    const step = await client.call('config_entries/flow/init', payload);
    return sanitizeFlowStep(step);
  } catch (err) {
    if (isUnknownCommandError(err)) {
      return startConfigFlowRest(ha, handler, opts);
    }
    throw err;
  } finally {
    client.close();
  }
}

export async function continueConfigFlow(
  ha: HaConnectionLike,
  flowId: string,
  userInput: Record<string, unknown> = {}
): Promise<HaConfigFlowStep> {
  const client = await HaWsClient.connect(ha);
  try {
    const payload: Record<string, unknown> = { flow_id: flowId };
    if (userInput && Object.keys(userInput).length > 0) {
      payload.user_input = userInput;
    }
    const step = await client.call('config_entries/flow/configure', payload);
    return sanitizeFlowStep(step);
  } catch (err) {
    if (isUnknownCommandError(err)) {
      return continueConfigFlowRest(ha, flowId, userInput);
    }
    throw err;
  } finally {
    client.close();
  }
}

export async function abortConfigFlow(ha: HaConnectionLike, flowId: string): Promise<void> {
  const client = await HaWsClient.connect(ha);
  try {
    await client.call('config_entries/flow/abort', {
      flow_id: flowId,
    });
  } catch (err) {
    if (isUnknownCommandError(err)) {
      try {
        await abortConfigFlowRest(ha, flowId);
        return;
      } catch (restErr) {
        safeLog('warn', '[haConfigFlow] REST abort failed (continuing)', {
          flowIdHash: hashForLog(flowId),
          restErr,
        });
      }
    }
    safeLog('warn', '[haConfigFlow] Failed to abort flow', {
      flowIdHash: hashForLog(flowId),
      err,
    });
  } finally {
    client.close();
  }
}

export async function listConfigFlowProgress(
  ha: HaConnectionLike
): Promise<HaConfigFlowProgress[]> {
  const client = await HaWsClient.connect(ha);
  try {
    const items = await client.call<unknown[]>('config_entries/flow/progress');
    const flows = Array.isArray(items) ? items : [];
    return flows
      .map((item) => sanitizeFlowProgress(item))
      .filter((flow): flow is HaConfigFlowProgress => Boolean(flow));
  } finally {
    client.close();
  }
}

type HaConfigEntryListItem = {
  entry_id?: string;
  domain?: string;
};

async function listConfigEntries(ha: HaConnectionLike): Promise<HaConfigEntryListItem[]> {
  const client = await HaWsClient.connect(ha);
  try {
    const items = await client.call<HaConfigEntryListItem[]>('config/config_entries/entry/list');
    return Array.isArray(items) ? items : [];
  } catch (err) {
    if (isUnknownCommandError(err)) {
      return [];
    }
    throw err;
  } finally {
    client.close();
  }
}

export async function ensureDinodiaRemoteManagerBootstrap(
  ha: HaConnectionLike
): Promise<void> {
  const existing = await listConfigEntries(ha).catch(() => []);
  if (
    existing.some(
      (entry) => typeof entry?.domain === 'string' && entry.domain.trim() === 'dinodia_remote_manager'
    )
  ) {
    return;
  }

  let step = await startConfigFlow(ha, 'dinodia_remote_manager', {
    context: { source: 'service' },
    data: {
      entry_kind: 'bootstrap',
      bootstrap: true,
      source: 'dinodia_auto_bootstrap',
      created_by: 'dinodia_app',
      managed_by_dinodia_app: true,
    },
  });

  if (step.type === 'form' && step.flow_id) {
    step = await continueConfigFlow(ha, step.flow_id, {});
  }

  if (step.type === 'create_entry') return;
  if (step.type === 'abort' && (step.reason === 'bootstrap_ready' || step.reason === 'already_configured')) {
    return;
  }
  throw new Error(`Dinodia Remote Manager bootstrap failed: ${step.type}${step.reason ? `:${step.reason}` : ''}`);
}
