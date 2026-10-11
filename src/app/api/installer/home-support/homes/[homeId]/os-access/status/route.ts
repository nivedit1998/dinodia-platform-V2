import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireEmployee, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';
import { parseHubSyncOutboxReport } from '@/lib/hubSyncTelemetry';

export const dynamic = 'force-dynamic';

const HUB_STATUS_WORK_KINDS = new Set<string>([
  'INITIAL_HUB_INSTALLATION',
  'PERMANENT_DEVICE_INSTALLATION',
  'PHYSICAL_CONFIGURATION_CORRECTION',
  'HUB_RECOVERY',
]);

export async function GET(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const employee = await requireEmployee(request, ['CXO', 'SENIOR_OPERATIONS_MANAGER', 'INSTALLER']);
    const { homeId } = await context.params;
    const workflowId = String(new URL(request.url).searchParams.get('workflowId') ?? '').trim();
    if (!workflowId) throw new Stage1AuthError(400, 'workflow_required', 'An assigned workflow is required');
    const work = await prisma.companyOperationalWorkItem.findUnique({ where: { id: workflowId }, select: { kind: true, assignedEmployeeId: true, homeId: true, hubInstallationId: true, state: true } });
    if (!work || !HUB_STATUS_WORK_KINDS.has(work.kind) || work.state === 'CANCELLED'
      || work.assignedEmployeeId !== employee.id || work.homeId !== homeId || !work.hubInstallationId) {
      throw new Stage1AuthError(403, 'workflow_not_authorized', 'The assigned hub work is not available to this employee');
    }
    const [rows, hub, home, liveDeviceCount, openIncidentCount, activeAreaCount, replacementCandidates, otherActiveHubCount, activeMembershipCount] = await Promise.all([
      prisma.hubCredentialVersion.findMany({ where: { hubInstallationId: work.hubInstallationId, purpose: 'operator-credential' }, orderBy: { version: 'desc' }, select: { version: true, purpose: true, state: true, issuedAt: true, deliveredAt: true, acknowledgedAt: true, activatedAt: true, graceUntil: true, revokedAt: true, deliveryAttempts: true } }),
      prisma.hubInstallation.findFirst({ where: { id: work.hubInstallationId, homeId }, select: { id: true, state: true, lifecycleStatus: true, installationGeneration: true, cloudUrlVerifiedAt: true, remoteVerificationAt: true, lastSeenAt: true, lastSuccessfulSyncAt: true, syncAcceptedSequence: true, lastQueueDepth: true, lastSyncErrorCode: true, syncGapDetected: true, syncCriticalBacklog: true, syncTelemetryPaused: true, syncDroppedTelemetryCount: true, capabilitySummary: true, cloudConfigurationRevision: true, acknowledgedCloudRevision: true, updaterTrustState: true, updatePhase: true, updateAttemptId: true, updateReleaseId: true, activeReleaseVersion: true, updateResultCode: true, updateStatusAt: true, updateBusy: true } }),
      prisma.home.findUnique({ where: { id: homeId }, select: { lifecycle: true, installationStatus: true, activeHubInstallationId: true } }),
      prisma.nativeDevice.count({ where: { homeId, hubInstallationId: work.hubInstallationId, lifecycle: { notIn: ['RETIRED', 'REMOVED'] } } }),
      prisma.nativeDeviceOutageIncident.count({ where: { homeId, state: 'OPEN' } }),
      prisma.area.count({ where: { homeId, status: 'ACTIVE' } }),
      prisma.hubInstallation.findMany({ where: { homeId, id: { not: work.hubInstallationId }, lifecycleStatus: 'PENDING', state: { in: ['PROVISIONED', 'ACTIVE'] }, cloudUrlVerifiedAt: { not: null }, remoteVerificationAt: { not: null } }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, installationGeneration: true, createdAt: true } }),
      prisma.hubInstallation.count({ where: { homeId, id: { not: work.hubInstallationId }, lifecycleStatus: 'ACTIVE', state: { notIn: ['REVOKED', 'WAITING_FOR_CLEANUP'] } } }),
      prisma.homeMembership.count({ where: { homeId, status: 'ACTIVE' } }),
    ]);
    const now = Date.now();
    const lastSeenAt = hub?.lastSeenAt ?? null;
    const capabilities = hub?.capabilitySummary && typeof hub.capabilitySummary === 'object' && !Array.isArray(hub.capabilitySummary)
      ? hub.capabilitySummary as Record<string, unknown> : {};
    const syncOutboxReport = parseHubSyncOutboxReport(capabilities.nativeSyncOutbox);
    const hasSyncReport = Boolean(syncOutboxReport);
    const syncStatusState = !hasSyncReport ? 'UNKNOWN'
      : !lastSeenAt || now - lastSeenAt.getTime() > 420_000 ? 'STALE' : 'FRESH';
    const remoteVerified = Boolean(hub?.cloudUrlVerifiedAt && hub.remoteVerificationAt
      && hub.cloudUrlVerifiedAt.getTime() <= now && hub.remoteVerificationAt.getTime() <= now);
    const pendingCurrentHub = hub?.lifecycleStatus === 'PENDING' && hub.state === 'PROVISIONED'
      && home?.lifecycle === 'INSTALLING' && home.installationStatus === 'IN_PROGRESS'
      && home.activeHubInstallationId === null;
    const installationCanComplete = ['IN_PROGRESS', 'REOPENED'].includes(work.state)
      && activeMembershipCount === 0 && activeAreaCount > 0 && remoteVerified
      && otherActiveHubCount === 0 && pendingCurrentHub;
    const installationBlockReason = home?.installationStatus === 'COMPLETE' ? 'ALREADY_COMPLETE'
      : activeMembershipCount > 0 ? 'MEMBERSHIP_ALREADY_PRESENT'
        : activeAreaCount === 0 ? 'NO_ACTIVE_AREAS'
        : !remoteVerified ? 'REMOTE_VERIFICATION_REQUIRED'
          : otherActiveHubCount > 0 || !pendingCurrentHub ? 'HUB_NOT_CURRENT'
            : !['IN_PROGRESS', 'REOPENED'].includes(work.state) ? 'WORK_NOT_OPEN' : null;
    return NextResponse.json({
      ok: true, homeId, hubInstallationId: work.hubInstallationId, workflowState: work.state,
      installation: {
        lifecycle: home?.lifecycle ?? 'UNAVAILABLE', status: home?.installationStatus ?? 'UNAVAILABLE',
        activeAreaCount, canComplete: installationCanComplete, blockReason: installationBlockReason,
      },
      heartbeat: { lastSeenAt, state: lastSeenAt && now - lastSeenAt.getTime() <= 420_000 ? 'ONLINE' : 'OFFLINE', onlineThroughSeconds: 420 },
      sync: { lastSuccessfulSyncAt: hub?.lastSuccessfulSyncAt ?? null, acceptedSequence: Number(hub?.syncAcceptedSequence ?? 0), statusState: syncStatusState, statusReportedAt: hasSyncReport ? lastSeenAt?.toISOString() ?? null : null, queueDepth: hasSyncReport ? hub?.lastQueueDepth ?? null : null, errorCode: hasSyncReport ? hub?.lastSyncErrorCode ?? null : null, gapDetected: hasSyncReport ? hub?.syncGapDetected ?? null : null, criticalBacklog: hasSyncReport ? hub?.syncCriticalBacklog ?? null : null, telemetryPaused: hasSyncReport ? hub?.syncTelemetryPaused ?? null : null, droppedTelemetryCount: hasSyncReport ? hub?.syncDroppedTelemetryCount ?? null : null, cloudConfigurationRevision: hub?.cloudConfigurationRevision ?? 0, acknowledgedCloudRevision: hub?.acknowledgedCloudRevision ?? 0 },
      incidents: { openCount: openIncidentCount },
      replacement: {
        workflowHubIsCurrent: home?.activeHubInstallationId === work.hubInstallationId,
        currentHubLifecycle: hub?.lifecycleStatus ?? 'UNAVAILABLE',
        installationGeneration: hub?.installationGeneration ?? null,
        liveDeviceCount,
        replacementCandidates: replacementCandidates.map((candidate) => ({ id: candidate.id, generation: candidate.installationGeneration, addedAt: candidate.createdAt })),
        disposition: liveDeviceCount === 0 ? 'EMPTY_INVENTORY_PATH_ONLY' : 'PER_DEVICE_RECONCILIATION_REQUIRED',
        activationState: 'FEATURE_GATED_UNTIL_RECONCILIATION_AND_STAGE_13_REHEARSAL',
      },
      update: { mode: 'MANUAL', automaticInstallEnabled: false, trustState: hub?.updaterTrustState ?? 'UNAVAILABLE', phase: hub?.updatePhase ?? 'unavailable', attemptId: hub?.updateAttemptId ?? null, releaseId: hub?.updateReleaseId ?? null, activeReleaseVersion: hub?.activeReleaseVersion ?? null, resultCode: hub?.updateResultCode ?? null, updatedAt: hub?.updateStatusAt ?? null, busy: hub?.updateBusy ?? false },
      credentials: rows,
    }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
