import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireEmployee, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const employee = await requireEmployee(request, ['CXO', 'SENIOR_OPERATIONS_MANAGER', 'INSTALLER']);
    const { homeId } = await context.params;
    const workflowId = String(new URL(request.url).searchParams.get('workflowId') ?? '').trim();
    if (!workflowId) throw new Stage1AuthError(400, 'workflow_required', 'An assigned workflow is required');
    const work = await prisma.companyOperationalWorkItem.findUnique({ where: { id: workflowId }, select: { assignedEmployeeId: true, homeId: true, hubInstallationId: true, state: true } });
    if (!work || work.assignedEmployeeId !== employee.id || work.homeId !== homeId || !work.hubInstallationId) throw new Stage1AuthError(403, 'workflow_not_authorized', 'The workflow is not available to this employee');
    const [rows, hub, home, liveDeviceCount, openIncidentCount, replacementCandidates] = await Promise.all([
      prisma.hubCredentialVersion.findMany({ where: { hubInstallationId: work.hubInstallationId, purpose: 'operator-credential' }, orderBy: { version: 'desc' }, select: { version: true, purpose: true, state: true, issuedAt: true, deliveredAt: true, acknowledgedAt: true, activatedAt: true, graceUntil: true, revokedAt: true, deliveryAttempts: true } }),
      prisma.hubInstallation.findFirst({ where: { id: work.hubInstallationId, homeId }, select: { id: true, lifecycleStatus: true, installationGeneration: true, lastSeenAt: true, lastSuccessfulSyncAt: true, syncAcceptedSequence: true, lastQueueDepth: true, lastSyncErrorCode: true, syncGapDetected: true, syncCriticalBacklog: true, syncTelemetryPaused: true, syncDroppedTelemetryCount: true, cloudConfigurationRevision: true, acknowledgedCloudRevision: true, updaterTrustState: true, updatePhase: true, updateAttemptId: true, updateReleaseId: true, activeReleaseVersion: true, updateResultCode: true, updateStatusAt: true, updateBusy: true } }),
      prisma.home.findUnique({ where: { id: homeId }, select: { activeHubInstallationId: true } }),
      prisma.nativeDevice.count({ where: { homeId, hubInstallationId: work.hubInstallationId, lifecycle: { notIn: ['RETIRED', 'REMOVED'] } } }),
      prisma.nativeDeviceOutageIncident.count({ where: { homeId, state: 'OPEN' } }),
      prisma.hubInstallation.findMany({ where: { homeId, id: { not: work.hubInstallationId }, lifecycleStatus: 'PENDING', state: { in: ['PROVISIONED', 'ACTIVE'] }, cloudUrlVerifiedAt: { not: null }, remoteVerificationAt: { not: null } }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, installationGeneration: true, createdAt: true } }),
    ]);
    const now = Date.now();
    const lastSeenAt = hub?.lastSeenAt ?? null;
    return NextResponse.json({
      ok: true, homeId, hubInstallationId: work.hubInstallationId, workflowState: work.state,
      heartbeat: { lastSeenAt, state: lastSeenAt && now - lastSeenAt.getTime() <= 420_000 ? 'ONLINE' : 'OFFLINE', onlineThroughSeconds: 420 },
      sync: { lastSuccessfulSyncAt: hub?.lastSuccessfulSyncAt ?? null, acceptedSequence: Number(hub?.syncAcceptedSequence ?? 0), queueDepth: hub?.lastQueueDepth ?? 0, errorCode: hub?.lastSyncErrorCode ?? null, gapDetected: hub?.syncGapDetected ?? false, criticalBacklog: hub?.syncCriticalBacklog ?? false, telemetryPaused: hub?.syncTelemetryPaused ?? false, droppedTelemetryCount: hub?.syncDroppedTelemetryCount ?? 0, cloudConfigurationRevision: hub?.cloudConfigurationRevision ?? 0, acknowledgedCloudRevision: hub?.acknowledgedCloudRevision ?? 0 },
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
