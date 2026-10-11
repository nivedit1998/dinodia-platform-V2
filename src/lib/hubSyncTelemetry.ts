export type HubSyncOutboxReport = {
  queueDepth: number;
  gapDetected: boolean;
  criticalBacklog: boolean;
  telemetryPaused: boolean;
  droppedTelemetryCount: number;
  lastErrorCode: string | null;
};

export type CloudflareTunnelStatus = {
  schemaVersion: 1;
  recoveryState: 'READY' | 'RECONNECTING' | 'RECONNECT_REQUIRED' | 'HELD' | 'UNCONFIGURED' | 'UNAVAILABLE';
  childRunning: boolean;
  originState: 'HEALTHY' | 'UNHEALTHY' | 'UNKNOWN';
  edgeState: 'CONNECTED' | 'DISCONNECTED' | 'UNKNOWN';
  activeConnections: number | null;
  sampledAt: string | null;
  validUntil: string | null;
  identityGeneration: number | null;
};

export function parseCloudflareTunnelStatus(value: unknown): CloudflareTunnelStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const report = value as Record<string, unknown>;
  const expected = 'activeConnections,childRunning,edgeState,identityGeneration,originState,recoveryState,sampledAt,schemaVersion,validUntil';
  if (Object.keys(report).sort().join(',') !== expected || report.schemaVersion !== 1
    || !['READY', 'RECONNECTING', 'RECONNECT_REQUIRED', 'HELD', 'UNCONFIGURED', 'UNAVAILABLE'].includes(String(report.recoveryState))
    || typeof report.childRunning !== 'boolean'
    || !['HEALTHY', 'UNHEALTHY', 'UNKNOWN'].includes(String(report.originState))
    || !['CONNECTED', 'DISCONNECTED', 'UNKNOWN'].includes(String(report.edgeState))
    || !(report.activeConnections === null || Number.isSafeInteger(report.activeConnections) && Number(report.activeConnections) >= 0 && Number(report.activeConnections) <= 32)
    || !(report.identityGeneration === null || Number.isSafeInteger(report.identityGeneration) && Number(report.identityGeneration) > 0)) return null;
  if (report.sampledAt === null || report.validUntil === null) return report.sampledAt === null && report.validUntil === null ? report as CloudflareTunnelStatus : null;
  if (typeof report.sampledAt !== 'string' || typeof report.validUntil !== 'string') return null;
  const sampledAt = Date.parse(report.sampledAt);
  const validUntil = Date.parse(report.validUntil);
  if (!Number.isFinite(sampledAt) || !Number.isFinite(validUntil) || validUntil < sampledAt || validUntil - sampledAt > 420_000) return null;
  return report as CloudflareTunnelStatus;
}

/** Return only an unexpired report signed by the current manufacturing identity. */
export function currentCloudflareTunnelStatus(value: unknown, identityGeneration: number, nowMs = Date.now()): CloudflareTunnelStatus | null {
  const report = parseCloudflareTunnelStatus(value);
  if (!report || !Number.isSafeInteger(identityGeneration) || identityGeneration < 1
    || report.identityGeneration !== identityGeneration || !report.sampledAt || !report.validUntil) return null;
  const sampledAt = Date.parse(report.sampledAt);
  const validUntil = Date.parse(report.validUntil);
  if (sampledAt > nowMs + 30_000 || validUntil <= nowMs || validUntil < sampledAt) return null;
  if (report.recoveryState === 'READY' && (report.childRunning !== true || report.originState !== 'HEALTHY'
    || report.edgeState !== 'CONNECTED' || !report.activeConnections || report.activeConnections < 1)) return null;
  return report;
}

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
