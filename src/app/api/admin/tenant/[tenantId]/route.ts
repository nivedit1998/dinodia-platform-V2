// Architecture: API boundary /admin/tenant/[tenantId]; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { AuditEventType, Role, TenantDeviceCleanupReason } from '@prisma/client';
import { apiFailFromStatus } from '@/lib/apiError';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { getUserWithHaConnection, resolveHaCloudFirst } from '@/lib/haConnection';
import { requireTrustedAdminDevice, toTrustedDeviceResponse } from '@/lib/deviceAuth';
import { deleteAutomation } from '@/lib/homeAssistantAutomations';
import { prisma } from '@/lib/prisma';
import { getAutomationIdsForTenant } from '@/lib/tenantOwnership';
import {
  cleanupPendingTenantDevices,
  cleanupTenantDevicesForRemovedAreas,
  markTenantDevicesPendingCleanup,
} from '@/lib/tenantDeviceCleanup';
import { captureAlexaEndpointSnapshot, pushAlexaDiscoveryDiff } from '@/lib/alexaDiscoverySync';
import {
  removeTriggerBindingsForDeletedDeviceIds,
  removeTriggerBindingsForTenant,
} from '@/lib/triggerDevices';
import { sendEmail } from '@/lib/email';
import { getAppUrl } from '@/lib/authChallenges';
import { buildTenantDeactivatedEmail } from '@/lib/emailTemplates';
import { safeLog } from '@/lib/safeLogger';
import {
  collapseRawTenantAreasToDisplayBuckets,
  expandSelectedTenantAreas,
} from '@/lib/adminTenantAreaResolution';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type UserWithConnection = Awaited<ReturnType<typeof getUserWithHaConnection>>;

function parseTenantId(context: { params: Promise<{ tenantId: string }> }) {
  const raw = context.params;
  return raw.then(({ tenantId }) => {
    const id = Number(tenantId);
    return Number.isInteger(id) && id > 0 ? id : null;
  });
}

function sanitizeAreas(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const cleaned = input
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return Array.from(new Set(cleaned));
}

function safeError(err: unknown) {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return JSON.stringify(err ?? '');
}

async function safeCaptureAlexaSnapshot(args: {
  homeId: number;
  tenantUserIds: number[];
  tenantIdForLog: number;
  operation: string;
}) {
  try {
    return await captureAlexaEndpointSnapshot({
      homeId: args.homeId,
      tenantUserIds: args.tenantUserIds,
    });
  } catch (err) {
    safeLog('warn', '[api/admin/tenant] Failed to capture Alexa discovery snapshot', {
      err,
      tenantId: args.tenantIdForLog,
      operation: args.operation,
    });
    return new Map();
  }
}

