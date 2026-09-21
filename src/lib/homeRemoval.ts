// Architecture: Shared platform helper src/lib/homeRemoval.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import 'server-only';

import { AuditEventType, Prisma, Role } from '@prisma/client';
import { captureAlexaEndpointSnapshot, pushAlexaDiscoveryDiff } from '@/lib/alexaDiscoverySync';
import {
  HaCleanupConnectionError,
  MAX_REGISTRY_REMOVALS,
  logoutHaCloud,
  performTenantOwnedHaCleanup,
  type HaCleanupSummary,
} from '@/lib/haCleanup';
import { callHaService, type HaConnectionLike } from '@/lib/homeAssistant';
import { prisma } from '@/lib/prisma';
import {
  REMOTE_BINDING_READ_TIMEOUT_MS,
  REMOTE_MANAGER_DOMAIN,
  SERVICE_LIST_BINDINGS,
} from '@/lib/remoteManager';
import { resolveHaLongLivedToken } from '@/lib/haSecrets';
import { getNonInstallerAutomationIdsForHome, getNonInstallerOwnedTargetsForHome } from '@/lib/tenantOwnership';
import { removeTriggerBindingsForTenant } from '@/lib/triggerDevices';

export const REMOVE_HOME_CHECKLIST_KEYS = [
  'ha_devices_removed',
  'remote_manager_bindings_removed',
  'remote_manager_config_entries_removed',
  'room_qr_access_cleared',
  'hub_agent_stopped',
  'hub_agent_config_cleared',
  'hub_agent_data_files_cleared',
  'hub_agent_reconnect_verified_off',
  'cloudflare_addon_stopped',
  'cloudflare_tunnel_deleted',
  'cloudflare_routes_removed',
  'cloudflare_addon_state_cleared',
  'cloudflare_no_stale_route_verified',
  'hub_disconnected',
  'hub_warehouse_ready',
  'final_completed',
] as const;

export type RemoveHomeChecklistKey = (typeof REMOVE_HOME_CHECKLIST_KEYS)[number];
export type RemoveHomeChecklistState = Record<RemoveHomeChecklistKey, boolean>;

export type RemoveHomePreview = {
  ok: true;
  alreadyRemoved?: boolean;
  partiallyRemoved?: boolean;
  homeId: number;
  serial: string | null;
  counts: {
    homeowners: number;
    tenants: number;
    rooms: number;
    roomAccessRequests: number;
    supportRequests: number;
    pendingOnboardings: number;
    alexaLinkedUsers: number;
    devices: number;
    areaDisplayOverrides: number;
    labelDisplayOverrides: number;
    tenantDeviceDisplayOverrides: number;
    tenantVirtualAreas: number;
    monitoringReadings: number;
    boilerTemperatureReadings: number;
    boilerUsageAccumulators: number;
    radiatorUsageAccumulators: number;
    electricUsageAccumulators: number;
    electricUsageReadings: number;
    electricUsageDailyRollups: number;
    auditEvents: number;
  };
  haTargets: {
    tenantOwnedDeviceIds: number;
    tenantOwnedEntityIds: number;
    tenantAutomationIds: number;
    triggerBindingCandidates: number;
  };
  hubAgent: {
    hubInstallId: string | null;
    platformSyncEnabled: boolean | null;
    lastSeenAt: string | null;
    lastReportedLanBaseUrl: string | null;
    lastReportedLanBaseUrlAt: string | null;
  };
  warnings: string[];
};

export type HomeRemovalSummary = {
  ok: true;
  alreadyRemoved?: boolean;
  warnings: string[];
  deleted: Record<string, number>;
  triggerBindingCleanup: Array<{ tenantUserId: number; removed: number; failed: number }>;
  haCleanup: {
    attempted: boolean;
    completed: boolean;
    endpointUsed: string | null;
    cloudLogoutSuccess: boolean | null;
    errors: string[];
  };
  alexaDeleteReport: {
    attempted: boolean;
    errors: string[];
  };
};

