export type HubSyncOutboxReport = {
  queueDepth: number;
  gapDetected: boolean;
  criticalBacklog: boolean;
  telemetryPaused: boolean;
  droppedTelemetryCount: number;
  lastErrorCode: string | null;
};

export function parseHubSyncOutboxReport(value: unknown): HubSyncOutboxReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const report = value as Record<string, unknown>;
  if (Object.keys(report).sort().join(',') !== 'criticalBacklog,droppedTelemetryCount,gapDetected,lastErrorCode,queueDepth,telemetryPaused'
    || !Number.isSafeInteger(report.queueDepth) || Number(report.queueDepth) < 0 || Number(report.queueDepth) > 100000
    || !Number.isSafeInteger(report.droppedTelemetryCount) || Number(report.droppedTelemetryCount) < 0 || Number(report.droppedTelemetryCount) > 1000000000
    || typeof report.gapDetected !== 'boolean' || typeof report.criticalBacklog !== 'boolean' || typeof report.telemetryPaused !== 'boolean'
    || !(report.lastErrorCode === null || typeof report.lastErrorCode === 'string' && /^[a-z0-9_.:-]{1,80}$/i.test(report.lastErrorCode))) return null;
  return report as HubSyncOutboxReport;
}
