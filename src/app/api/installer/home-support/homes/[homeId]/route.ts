// Architecture: API boundary /installer/home-support/homes/[homeId]; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { AuditEventType, HomeContactType, Role } from '@prisma/client';
import { apiFailFromStatus } from '@/lib/apiError';
import { prisma } from '@/lib/prisma';
import { requireActiveUserAccess } from '@/lib/supportRequests';
import { getPolicyNotificationDeliveryStatus } from '@/lib/homeownerPolicyNotifications';
import { canManageHomeSupportQrRooms, canStartRemoveHome } from '@/lib/companyPortalAccess';
import { requireCompanyHomeSupportViewer } from '@/lib/companyPortalGuards';
import {
  computeHomeSupportStatus,
  getLatestHomeSupportRequest,
} from '@/lib/supportHomeAccess';
import { supportAuditSummary } from '@/lib/supportHomeAccessAudit';
import { hubRuntimeSummary } from '@/lib/dinodiaOsAreaProvisioning';

function parseHomeId(raw: string | undefined): number | null {
  if (!raw) return null;
  const num = Number(raw);
  return Number.isInteger(num) && num > 0 ? num : null;
}

const SUPPORT_AUDIT_TYPES: AuditEventType[] = [
  AuditEventType.SUPPORT_REQUEST_CREATED,
  AuditEventType.SUPPORT_REQUEST_APPROVED,
  AuditEventType.SUPPORT_REQUEST_REVOKED,
  AuditEventType.SUPPORT_HA_CODE_ISSUED,
  AuditEventType.SUPPORT_HA_CODE_CONSUMED,
  AuditEventType.SUPPORT_HA_SESSION_STARTED,
  AuditEventType.SUPPORT_HA_SESSION_FAILED,
  AuditEventType.SUPPORT_HA_SESSION_EXPIRED,
];

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ homeId: string }> }
) {
  const operator = await requireCompanyHomeSupportViewer(req);
  if (operator instanceof NextResponse) return operator;

  const { homeId: rawHomeId } = await context.params;
  const homeId = parseHomeId(rawHomeId);
  if (!homeId) {
    return apiFailFromStatus(400, 'Invalid home id.');
  }

  const home = await prisma.home.findUnique({
    where: { id: homeId },
    select: {
      id: true,
      createdAt: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      postcode: true,
      hubInstall: {
        select: {
          id: true,
          serial: true,
          lastSeenAt: true,
          createdAt: true,
          platformSyncEnabled: true,
          rotateEveryMinutes: true,
          graceMinutes: true,
          publishedHubTokenVersion: true,
          lastAckedHubTokenVersion: true,
          lastReportedLanBaseUrl: true,
          lastReportedLanBaseUrlAt: true,
          runtimeKind: true,
          runtimeVersion: true,
          runtimeCapabilities: true,
          runtimeCapabilitiesReportedAt: true,
          platformSyncIntervalMinutes: true,
        },
      },
      haConnection: {
        select: {
          id: true,
          cloudUrl: true,
          baseUrl: true,
        },
      },
      homeContacts: {
        where: { type: HomeContactType.PROPERTY_MANAGER },
        select: { email: true },
      },
      users: {
        select: {
          id: true,
          username: true,
          email: true,
          role: true,
          accessRules: { select: { area: true } },
          alexaEventToken: { select: { id: true } },
        },
      },
    },
  });

  if (!home || !home.haConnection) {
    return apiFailFromStatus(404, 'Home not found.');
  }

  const installedAt = home.hubInstall?.createdAt ?? home.createdAt;
  const propertyManagerEmail = home.homeContacts[0]?.email?.trim() ?? null;
  const homeowners = home.users
    .filter((u) => u.role === Role.ADMIN)
    .map((u) => ({ email: u.email ?? null, username: u.username }));
  const tenants = home.users
    .filter((u) => u.role === Role.TENANT)
    .map((u) => ({
      email: u.email ?? null,
      username: u.username,
      areas: u.accessRules.map((r) => r.area).filter(Boolean),
    }));
  const alexaEnabled = home.users
    .filter((u) => !!u.alexaEventToken)
    .map((u) => ({ email: u.email ?? null, username: u.username }));

  const remoteSupportAvailable =
    homeowners.some((owner) => !!owner.email) || Boolean(propertyManagerEmail);
  const remoteSupportUnavailableReason = remoteSupportAvailable
    ? null
    : 'No remote support available as no homeowner/property manager email address exists.';

  const homeSupportRequest = await getLatestHomeSupportRequest(prisma, homeId, operator.userId);
  const homeSupportStatus = homeSupportRequest
    ? computeHomeSupportStatus(homeSupportRequest, homeSupportRequest.approvalTokens)
    : 'NOT_FOUND';

  const homeownerPolicyEmail = await getPolicyNotificationDeliveryStatus(homeId);
  const users = await Promise.all(
    home.users.map(async (u) => {
      const userAccess = await requireActiveUserAccess({
        prisma,
        homeId,
        installerUserId: operator.userId,
        targetUserId: u.id,
      });

      return {
        id: u.id,
        username: u.username,
        email: u.email ?? null,
        role: u.role,
        supportRequest: userAccess.latest,
      };
    })
  );

  const hubStatus = home.hubInstall
    ? {
        serial: home.hubInstall.serial,
        lastSeenAt: home.hubInstall.lastSeenAt,
        platformSyncEnabled: home.hubInstall.platformSyncEnabled,
        rotateEveryMinutes: home.hubInstall.rotateEveryMinutes,
        graceMinutes: home.hubInstall.graceMinutes,
        publishedHubTokenVersion: home.hubInstall.publishedHubTokenVersion,
        lastAckedHubTokenVersion: home.hubInstall.lastAckedHubTokenVersion,
        lastReportedLanBaseUrl: home.hubInstall.lastReportedLanBaseUrl,
        lastReportedLanBaseUrlAt: home.hubInstall.lastReportedLanBaseUrlAt,
        runtime: hubRuntimeSummary(home.hubInstall),
        installedAt,
      }
    : { serial: null, lastSeenAt: null, runtime: null, installedAt };

  const [roomCount, auditEvents, activityIncidents, activityIncidentOpenCount, activityIncidentLatest] = await Promise.all([
    home.hubInstall ? prisma.room.count({ where: { hubInstallId: home.hubInstall.id } }) : Promise.resolve(0),
    prisma.auditEvent.findMany({
      where: {
        homeId,
        type: { in: SUPPORT_AUDIT_TYPES },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        type: true,
        createdAt: true,
        metadata: true,
      },
    }),
    home.hubInstall
      ? prisma.hubIncident.findMany({
          where: { homeId },
          orderBy: [{ state: 'asc' }, { lastObservedAt: 'desc' }],
          take: 50,
          select: {
            id: true,
            incidentId: true,
            revision: true,
            kind: true,
            severity: true,
            state: true,
            summary: true,
            detail: true,
            deviceId: true,
            deviceName: true,
            deviceProtocol: true,
            deviceModel: true,
            areaName: true,
            labels: true,
            details: true,
            firstObservedAt: true,
            lastObservedAt: true,
            openedAt: true,
            resolvedAt: true,
          },
        })
      : Promise.resolve([]),
    home.hubInstall
      ? prisma.hubIncident.count({ where: { homeId, state: 'open', severity: 'critical' } })
      : Promise.resolve(0),
    home.hubInstall
      ? prisma.hubIncident.findFirst({ where: { homeId }, orderBy: { lastObservedAt: 'desc' }, select: { lastObservedAt: true } })
      : Promise.resolve(null),
  ]);

  const relevantAuditEvents = homeSupportRequest
    ? auditEvents
        .filter((event) => {
          const supportRequestId =
            event.metadata && typeof event.metadata === 'object' && 'supportRequestId' in event.metadata
              ? (event.metadata as Record<string, unknown>).supportRequestId
              : null;
          return !supportRequestId || supportRequestId === homeSupportRequest.id;
        })
        .map((event) => ({
          id: event.id,
          type: event.type,
          createdAt: event.createdAt,
          summary: supportAuditSummary(event.type),
          metadata: event.metadata,
        }))
    : [];

  return NextResponse.json({
    ok: true,
    homeId: home.id,
    installedAt,
    homeAccessApproved: homeSupportStatus === 'APPROVED' || homeSupportStatus === 'ACTIVE',
    remoteSupportAvailable,
    remoteSupportUnavailableReason,
    homeSupportRequest: homeSupportRequest
      ? {
          requestId: homeSupportRequest.id,
          status: homeSupportStatus,
          approvedAt: homeSupportRequest.approvedAt,
          validUntil: homeSupportRequest.approvalValidUntil,
          expiresAt: homeSupportRequest.approvalTokens[0]?.expiresAt ?? null,
          approvedByName: homeSupportRequest.approvalRecipientName,
          approvedByEmail: homeSupportRequest.approvalRecipientEmail,
          codeExpiresAt: homeSupportRequest.haSecurityCodeExpiresAt,
          canConnect: homeSupportStatus === 'APPROVED',
          connectButtonLabel: 'Connect to the Dinodia hub',
          notificationStatus: homeSupportRequest.notificationSentAt
            ? 'SENT'
            : homeSupportRequest.notificationFailedAt
              ? 'FAILED'
              : homeSupportRequest.haSessionStartedAt
                ? 'PENDING'
                : 'NOT_STARTED',
          sessionFailureCode: homeSupportRequest.haSessionFailureCode,
          recentAuditEvents: relevantAuditEvents,
        }
      : null,
    hubStatus,
    activityIncidents: {
      openCount: activityIncidentOpenCount,
      latestObservedAt: activityIncidentLatest?.lastObservedAt.toISOString() ?? null,
      recent: activityIncidents.map((incident) => ({
        ...incident,
        firstObservedAt: incident.firstObservedAt.toISOString(),
        lastObservedAt: incident.lastObservedAt.toISOString(),
        openedAt: incident.openedAt?.toISOString() ?? null,
        resolvedAt: incident.resolvedAt?.toISOString() ?? null,
      })),
    },
    homeowners,
    tenants,
    alexaEnabled,
    users,
    propertyManagerEmail,
    homeownerPolicyEmail,
    canManageQrRooms: canManageHomeSupportQrRooms(operator.role),
    canRemoveHome: canStartRemoveHome(operator.role),
    removeHomePreviewAvailable: canStartRemoveHome(operator.role),
    roomCount,
    tenantCount: tenants.length,
    homeownerCount: homeowners.length,
    alexaLinkedCount: alexaEnabled.length,
  });
}
