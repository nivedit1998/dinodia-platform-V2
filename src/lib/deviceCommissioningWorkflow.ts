// Architecture: Shared platform helper src/lib/deviceCommissioningWorkflow.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { NewDeviceCommissioningSession } from '@prisma/client';
import { applyTenantDeviceLabel } from '@/lib/haLabels';
import {
  diffRegistrySnapshots,
  fetchRegistrySnapshot,
  RegistrySnapshot,
} from '@/lib/haRegistrySnapshot';
import type { HaConnectionLike } from '@/lib/homeAssistant';
import { fetchHaState } from '@/lib/homeAssistant';
import { getSessionSnapshots } from '@/lib/matterSessions';
import { prisma } from '@/lib/prisma';
import { assignHaAreaToDevices } from '@/lib/haAreas';
import { assignHaAreaToEntities } from '@/lib/haAreas';
import { buildTenantHaTechnicalName, normalizeDisplayText, normalizeLookupKey } from '@/lib/displayNormalization';
import { renameHaEntitiesForTenantDevice } from '@/lib/haEntityRegistry';
import { renameHaDevicesForTenantDevice } from '@/lib/haDeviceRegistry';
import { inferCanonicalLabel } from '@/lib/deviceDisplayResolver';
import { hashForLog, safeLog } from '@/lib/safeLogger';

async function resolveFriendlyName(
  ha: HaConnectionLike,
  entityId: string,
  requestedName?: string | null
) {
  if (requestedName && requestedName.trim().length > 0) return requestedName.trim();
  try {
    const state = await fetchHaState(ha, entityId);
    const friendly = state?.attributes?.friendly_name;
    if (typeof friendly === 'string' && friendly.trim().length > 0) {
      return friendly.trim();
    }
  } catch (err) {
    safeLog('warn', '[commissioning workflow] Failed to read HA state for name', {
      entityIdHash: hashForLog(entityId),
      err,
    });
  }
  return entityId;
}

async function upsertDeviceOverrides(
  session: NewDeviceCommissioningSession,
  ha: HaConnectionLike,
  entityIds: string[]
) {
  if (entityIds.length === 0) return;
  const requestedArea = session.requestedArea;
  const requestedDinodiaType = session.requestedDisplayLabel ?? session.requestedDinodiaType;
  const requestedName = session.requestedName;
  const haConnectionId = session.haConnectionId;

  const names = await Promise.all(
    entityIds.map((entityId) => resolveFriendlyName(ha, entityId, requestedName))
  );

  await Promise.all(
    entityIds.map((entityId, idx) =>
      prisma.device.upsert({
        where: {
          haConnectionId_entityId: {
            haConnectionId,
            entityId,
          },
        },
        update: {
          area: requestedArea,
          ...(requestedDinodiaType ? { label: requestedDinodiaType } : {}),
          ...(requestedName ? { name: requestedName } : {}),
        },
        create: {
          haConnectionId,
          entityId,
          name: names[idx] ?? entityId,
          area: requestedArea,
          label: requestedDinodiaType ?? null,
        },
      })
    )
  );
}

