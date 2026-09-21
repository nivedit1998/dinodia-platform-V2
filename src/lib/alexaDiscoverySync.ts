// Architecture: Shared platform helper src/lib/alexaDiscoverySync.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { Role } from '@prisma/client';
import { getAlexaDiscoveryEndpointsForUser } from '@/lib/alexaDiscoveryEndpoints';
import { normalizeAlexaEndpointId } from '@/lib/alexaEndpointId';
import { sendAlexaAddOrUpdateReport, sendAlexaDeleteReport } from '@/lib/alexaEvents';
import { prisma } from '@/lib/prisma';
import { safeLog } from '@/lib/safeLogger';

export type AlexaEndpointSnapshot = Map<number, {
  endpoints: Record<string, unknown>[];
  endpointIds: string[];
}>;

function endpointIdFromRecord(endpoint: unknown): string {
  if (!endpoint || typeof endpoint !== 'object') return '';
  const endpointId = (endpoint as Record<string, unknown>).endpointId;
  return typeof endpointId === 'string' ? normalizeAlexaEndpointId(endpointId) : '';
}

export async function getAlexaLinkedTenantIdsForHome(args: {
  homeId: number;
  tenantUserIds?: number[] | null;
}) {
  const users = await prisma.user.findMany({
    where: {
      role: Role.TENANT,
      homeId: args.homeId,
      ...(args.tenantUserIds?.length ? { id: { in: args.tenantUserIds } } : {}),
      OR: [
        { alexaEventToken: { isNot: null } },
        { alexaRefreshTokens: { some: { revoked: false } } },
        { alexaSkillUserLinks: { some: { disabledAt: null } } },
      ],
    },
    select: { id: true },
  });
  return users.map((user) => user.id);
}

export async function captureAlexaEndpointSnapshot(args: {
  homeId: number;
  tenantUserIds?: number[] | null;
}): Promise<AlexaEndpointSnapshot> {
  const tenantIds = await getAlexaLinkedTenantIdsForHome({
    homeId: args.homeId,
    tenantUserIds: args.tenantUserIds,
  });
  const snapshot: AlexaEndpointSnapshot = new Map();

  for (const userId of tenantIds) {
    try {
      const { endpoints } = await getAlexaDiscoveryEndpointsForUser({ userId });
      const normalizedEndpoints = (endpoints ?? []).filter(
        (endpoint): endpoint is Record<string, unknown> =>
          Boolean(endpoint && typeof endpoint === 'object')
      );
      const endpointIds = normalizedEndpoints.map(endpointIdFromRecord).filter(Boolean);
      snapshot.set(userId, { endpoints: normalizedEndpoints, endpointIds });
    } catch (err) {
      safeLog('warn', '[alexaDiscoverySync] Failed to capture endpoints', { userId, err });
      snapshot.set(userId, { endpoints: [], endpointIds: [] });
    }
  }

  return snapshot;
}

export async function pushAlexaDiscoveryDiff(args: {
  before: AlexaEndpointSnapshot;
  after: AlexaEndpointSnapshot;
}) {
  const userIds = new Set([...args.before.keys(), ...args.after.keys()]);

  for (const userId of userIds) {
    const before = args.before.get(userId) ?? { endpoints: [], endpointIds: [] };
    const after = args.after.get(userId) ?? { endpoints: [], endpointIds: [] };
    const beforeIds = new Set(before.endpointIds);
    const afterIds = new Set(after.endpointIds);
    const removed = Array.from(beforeIds).filter((id) => !afterIds.has(id));

    try {
      if (after.endpoints.length > 0) {
        await sendAlexaAddOrUpdateReport(userId, after.endpoints);
      }
      if (removed.length > 0) {
        await sendAlexaDeleteReport(userId, removed);
      }
    } catch (err) {
      safeLog('warn', '[alexaDiscoverySync] Failed to push Alexa discovery diff', {
        userId,
        removedCount: removed.length,
        afterCount: after.endpoints.length,
        err,
      });
    }
  }
}
