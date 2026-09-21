// Architecture: Shared platform helper src/lib/adminDashboardBootstrap.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { safeLog } from '@/lib/safeLogger';
import { getAdminAreaInventory } from '@/lib/adminConfigurationInventory';
import { buildAdminMonitoringSelectorInventory } from '@/lib/adminMonitoringSelectorInventory';
import { buildAdminMonitoringSummary } from '@/lib/adminMonitoringSummary';
import { buildAdminHeatingDashboard } from '@/lib/adminHeatingDashboard';
import { buildAdminMonitoringEnergyByEntity } from '@/lib/adminMonitoringEnergyByEntity';
import { buildAdminMonitoringHubStatus } from '@/lib/adminMonitoringHubStatus';
import { buildAdminElectricLightDashboard } from '@/lib/adminElectricLightDashboard';

type SectionResult<T> = {
  ok: boolean;
  payload?: T;
  error?: string;
  timedOut?: boolean;
};

const SECTION_TIMEOUT_MS = {
  areaInventory: 15_000,
  selectors: 20_000,
  summary: 25_000,
  electric: 25_000,
  lighting: 25_000,
  hubStatus: 20_000,
  heating: 45_000,
} as const;

async function withSoftTimeout<T>(
  promise: Promise<SectionResult<T>>,
  timeoutMs: number,
  errorMessage: string
): Promise<SectionResult<T>> {
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<SectionResult<T>>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({ ok: false, timedOut: true, error: errorMessage });
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function timedSection<T>(
  section: string,
  timeoutMs: number,
  task: () => Promise<T>
) {
  const startedAt = Date.now();
  const result = await withSoftTimeout(
    task()
      .then((payload) => ({ ok: true, payload }))
      .catch((error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : `${section} failed to load.`,
      })),
    timeoutMs,
    `${section} is taking too long to load right now.`
  );
  return {
    result,
    durationMs: Date.now() - startedAt,
  };
}

export async function buildAdminDashboardBootstrap(args: {
  homeId: number;
  haConnectionId: number;
}) {
  const { homeId, haConnectionId } = args;
  const startedAt = Date.now();

  const allTimeDailyParams = new URLSearchParams([
    ['days', 'all'],
    ['bucket', 'daily'],
  ]);

  const summaryPromise = timedSection('summary', SECTION_TIMEOUT_MS.summary, () =>
    buildAdminMonitoringSummary({ haConnectionId, searchParams: new URLSearchParams(allTimeDailyParams) })
  );
  const heatingPromise = timedSection('heating', SECTION_TIMEOUT_MS.heating, () =>
    buildAdminHeatingDashboard({ haConnectionId, searchParams: new URLSearchParams(allTimeDailyParams) })
  );
  const electricPromise = timedSection('electric', SECTION_TIMEOUT_MS.electric, () =>
    buildAdminMonitoringEnergyByEntity({
      haConnectionId,
      searchParams: new URLSearchParams([
        ['days', 'all'],
        ['bucket', 'daily'],
        ['excludeLabels', 'Boiler'],
        ['excludeLabels', 'Radiator'],
      ]),
    })
  );
  const lightingPromise = timedSection('lighting', SECTION_TIMEOUT_MS.lighting, () =>
    buildAdminElectricLightDashboard({ haConnectionId, searchParams: new URLSearchParams(allTimeDailyParams) })
  );
  const hubStatusPromise = timedSection('hubStatus', SECTION_TIMEOUT_MS.hubStatus, () =>
    buildAdminMonitoringHubStatus({
      haConnectionId,
      searchParams: new URLSearchParams([['days', 'all']]),
    })
  );
  const areaInventoryPromise = timedSection('areaInventory', SECTION_TIMEOUT_MS.areaInventory, () =>
    getAdminAreaInventory({ homeId, haConnectionId })
  );
  const selectorsPromise = timedSection('selectors', SECTION_TIMEOUT_MS.selectors, () =>
    buildAdminMonitoringSelectorInventory({ haConnectionId })
  );

  const [summary, heating, electric, lighting, hubStatus, areaInventory, selectors] = await Promise.all([
    summaryPromise,
    heatingPromise,
    electricPromise,
    lightingPromise,
    hubStatusPromise,
    areaInventoryPromise,
    selectorsPromise,
  ]);

  safeLog('info', '[adminDashboardBootstrap] completed', {
    homeId,
    haConnectionId,
    totalDurationMs: Date.now() - startedAt,
    summaryMs: summary.durationMs,
    heatingMs: heating.durationMs,
    electricMs: electric.durationMs,
    lightingMs: lighting.durationMs,
    hubStatusMs: hubStatus.durationMs,
    areaInventoryMs: areaInventory.durationMs,
    selectorsMs: selectors.durationMs,
    summaryState: summary.result.timedOut ? 'timedOut' : summary.result.ok ? 'success' : 'failed',
    heatingState: heating.result.timedOut ? 'timedOut' : heating.result.ok ? 'success' : 'failed',
    electricState: electric.result.timedOut ? 'timedOut' : electric.result.ok ? 'success' : 'failed',
    lightingState: lighting.result.timedOut ? 'timedOut' : lighting.result.ok ? 'success' : 'failed',
    hubStatusState: hubStatus.result.timedOut ? 'timedOut' : hubStatus.result.ok ? 'success' : 'failed',
    areaInventoryState: areaInventory.result.timedOut ? 'timedOut' : areaInventory.result.ok ? 'success' : 'failed',
    selectorsState: selectors.result.timedOut ? 'timedOut' : selectors.result.ok ? 'success' : 'failed',
  });

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    defaultTab: 'gas' as const,
    preload: {
      mode: 'allTimeDaily' as const,
      days: 'all' as const,
      bucket: 'daily' as const,
    },
    areaInventory: areaInventory.result.ok
      ? {
          ok: true,
          ...(areaInventory.result.payload ?? {}),
        }
      : areaInventory.result,
    selectors: selectors.result.ok
      ? {
          ok: true,
          ...(selectors.result.payload ?? {}),
        }
      : selectors.result,
    summary: summary.result.ok
      ? { ok: true, payload: summary.result.payload }
      : summary.result,
    heating: heating.result.ok
      ? { ok: true, payload: heating.result.payload }
      : heating.result,
    electric: electric.result.ok
      ? { ok: true, payload: electric.result.payload }
      : electric.result,
    lighting: lighting.result.ok
      ? { ok: true, payload: lighting.result.payload }
      : lighting.result,
    hubStatus: hubStatus.result.ok
      ? { ok: true, payload: hubStatus.result.payload }
      : hubStatus.result,
  };
}