async function deleteTenantAutomations(
  ha: { baseUrl: string; longLivedToken: string },
  automationIds: string[]
) {
  const uniqueIds = Array.from(new Set(automationIds.map((id) => id.trim()).filter(Boolean)));
  const result = {
    attempted: uniqueIds.length,
    deleted: 0,
    failed: 0,
    errors: [] as string[],
  };

  for (const automationId of uniqueIds) {
    try {
      await deleteAutomation(ha, automationId);
      result.deleted += 1;
    } catch (err) {
      const message = safeError(err).toLowerCase();
      const isNotFound = message.includes('not found') || message.includes('404');
      if (isNotFound) {
        result.deleted += 1;
      } else {
        result.failed += 1;
        result.errors.push(safeError(err));
      }
    }
  }

  return result;
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ tenantId: string }> }
) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.ADMIN) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }

  try {
    await requireTrustedAdminDevice(req, me.id);
  } catch (err) {
    const deviceError = toTrustedDeviceResponse(err);
    if (deviceError) return deviceError;
    throw err;
  }

  const tenantId = await parseTenantId(context);
  if (!tenantId) {
    return apiFailFromStatus(400, 'Invalid tenant.');
  }

  let admin: UserWithConnection['user'];
  let haConnection: UserWithConnection['haConnection'];
  try {
    ({ user: admin, haConnection } = await getUserWithHaConnection(me.id));
  } catch {
    return apiFailFromStatus(400, 'Dinodia Hub connection isn’t set up yet for this home.');
  }

  if (!admin.homeId) {
    return apiFailFromStatus(400, 'This account is not linked to a home.');
  }
  const adminHomeId = admin.homeId;

  const tenant = await prisma.user.findFirst({
    where: { id: tenantId, homeId: adminHomeId, role: Role.TENANT },
    select: { id: true, username: true, email: true, emailPending: true, accessRules: { select: { area: true } } },
  });

  if (!tenant) {
    return apiFailFromStatus(404, 'Tenant not found for this home.');
  }

  const body = (await req.json().catch(() => null)) as { areas?: unknown } | null;
  if (!body || !('areas' in body)) {
    return apiFailFromStatus(400, 'Please provide areas to update.');
  }

  const selectedAreas = sanitizeAreas(body.areas);
  const areas = await expandSelectedTenantAreas({
    homeId: adminHomeId,
    haConnectionId: haConnection.id,
    selectedAreas,
  });
  const previousAreas = new Set((tenant.accessRules ?? []).map((rule) => rule.area));
  const nextAreas = new Set(areas);
  const removedAreas = Array.from(previousAreas).filter((area) => !nextAreas.has(area));
  const beforeAlexa = await safeCaptureAlexaSnapshot({
    homeId: adminHomeId,
    tenantUserIds: [tenant.id],
    tenantIdForLog: tenant.id,
    operation: 'access_update_before',
  });
  const cleanup = await cleanupTenantDevicesForRemovedAreas({
    tenantUserId: tenant.id,
    haConnectionId: haConnection.id,
    removedAreaNames: removedAreas,
  });
  const removedDeviceIds = Array.from(
    new Set(
      [
        ...(((cleanup as { removedDeviceIds?: string[] }).removedDeviceIds ?? []) as string[]),
        ...(((cleanup as { pendingDeviceIds?: string[] }).pendingDeviceIds ?? []) as string[]),
      ].filter(Boolean)
    )
  );
  const triggerBindingCleanup = await removeTriggerBindingsForDeletedDeviceIds({
    tenantUserId: tenant.id,
    haConnection,
    remoteDeviceIds: removedDeviceIds,
  });

  await prisma.$transaction(async (tx) => {
    await tx.accessRule.deleteMany({ where: { userId: tenant.id } });
    if (areas.length > 0) {
      await tx.accessRule.createMany({
        data: areas.map((area) => ({ userId: tenant.id, area })),
        skipDuplicates: true,
      });
    }
  });

  // Best-effort proactive discovery update for this tenant.
  try {
    const afterAlexa = await safeCaptureAlexaSnapshot({
      homeId: adminHomeId,
      tenantUserIds: [tenant.id],
      tenantIdForLog: tenant.id,
      operation: 'access_update_after',
    });
    await pushAlexaDiscoveryDiff({ before: beforeAlexa, after: afterAlexa });
  } catch (err) {
    safeLog('warn', '[api/admin/tenant] Failed to push Alexa discovery updates after access update', {
      err,
      tenantId: tenant.id,
    });
  }

  const collapsed = await collapseRawTenantAreasToDisplayBuckets({
    homeId: adminHomeId,
    haConnectionId: haConnection.id,
    rawAreas: areas,
  });

  return NextResponse.json({
    ok: true,
    tenant: {
      id: tenant.id,
      username: tenant.username,
      email: tenant.email ?? tenant.emailPending ?? null,
      areas: collapsed.areas,
      rawAreas: collapsed.rawAreas,
      areaDisplayKeys: collapsed.areaDisplayKeys,
      partialAreaBuckets: collapsed.partialAreaBuckets,
    },
    cleanupPending: cleanup.pending > 0 || triggerBindingCleanup.failed > 0,
    cleanup,
    triggerBindingCleanup,
  });
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ tenantId: string }> }
) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.ADMIN) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }

  try {
    await requireTrustedAdminDevice(req, me.id);
  } catch (err) {
    const deviceError = toTrustedDeviceResponse(err);
    if (deviceError) return deviceError;
    throw err;
  }

  const tenantId = await parseTenantId(context);
  if (!tenantId) {
    return apiFailFromStatus(400, 'Invalid tenant.');
  }

  let admin: UserWithConnection['user'];
  let haConnection: UserWithConnection['haConnection'];
  try {
    ({ user: admin, haConnection } = await getUserWithHaConnection(me.id));
  } catch {
    return apiFailFromStatus(400, 'Dinodia Hub connection isn’t set up yet for this home.');
  }

  if (!admin.homeId) {
    return apiFailFromStatus(400, 'This account is not linked to a home.');
  }
  const homeId = admin.homeId;

  const tenant = await prisma.user.findFirst({
    where: { id: tenantId, homeId, role: Role.TENANT },
    select: {
      id: true,
      username: true,
      email: true,
      emailPending: true,
      haConnectionId: true,
      accessRules: { select: { area: true } },
    },
  });

  if (!tenant) {
    return apiFailFromStatus(404, 'Tenant not found for this home.');
  }

  if (tenant.haConnectionId && tenant.haConnectionId !== haConnection.id) {
    return apiFailFromStatus(400, 'Tenant is linked to a different home connection.');
  }

  const automationIds = await getAutomationIdsForTenant(homeId, tenant.id);
  const beforeAlexa = await safeCaptureAlexaSnapshot({
    homeId,
    tenantUserIds: [tenant.id],
    tenantIdForLog: tenant.id,
    operation: 'delete_before',
  });

  const ha = resolveHaCloudFirst(haConnection);
  const automationResult = await deleteTenantAutomations(ha, automationIds);
  if (automationResult.failed > 0) {
    return apiFailFromStatus(502, 'Dinodia Hub unavailable. Please refresh and try again.');
  }

  try {
    await pushAlexaDiscoveryDiff({
      before: beforeAlexa,
      after: new Map([[tenant.id, { endpoints: [], endpointIds: [] }]]),
    });
  } catch (err) {
    safeLog('warn', '[api/admin/tenant] Failed to push Alexa discovery updates before tenant deletion', {
      err,
      tenantId: tenant.id,
    });
  }

  await markTenantDevicesPendingCleanup({
    tenantUserId: tenant.id,
    haConnectionId: haConnection.id,
    reason: TenantDeviceCleanupReason.TENANT_DELETED,
  });
  const cleanupResult = await cleanupPendingTenantDevices({
    tenantUserId: tenant.id,
    haConnectionId: haConnection.id,
  });
  const triggerBindingCleanup = await removeTriggerBindingsForTenant({
    tenantUserId: tenant.id,
    haConnection,
  });
  const cleanupPending = cleanupResult.failed > 0 || triggerBindingCleanup.failed > 0;

  const tenantAreas = Array.from(new Set((tenant.accessRules ?? []).map((rule) => rule.area).filter(Boolean)));

  // Best-effort: notify tenant that their account has been deactivated.
  const tenantEmail = (tenant.email ?? tenant.emailPending ?? '').trim();
  const appUrl = getAppUrl();
  const homeLabel = await prisma.home
    .findUnique({
      where: { id: homeId },
      select: { addressLine1: true, city: true, postcode: true, country: true },
    })
    .catch(() => null);
  const propertyLabel = homeLabel
    ? `${homeLabel.addressLine1}, ${homeLabel.postcode}`
    : `Home #${homeId}`;

  let deactivationEmailSent = false;
  let deactivationEmailError: string | null = null;
  if (tenantEmail) {
    try {
      const content = buildTenantDeactivatedEmail({
        appUrl,
        propertyLabel,
        username: tenant.username,
      });
      await sendEmail({
        to: tenantEmail,
        subject: content.subject,
        html: content.html,
        text: content.text,
        replyTo: 'niveditgupta@dinodiasmartliving.com',
      });
      deactivationEmailSent = true;
    } catch (err) {
      deactivationEmailError = safeError(err);
    }
  }

  const deletionResult = await prisma.$transaction(async (tx) => {
    const accessRules = await tx.accessRule.deleteMany({ where: { userId: tenant.id } });
    const trustedDevices = await tx.trustedDevice.deleteMany({ where: { userId: tenant.id } });
    const authChallenges = await tx.authChallenge.deleteMany({ where: { userId: tenant.id } });
    const alexaAuthCodes = await tx.alexaAuthCode.deleteMany({ where: { userId: tenant.id } });
    const alexaRefreshTokens = await tx.alexaRefreshToken.deleteMany({ where: { userId: tenant.id } });
    const alexaEventTokens = await tx.alexaEventToken.deleteMany({ where: { userId: tenant.id } });
    const commissioningSessions = cleanupPending
      ? { count: 0 }
      : await tx.newDeviceCommissioningSession.deleteMany({
          where: { userId: tenant.id },
        });
    const automationOwnerships = await tx.automationOwnership.deleteMany({
      where: { userId: tenant.id, homeId },
    });
    const homeAutomationRowsDeleted = automationIds.length
      ? await tx.homeAutomation.deleteMany({
          where: {
            homeId,
            automationId: { in: automationIds },
          },
        })
      : { count: 0 };

    await tx.auditEvent.create({
      data: {
        type: AuditEventType.TENANT_DELETED,
        homeId,
        actorUserId: me.id,
        metadata: {
          tenant: {
            id: tenant.id,
            username: tenant.username,
            areas: tenantAreas,
          },
          tenantDeactivationEmail: {
            to: tenantEmail || null,
            sent: deactivationEmailSent,
            error: deactivationEmailError,
          },
          deleted: {
            accessRules: accessRules.count,
            trustedDevices: trustedDevices.count,
            authChallenges: authChallenges.count,
            automationOwnerships: automationOwnerships.count,
            commissioningSessions: commissioningSessions.count,
            homeAutomationRows: homeAutomationRowsDeleted.count,
            users: cleanupPending ? 0 : 1,
            userInactive: cleanupPending,
          },
          alexaDeleted: {
            authCodes: alexaAuthCodes.count,
            refreshTokens: alexaRefreshTokens.count,
            eventTokens: alexaEventTokens.count,
          },
          haCleanup: {
            automationsDeleted: automationResult.deleted,
            tenantDeviceCleanup: cleanupResult,
            triggerBindingCleanup,
            cleanupPending,
          },
        },
      },
    });

    const usersDeleted = cleanupPending
      ? { count: 0 }
      : await tx.user.deleteMany({
          where: { id: tenant.id, homeId },
        });
    if (cleanupPending) {
      await tx.user.update({
        where: { id: tenant.id },
        data: { isActive: false },
      });
    }

    return {
      accessRules: accessRules.count,
      trustedDevices: trustedDevices.count,
      authChallenges: authChallenges.count,
      alexaAuthCodes: alexaAuthCodes.count,
      alexaRefreshTokens: alexaRefreshTokens.count,
      alexaEventTokens: alexaEventTokens.count,
      commissioningSessions: commissioningSessions.count,
      automationOwnerships: automationOwnerships.count,
      homeAutomationRows: homeAutomationRowsDeleted.count,
      usersDeleted: usersDeleted.count,
    };
  });

  return NextResponse.json({
    ok: true,
    deleted: deletionResult,
    haCleanup: {
      automationsDeleted: automationResult.deleted,
      tenantDeviceCleanup: cleanupResult,
      triggerBindingCleanup,
      cleanupPending,
    },
  });
}