type RemovalHomeContext = {
  home: {
    id: number;
    haConnectionId: number;
    hubInstallId: string | null;
    serial: string | null;
    haConnection: {
      id: number;
      baseUrl: string;
      cloudUrl: string | null;
      haUsername: string | null;
      haUsernameCiphertext: string | null;
      haPassword: string | null;
      haPasswordCiphertext: string | null;
      longLivedToken: string | null;
      longLivedTokenCiphertext: string | null;
      ownerId: number | null;
    };
    hubInstall: {
      id: string;
      serial: string;
      platformSyncEnabled: boolean;
      lastSeenAt: Date | null;
      lastReportedLanBaseUrl: string | null;
      lastReportedLanBaseUrlAt: Date | null;
    } | null;
    users: Array<{
      id: number;
      username: string;
      email: string | null;
      role: Role;
      isActive: boolean;
    }>;
  };
  allRelatedUserIds: number[];
  tenantUserIds: number[];
  pendingUserIds: number[];
};

type HomeCleanupTargets = {
  tenantOwnedDeviceIds: string[];
  tenantOwnedEntityIds: string[];
  tenantAutomationIds: string[];
  skippedDeviceIds: number;
  skippedEntityIds: number;
};

function safeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err ?? 'Unknown error');
}

function isoOrNull(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function isRecent(value: Date | null | undefined, windowMs: number) {
  if (!value) return false;
  return Date.now() - value.getTime() <= windowMs;
}

function coerceBindingCount(payload: unknown): number {
  if (!payload) return 0;
  if (Array.isArray(payload)) return payload.length;
  if (typeof payload !== 'object') return 0;
  const obj = payload as Record<string, unknown>;
  if (Array.isArray(obj.bindings)) return obj.bindings.length;
  if (Array.isArray(obj.items)) return obj.items.length;
  if (Array.isArray(obj.results)) return obj.results.length;
  return 0;
}

async function bestEffortRemoteBindingCount(ha: HaConnectionLike): Promise<number> {
  try {
    const payload = await callHaService(
      ha,
      REMOTE_MANAGER_DOMAIN,
      SERVICE_LIST_BINDINGS,
      {},
      REMOTE_BINDING_READ_TIMEOUT_MS,
      { returnResponse: true }
    );
    return coerceBindingCount(payload);
  } catch {
    return 0;
  }
}

async function collectHomeContext(homeId: number): Promise<RemovalHomeContext | null> {
  const home = await prisma.home.findUnique({
    where: { id: homeId },
    select: {
      id: true,
      haConnectionId: true,
      hubInstall: {
        select: {
          id: true,
          serial: true,
          platformSyncEnabled: true,
          lastSeenAt: true,
          lastReportedLanBaseUrl: true,
          lastReportedLanBaseUrlAt: true,
        },
      },
      haConnection: {
        select: {
          id: true,
          baseUrl: true,
          cloudUrl: true,
          haUsername: true,
          haUsernameCiphertext: true,
          haPassword: true,
          haPasswordCiphertext: true,
          longLivedToken: true,
          longLivedTokenCiphertext: true,
          ownerId: true,
        },
      },
      users: {
        select: {
          id: true,
          username: true,
          email: true,
          role: true,
          isActive: true,
        },
      },
    },
  });

  if (!home?.haConnection) return null;

  const pendingRows = await prisma.pendingHomeownerOnboarding.findMany({
    where: {
      OR: [
        { homeId },
        ...(home.hubInstall?.id ? [{ hubInstallId: home.hubInstall.id }] : []),
      ],
    },
    select: { userId: true },
  });

  const pendingUserIds = Array.from(
    new Set(
      pendingRows
        .map((row) => row.userId)
        .filter((value): value is number => typeof value === 'number' && value > 0)
    )
  );

  const allRelatedUserIds = Array.from(
    new Set([...home.users.map((user) => user.id), ...pendingUserIds])
  );

  return {
    home: {
      id: home.id,
      haConnectionId: home.haConnectionId,
      hubInstallId: home.hubInstall?.id ?? null,
      serial: home.hubInstall?.serial ?? null,
      haConnection: home.haConnection,
      hubInstall: home.hubInstall,
      users: home.users,
    },
    allRelatedUserIds,
    tenantUserIds: home.users.filter((user) => user.role === Role.TENANT).map((user) => user.id),
    pendingUserIds,
  };
}

export async function getHomeCleanupTargets(
  homeId: number,
  haConnectionId: number,
  hubInstallId: string | null
): Promise<HomeCleanupTargets> {
  void hubInstallId;
  const [tenantTargets, tenantAutomationIds] = await Promise.all([
    getNonInstallerOwnedTargetsForHome(homeId, haConnectionId, { maxRegistryRemovals: MAX_REGISTRY_REMOVALS }),
    getNonInstallerAutomationIdsForHome(homeId),
  ]);

  return {
    tenantOwnedDeviceIds: tenantTargets.deviceIds,
    tenantOwnedEntityIds: tenantTargets.entityIds,
    tenantAutomationIds,
    skippedDeviceIds: tenantTargets.skippedDeviceIds,
    skippedEntityIds: tenantTargets.skippedEntityIds,
  };
}

export async function getHomeRemovalPreview(homeId: number): Promise<RemoveHomePreview> {
  const context = await collectHomeContext(homeId);
  if (!context) {
    return {
      ok: true,
      alreadyRemoved: true,
      homeId,
      serial: null,
      partiallyRemoved: false,
      counts: {
        homeowners: 0,
        tenants: 0,
        rooms: 0,
        roomAccessRequests: 0,
        supportRequests: 0,
        pendingOnboardings: 0,
        alexaLinkedUsers: 0,
        devices: 0,
        areaDisplayOverrides: 0,
        labelDisplayOverrides: 0,
        tenantDeviceDisplayOverrides: 0,
        tenantVirtualAreas: 0,
        monitoringReadings: 0,
        boilerTemperatureReadings: 0,
        boilerUsageAccumulators: 0,
        radiatorUsageAccumulators: 0,
        electricUsageAccumulators: 0,
        electricUsageReadings: 0,
        electricUsageDailyRollups: 0,
        auditEvents: 0,
      },
      haTargets: {
        tenantOwnedDeviceIds: 0,
        tenantOwnedEntityIds: 0,
        tenantAutomationIds: 0,
        triggerBindingCandidates: 0,
      },
      hubAgent: {
        hubInstallId: null,
        platformSyncEnabled: null,
        lastSeenAt: null,
        lastReportedLanBaseUrl: null,
        lastReportedLanBaseUrlAt: null,
      },
      warnings: [],
    };
  }

  const { home, allRelatedUserIds } = context;
  const [counts, cleanupTargets, remoteBindingCount] = await Promise.all([
    Promise.all([
      prisma.room.count({ where: { hubInstallId: home.hubInstallId ?? undefined } }),
      prisma.roomAccessRequest.count({ where: { hubInstallId: home.hubInstallId ?? undefined } }),
      prisma.supportRequest.count({ where: { homeId } }),
      prisma.pendingHomeownerOnboarding.count({
        where: {
          OR: [
            { homeId },
            ...(home.hubInstallId ? [{ hubInstallId: home.hubInstallId }] : []),
            ...(allRelatedUserIds.length ? [{ userId: { in: allRelatedUserIds } }] : []),
          ],
        },
      }),
      allRelatedUserIds.length
        ? prisma.user.count({
            where: {
              id: { in: allRelatedUserIds },
              OR: [
                { alexaEventToken: { isNot: null } },
                { alexaRefreshTokens: { some: { revoked: false } } },
                { alexaSkillUserLinks: { some: { disabledAt: null } } },
              ],
            },
          })
        : 0,
      prisma.device.count({ where: { haConnectionId: home.haConnectionId } }),
      prisma.areaDisplayOverride.count({ where: { haConnectionId: home.haConnectionId } }),
      prisma.labelDisplayOverride.count({ where: { haConnectionId: home.haConnectionId } }),
      prisma.tenantDeviceDisplayOverride.count({ where: { haConnectionId: home.haConnectionId } }),
      prisma.tenantVirtualArea.count({ where: { haConnectionId: home.haConnectionId } }),
      prisma.monitoringReading.count({ where: { haConnectionId: home.haConnectionId } }),
      prisma.boilerTemperatureReading.count({ where: { haConnectionId: home.haConnectionId } }),
      prisma.boilerUsageAccumulator.count({ where: { haConnectionId: home.haConnectionId } }),
      prisma.radiatorUsageAccumulator.count({ where: { haConnectionId: home.haConnectionId } }),
      prisma.electricUsageAccumulator.count({ where: { haConnectionId: home.haConnectionId } }),
      prisma.electricUsageReading.count({ where: { haConnectionId: home.haConnectionId } }),
      prisma.electricUsageDailyRollup.count({ where: { haConnectionId: home.haConnectionId } }),
      prisma.auditEvent.count({ where: { homeId } }),
    ]),
    getHomeCleanupTargets(homeId, home.haConnectionId, home.hubInstallId),
    (() => {
      try {
        const hydrated = { ...home.haConnection, ...resolveHaLongLivedToken(home.haConnection) };
        return bestEffortRemoteBindingCount(hydrated);
      } catch {
        return Promise.resolve(0);
      }
    })(),
  ]);

  const warnings: string[] = [];
  if (isRecent(home.hubInstall?.lastReportedLanBaseUrlAt, 10 * 60_000)) {
    warnings.push('Hub still appears to be reporting recently.');
  }
  if (remoteBindingCount > 0) {
    warnings.push('Dinodia Remote Manager still reports active trigger bindings.');
  }
  if (cleanupTargets.tenantOwnedDeviceIds.length > 0 || cleanupTargets.tenantOwnedEntityIds.length > 0) {
    warnings.push('Dinodia still sees tenant-owned HA targets for this home.');
  }
  if (cleanupTargets.tenantAutomationIds.length > 0) {
    warnings.push('Dinodia still sees tenant automations for this home.');
  }
  if (!home.hubInstall) {
    warnings.push('Hub install row is already missing; home may be partially removed.');
  }

  return {
    ok: true,
    homeId,
    serial: home.serial,
    partiallyRemoved: !home.hubInstall || warnings.length > 0,
    counts: {
      homeowners: home.users.filter((user) => user.role === Role.ADMIN).length,
      tenants: home.users.filter((user) => user.role === Role.TENANT).length,
      rooms: counts[0],
      roomAccessRequests: counts[1],
      supportRequests: counts[2],
      pendingOnboardings: counts[3],
      alexaLinkedUsers: counts[4],
      devices: counts[5],
      areaDisplayOverrides: counts[6],
      labelDisplayOverrides: counts[7],
      tenantDeviceDisplayOverrides: counts[8],
      tenantVirtualAreas: counts[9],
      monitoringReadings: counts[10],
      boilerTemperatureReadings: counts[11],
      boilerUsageAccumulators: counts[12],
      radiatorUsageAccumulators: counts[13],
      electricUsageAccumulators: counts[14],
      electricUsageReadings: counts[15],
      electricUsageDailyRollups: counts[16],
      auditEvents: counts[17],
    },
    haTargets: {
      tenantOwnedDeviceIds: cleanupTargets.tenantOwnedDeviceIds.length,
      tenantOwnedEntityIds: cleanupTargets.tenantOwnedEntityIds.length,
      tenantAutomationIds: cleanupTargets.tenantAutomationIds.length,
      triggerBindingCandidates: remoteBindingCount,
    },
    hubAgent: {
      hubInstallId: home.hubInstallId,
      platformSyncEnabled: home.hubInstall?.platformSyncEnabled ?? null,
      lastSeenAt: isoOrNull(home.hubInstall?.lastSeenAt),
      lastReportedLanBaseUrl: home.hubInstall?.lastReportedLanBaseUrl ?? null,
      lastReportedLanBaseUrlAt: isoOrNull(home.hubInstall?.lastReportedLanBaseUrlAt),
    },
    warnings,
  };
}

function buildEmptyAlexaSnapshot(userIds: number[]) {
  return new Map(userIds.map((userId) => [userId, { endpoints: [], endpointIds: [] }]));
}

export async function performCompanyHomeRemoval(args: {
  homeId: number;
  operatorUserId: number;
  operatorRole: Role;
  checklist: RemoveHomeChecklistState;
  typedConfirmation: string;
  notes?: string | null;
}): Promise<HomeRemovalSummary> {
  const context = await collectHomeContext(args.homeId);
  if (!context) {
    return {
      ok: true,
      alreadyRemoved: true,
      warnings: [],
      deleted: {},
      triggerBindingCleanup: [],
      haCleanup: {
        attempted: false,
        completed: false,
        endpointUsed: null,
        cloudLogoutSuccess: null,
        errors: [],
      },
      alexaDeleteReport: {
        attempted: false,
        errors: [],
      },
    };
  }

  const { home, tenantUserIds, allRelatedUserIds } = context;
  const preview = await getHomeRemovalPreview(args.homeId);
  const warnings = [...preview.warnings];
  const cleanupTargets = await getHomeCleanupTargets(args.homeId, home.haConnectionId, home.hubInstallId);

  let beforeAlexa = new Map<number, { endpoints: Record<string, unknown>[]; endpointIds: string[] }>();
  try {
    beforeAlexa = await captureAlexaEndpointSnapshot({
      homeId: args.homeId,
      tenantUserIds,
    });
  } catch (err) {
    warnings.push(`Could not capture Alexa endpoint snapshot: ${safeError(err)}`);
  }

  const triggerBindingCleanup: Array<{ tenantUserId: number; removed: number; failed: number }> = [];
  let haCleanupSummary: HaCleanupSummary | null = null;
  let cloudLogoutSuccess: boolean | null = null;
  const haCleanupErrors: string[] = [];

  try {
    const hydratedHa = { ...home.haConnection, ...resolveHaLongLivedToken(home.haConnection) };
    for (const tenantUserId of tenantUserIds) {
      try {
        const result = await removeTriggerBindingsForTenant({
          tenantUserId,
          haConnection: hydratedHa,
        });
        triggerBindingCleanup.push({
          tenantUserId,
          removed: result.removedBindings,
          failed: result.failed,
        });
      } catch (err) {
        const message = safeError(err);
        triggerBindingCleanup.push({ tenantUserId, removed: 0, failed: 1 });
        haCleanupErrors.push(`Trigger binding cleanup failed for tenant ${tenantUserId}: ${message}`);
      }
    }

    try {
      haCleanupSummary = await performTenantOwnedHaCleanup(hydratedHa, {
        deviceIds: cleanupTargets.tenantOwnedDeviceIds,
        entityIds: cleanupTargets.tenantOwnedEntityIds,
        automationIds: cleanupTargets.tenantAutomationIds,
      });
    } catch (err) {
      if (err instanceof HaCleanupConnectionError) {
        haCleanupErrors.push(`HA cleanup connection issue: ${err.reasons.join(', ')}`);
      } else {
        haCleanupErrors.push(`HA cleanup failed: ${safeError(err)}`);
      }
    }

    if (haCleanupSummary) {
      try {
        const logoutResult = await logoutHaCloud(hydratedHa, haCleanupSummary.endpointUsed);
        cloudLogoutSuccess = logoutResult.failed.length === 0;
      } catch (err) {
        cloudLogoutSuccess = false;
        haCleanupErrors.push(`HA cloud logout failed: ${safeError(err)}`);
      }
    }
  } catch (err) {
    haCleanupErrors.push(`HA credentials unavailable: ${safeError(err)}`);
  }

  const alexaDeleteErrors: string[] = [];
  if (beforeAlexa.size > 0) {
    try {
      await pushAlexaDiscoveryDiff({
        before: beforeAlexa,
        after: buildEmptyAlexaSnapshot(Array.from(beforeAlexa.keys())),
      });
    } catch (err) {
      alexaDeleteErrors.push(`Alexa DeleteReport failed: ${safeError(err)}`);
    }
  }

  const pendingWhere: Prisma.PendingHomeownerOnboardingWhereInput = {
    OR: [
      { homeId: args.homeId },
      ...(home.hubInstallId ? [{ hubInstallId: home.hubInstallId }] : []),
      ...(allRelatedUserIds.length ? [{ userId: { in: allRelatedUserIds } }] : []),
    ],
  };

  const deletionResult = await prisma.$transaction(async (tx) => {
    const existingEvents = await tx.auditEvent.findMany({ where: { homeId: args.homeId } });
    if (existingEvents.length > 0) {
      await tx.auditEventArchive.createMany({
        data: existingEvents.map((event) => ({
          type: event.type,
          metadata: event.metadata as Prisma.InputJsonValue,
          homeId: event.homeId,
          actorUserId: event.actorUserId,
          createdAt: event.createdAt,
        })),
      });
    }

    const requestIds = home.hubInstallId
      ? (
          await tx.roomAccessRequest.findMany({
            where: { hubInstallId: home.hubInstallId },
            select: { id: true },
          })
        ).map((row) => row.id)
      : [];

    const counts: Record<string, number> = {};

    counts.roomAccessApprovalTokens = requestIds.length
      ? (await tx.roomAccessApprovalToken.deleteMany({ where: { requestId: { in: requestIds } } })).count
      : 0;
    counts.roomAccessRequests = home.hubInstallId
      ? (await tx.roomAccessRequest.deleteMany({ where: { hubInstallId: home.hubInstallId } })).count
      : 0;
    counts.supportRequests = (await tx.supportRequest.deleteMany({ where: { homeId: args.homeId } })).count;
    counts.pendingHomeownerOnboardings = (await tx.pendingHomeownerOnboarding.deleteMany({ where: pendingWhere })).count;

    counts.rooms = home.hubInstallId
      ? (await tx.room.deleteMany({ where: { hubInstallId: home.hubInstallId } })).count
      : 0;
    counts.homeownerPolicyNotificationDeliveries = (
      await tx.homeownerPolicyNotificationDelivery.deleteMany({ where: { homeId: args.homeId } })
    ).count;
    counts.homeownerPolicyAcceptances = (
      await tx.homeownerPolicyAcceptance.deleteMany({ where: { homeId: args.homeId } })
    ).count;
    counts.homeContacts = (await tx.homeContact.deleteMany({ where: { homeId: args.homeId } })).count;

    counts.areaDisplayOverrides = (
      await tx.areaDisplayOverride.deleteMany({ where: { haConnectionId: home.haConnectionId } })
    ).count;
    counts.labelDisplayOverrides = (
      await tx.labelDisplayOverride.deleteMany({ where: { haConnectionId: home.haConnectionId } })
    ).count;
    counts.tenantDeviceDisplayOverrides = (
      await tx.tenantDeviceDisplayOverride.deleteMany({ where: { haConnectionId: home.haConnectionId } })
    ).count;
    counts.tenantVirtualAreas = (
      await tx.tenantVirtualArea.deleteMany({ where: { haConnectionId: home.haConnectionId } })
    ).count;
    counts.devices = (await tx.device.deleteMany({ where: { haConnectionId: home.haConnectionId } })).count;

    counts.monitoringReadings = (
      await tx.monitoringReading.deleteMany({ where: { haConnectionId: home.haConnectionId } })
    ).count;
    counts.boilerTemperatureReadings = (
      await tx.boilerTemperatureReading.deleteMany({ where: { haConnectionId: home.haConnectionId } })
    ).count;
    counts.boilerUsageAccumulators = (
      await tx.boilerUsageAccumulator.deleteMany({ where: { haConnectionId: home.haConnectionId } })
    ).count;
    counts.radiatorUsageAccumulators = (
      await tx.radiatorUsageAccumulator.deleteMany({ where: { haConnectionId: home.haConnectionId } })
    ).count;
    counts.electricUsageAccumulators = (
      await tx.electricUsageAccumulator.deleteMany({ where: { haConnectionId: home.haConnectionId } })
    ).count;
    counts.electricUsageReadings = (
      await tx.electricUsageReading.deleteMany({ where: { haConnectionId: home.haConnectionId } })
    ).count;
    counts.electricUsageDailyRollups = (
      await tx.electricUsageDailyRollup.deleteMany({ where: { haConnectionId: home.haConnectionId } })
    ).count;

    counts.automationOwnerships = (await tx.automationOwnership.deleteMany({ where: { homeId: args.homeId } })).count;
    counts.homeAutomations = (await tx.homeAutomation.deleteMany({ where: { homeId: args.homeId } })).count;

    counts.accessRules = allRelatedUserIds.length
      ? (await tx.accessRule.deleteMany({ where: { userId: { in: allRelatedUserIds } } })).count
      : 0;
    counts.trustedDevices = allRelatedUserIds.length
      ? (await tx.trustedDevice.deleteMany({ where: { userId: { in: allRelatedUserIds } } })).count
      : 0;
    counts.authChallenges = allRelatedUserIds.length
      ? (await tx.authChallenge.deleteMany({ where: { userId: { in: allRelatedUserIds } } })).count
      : 0;
    counts.loginIntents = allRelatedUserIds.length
      ? (await tx.loginIntent.deleteMany({ where: { userId: { in: allRelatedUserIds } } })).count
      : 0;
    counts.policyAcceptances = allRelatedUserIds.length
      ? (await tx.policyAcceptance.deleteMany({ where: { userId: { in: allRelatedUserIds } } })).count
      : 0;
    counts.stepUpApprovals = allRelatedUserIds.length
      ? (await tx.stepUpApproval.deleteMany({ where: { userId: { in: allRelatedUserIds } } })).count
      : 0;
    counts.remoteAccessLeases = allRelatedUserIds.length
      ? (await tx.remoteAccessLease.deleteMany({ where: { userId: { in: allRelatedUserIds } } })).count
      : 0;
    counts.alexaAuthCodes = allRelatedUserIds.length
      ? (await tx.alexaAuthCode.deleteMany({ where: { userId: { in: allRelatedUserIds } } })).count
      : 0;
    counts.alexaRefreshTokens = allRelatedUserIds.length
      ? (await tx.alexaRefreshToken.deleteMany({ where: { userId: { in: allRelatedUserIds } } })).count
      : 0;
    counts.alexaEventTokens = allRelatedUserIds.length
      ? (await tx.alexaEventToken.deleteMany({ where: { userId: { in: allRelatedUserIds } } })).count
      : 0;
    counts.alexaSkillUserLinks = allRelatedUserIds.length
      ? (await tx.alexaSkillUserLink.deleteMany({ where: { userId: { in: allRelatedUserIds } } })).count
      : 0;
    counts.newDeviceCommissioningSessions = (
      await tx.newDeviceCommissioningSession.deleteMany({
        where: {
          OR: [
            { haConnectionId: home.haConnectionId },
            ...(allRelatedUserIds.length ? [{ userId: { in: allRelatedUserIds } }] : []),
          ],
        },
      })
    ).count;

    counts.auditEvents = (await tx.auditEvent.deleteMany({ where: { homeId: args.homeId } })).count;

    if (home.haConnection.ownerId != null) {
      await tx.haConnection.update({
        where: { id: home.haConnectionId },
        data: { ownerId: null },
      });
    }

    counts.users = allRelatedUserIds.length
      ? (
          await tx.user.deleteMany({
            where: {
              id: { in: allRelatedUserIds },
            },
          })
        ).count
      : 0;
    counts.hubTokens = home.hubInstallId
      ? (await tx.hubToken.deleteMany({ where: { hubInstallId: home.hubInstallId } })).count
      : 0;
    counts.hubInstall = home.hubInstallId
      ? (await tx.hubInstall.deleteMany({ where: { id: home.hubInstallId } })).count
      : 0;
    counts.home = (await tx.home.deleteMany({ where: { id: args.homeId } })).count;
    counts.haConnection = (await tx.haConnection.deleteMany({ where: { id: home.haConnectionId } })).count;

    await tx.auditEventArchive.create({
      data: {
        type: AuditEventType.HOME_RESET,
        homeId: args.homeId,
        actorUserId: args.operatorUserId,
        createdAt: new Date(),
        metadata: {
          action: 'COMPANY_HOME_REMOVED',
          operatorRole: args.operatorRole,
          serial: home.serial,
          checklist: args.checklist,
          typedConfirmation: args.typedConfirmation,
          notes: args.notes ?? null,
          previewCounts: preview.counts,
          previewWarnings: warnings,
          deleted: counts,
          triggerBindingCleanup,
          haCleanup: {
            attempted: true,
            completed: Boolean(haCleanupSummary),
            endpointUsed: haCleanupSummary?.endpointUsed ?? null,
            cloudLogoutSuccess,
            errors: haCleanupErrors,
          },
          alexaDeleteReport: {
            attempted: beforeAlexa.size > 0,
            errors: alexaDeleteErrors,
          },
        } satisfies Prisma.InputJsonValue,
      },
    });

    return counts;
  });

  return {
    ok: true,
    warnings: [...warnings, ...haCleanupErrors, ...alexaDeleteErrors],
    deleted: deletionResult,
    triggerBindingCleanup,
    haCleanup: {
      attempted: true,
      completed: Boolean(haCleanupSummary),
      endpointUsed: haCleanupSummary?.endpointUsed ?? null,
      cloudLogoutSuccess,
      errors: haCleanupErrors,
    },
    alexaDeleteReport: {
      attempted: beforeAlexa.size > 0,
      errors: alexaDeleteErrors,
    },
  };
}