export async function finalizeCommissioningSuccess(
  session: NewDeviceCommissioningSession,
  ha: HaConnectionLike,
  opts?: {
    beforeSnapshot?: RegistrySnapshot | null;
    discoveredDeviceIds?: string[];
    discoveredEntityIds?: string[];
    skipHaMutations?: boolean;
  }
) {
  const { before } = getSessionSnapshots(session);
  const baseline = opts?.beforeSnapshot ?? before;
  const explicitDeviceIds = Array.from(
    new Set((opts?.discoveredDeviceIds ?? []).map((id) => id.trim()).filter(Boolean))
  );
  const explicitEntityIds = Array.from(
    new Set((opts?.discoveredEntityIds ?? []).map((id) => id.trim()).filter(Boolean))
  );
  const usingExplicitDiscovery = explicitDeviceIds.length > 0 || explicitEntityIds.length > 0;

  const afterSnapshot = usingExplicitDiscovery
    ? {
        deviceIds: Array.from(new Set([...(baseline?.deviceIds ?? []), ...explicitDeviceIds])),
        entityIds: Array.from(new Set([...(baseline?.entityIds ?? []), ...explicitEntityIds])),
      }
    : await fetchRegistrySnapshot(ha);
  const { newDeviceIds, newEntityIds } = usingExplicitDiscovery
    ? { newDeviceIds: explicitDeviceIds, newEntityIds: explicitEntityIds }
    : diffRegistrySnapshots(baseline, afterSnapshot);

  await prisma.newDeviceCommissioningSession.update({
    where: { id: session.id },
    data: {
      afterDeviceIds: afterSnapshot.deviceIds,
      afterEntityIds: afterSnapshot.entityIds,
    },
  });

  await upsertDeviceOverrides(session, ha, newEntityIds);

  let labelWarning: string | undefined;
  const displayName = normalizeDisplayText(session.requestedName);
  const displayLabel =
    normalizeDisplayText(session.requestedDisplayLabel) ||
    normalizeDisplayText(session.requestedDinodiaType) ||
    'tenant_device';
  const haTechnicalName =
    normalizeDisplayText(session.haTechnicalName) ||
    (displayName ? buildTenantHaTechnicalName(session.userId, displayName) : '');
  if (haTechnicalName && !opts?.skipHaMutations) {
    const deviceRenameResult = await renameHaDevicesForTenantDevice(
      ha,
      newDeviceIds,
      haTechnicalName
    );
    if (!deviceRenameResult.ok && deviceRenameResult.warning) {
      labelWarning = [labelWarning, deviceRenameResult.warning].filter(Boolean).join(' ');
    }
    const result = await renameHaEntitiesForTenantDevice(
      ha,
      { deviceIds: newDeviceIds, entityIds: newEntityIds },
      haTechnicalName
    );
    if (!result.ok && result.warning) {
      labelWarning = [labelWarning, result.warning].filter(Boolean).join(' ');
    }
  }

  if (!opts?.skipHaMutations) {
    const labelResult = await applyTenantDeviceLabel(ha, {
      deviceIds: newDeviceIds,
      entityIds: newEntityIds,
    });
    if (!labelResult.ok && labelResult.warning) {
      labelWarning = [labelWarning, labelResult.warning].filter(Boolean).join(' ');
    }
  }

  let areaWarning: string | undefined;
  if (session.requestedArea && !opts?.skipHaMutations) {
    const deviceResult = await assignHaAreaToDevices(ha, session.requestedArea, newDeviceIds);
    const entityResult = await assignHaAreaToEntities(ha, session.requestedArea, newEntityIds);
    areaWarning = [deviceResult.warning, entityResult.warning].filter(Boolean).join(' ') || undefined;
  }

  const primaryEntityId = newEntityIds[0] ?? null;
  const primaryDeviceId = newDeviceIds[0] ?? null;
  if (displayName && (primaryEntityId || primaryDeviceId)) {
    await prisma.tenantDeviceDisplayOverride.upsert({
      where: {
        tenantUserId_haConnectionId_displayNameKey: {
          tenantUserId: session.userId,
          haConnectionId: session.haConnectionId,
          displayNameKey: normalizeLookupKey(displayName),
        },
      },
      update: {
        haDeviceId: primaryDeviceId,
        entityId: primaryEntityId,
        displayName,
        haTechnicalName: haTechnicalName || buildTenantHaTechnicalName(session.userId, displayName),
        displayLabel,
        displayLabelKey: normalizeLookupKey(displayLabel),
        canonicalLabel: primaryEntityId
          ? inferCanonicalLabel({
              entityId: primaryEntityId,
              deviceId: primaryDeviceId,
              name: displayName,
              state: '',
              area: session.requestedArea,
              areaName: session.requestedArea,
              label: displayLabel,
              labels: [],
              technicalLabels: [],
              domain: primaryEntityId.split('.')[0] || '',
              attributes: {},
            })
          : null,
        parentHaAreaId: session.requestedParentHaAreaId,
        parentHaAreaName: session.requestedArea,
        parentAreaDisplaySnapshot: session.requestedArea,
        tenantVirtualAreaId: session.requestedVirtualAreaId,
      },
      create: {
        tenantUserId: session.userId,
        tenantUserIdKey: String(session.userId),
        haConnectionId: session.haConnectionId,
        haDeviceId: primaryDeviceId,
        entityId: primaryEntityId,
        displayName,
        displayNameKey: normalizeLookupKey(displayName),
        haTechnicalName: haTechnicalName || buildTenantHaTechnicalName(session.userId, displayName),
        displayLabel,
        displayLabelKey: normalizeLookupKey(displayLabel),
        canonicalLabel: primaryEntityId
          ? inferCanonicalLabel({
              entityId: primaryEntityId,
              deviceId: primaryDeviceId,
              name: displayName,
              state: '',
              area: session.requestedArea,
              areaName: session.requestedArea,
              label: displayLabel,
              labels: [],
              technicalLabels: [],
              domain: primaryEntityId.split('.')[0] || '',
              attributes: {},
            })
          : null,
        parentHaAreaId: session.requestedParentHaAreaId,
        parentHaAreaName: session.requestedArea,
        parentAreaDisplaySnapshot: session.requestedArea,
        tenantVirtualAreaId: session.requestedVirtualAreaId,
      },
    });
  }

  return { newDeviceIds, newEntityIds, labelWarning, areaWarning };
}
