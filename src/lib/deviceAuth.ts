// Architecture: Shared platform helper src/lib/deviceAuth.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import 'server-only';

import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { getKioskAuthFromRequest } from './auth';
import { APP_ERROR_CODES } from './apiErrorCodes';
import { prisma } from './prisma';
import { DeviceBlockedError, ensureActiveDevice } from './deviceRegistry';
import { getActiveInstallerImpersonation } from './installerSupportScope';
import { hashForLog, safeLog } from './safeLogger';

export type DeviceHeaderInfo = {
  deviceId: string | null;
  deviceLabel: string | null;
};

export class TrustedDeviceError extends Error {
  status: number;

  constructor(message: string, status = 403) {
    super(message);
    this.status = status;
  }
}

const TRUST_ERROR_MESSAGE = 'This device is not trusted. Please sign in again.';

function logKioskDeviceSessionRejection(args: {
  reason: string;
  status: number;
  userId?: number | null;
  deviceId?: string | null;
  tokenSessionVersion?: number | null;
  currentTrustedSessionVersion?: number | null;
  error?: unknown;
}) {
  safeLog('warn', '[deviceAuth] kiosk device session rejected', {
    event: 'kiosk_device_session_rejected',
    reason: args.reason,
    status: args.status,
    userId: args.userId ?? null,
    deviceIdHash: hashForLog(args.deviceId),
    tokenSessionVersion: args.tokenSessionVersion ?? null,
    currentTrustedSessionVersion: args.currentTrustedSessionVersion ?? null,
    error: args.error instanceof Error ? args.error : undefined,
  });
}

export function readDeviceHeaders(req: NextRequest): DeviceHeaderInfo {
  const clean = (value: string | null) => {
    if (!value) return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  return {
    deviceId: clean(req.headers.get('x-device-id')),
    deviceLabel: clean(req.headers.get('x-device-label')),
  };
}

export function toTrustedDeviceResponse(err: unknown): NextResponse | null {
  if (err instanceof TrustedDeviceError) {
    return NextResponse.json(
      {
        error: err.message,
        errorCode: APP_ERROR_CODES.DEVICE_NOT_TRUSTED,
      },
      { status: err.status }
    );
  }
  return null;
}

export async function requireKioskDeviceSession(req: NextRequest): Promise<{
  user: { id: number; username: string; role: Role };
  deviceId: string;
}> {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.toLowerCase().startsWith('bearer ')) {
    logKioskDeviceSessionRejection({
      reason: 'missing_bearer',
      status: 401,
      deviceId: req.headers.get('x-device-id'),
    });
    throw new TrustedDeviceError(TRUST_ERROR_MESSAGE, 401);
  }

  const kioskAuth = await getKioskAuthFromRequest(req);
  if (!kioskAuth) {
    logKioskDeviceSessionRejection({
      reason: 'invalid_kiosk_jwt',
      status: 401,
      deviceId: req.headers.get('x-device-id'),
    });
    throw new TrustedDeviceError(TRUST_ERROR_MESSAGE, 401);
  }

  const { user, deviceId, sessionVersion } = kioskAuth;
  if (!deviceId) {
    logKioskDeviceSessionRejection({
      reason: 'missing_device_id_claim',
      status: 401,
      userId: user.id,
      tokenSessionVersion: sessionVersion,
    });
    throw new TrustedDeviceError(TRUST_ERROR_MESSAGE, 401);
  }

  try {
    await ensureActiveDevice(deviceId);
  } catch (err) {
    logKioskDeviceSessionRejection({
      reason: err instanceof DeviceBlockedError ? 'device_registry_blocked' : 'device_registry_invalid',
      status: err instanceof DeviceBlockedError ? 403 : 401,
      userId: user.id,
      deviceId,
      tokenSessionVersion: sessionVersion,
      error: err,
    });
    throw err instanceof DeviceBlockedError
      ? new TrustedDeviceError(TRUST_ERROR_MESSAGE, 403)
      : new TrustedDeviceError(TRUST_ERROR_MESSAGE, 401);
  }

  const trusted = (await prisma.trustedDevice.findUnique({
    where: { userId_deviceId: { userId: user.id, deviceId } },
  })) as unknown as { revokedAt?: Date | null; sessionVersion?: number | null } | null;

  if (!trusted || trusted.revokedAt !== null) {
    const status = trusted ? 403 : 401;
    logKioskDeviceSessionRejection({
      reason: trusted ? 'trusted_device_revoked' : 'trusted_row_missing',
      status,
      userId: user.id,
      deviceId,
      tokenSessionVersion: sessionVersion,
      currentTrustedSessionVersion: trusted ? Number(trusted.sessionVersion ?? 0) : null,
    });
    throw new TrustedDeviceError(TRUST_ERROR_MESSAGE, status);
  }

  const currentVersion = Number(trusted.sessionVersion ?? 0);
  if (currentVersion !== Number(sessionVersion ?? 0)) {
    logKioskDeviceSessionRejection({
      reason: 'session_version_mismatch',
      status: 401,
      userId: user.id,
      deviceId,
      tokenSessionVersion: sessionVersion,
      currentTrustedSessionVersion: currentVersion,
    });
    throw new TrustedDeviceError(TRUST_ERROR_MESSAGE, 401);
  }

  return { user, deviceId };
}

export async function requireTrustedAdminDevice(req: NextRequest, userId: number): Promise<void> {
  const installerImpersonation = await getActiveInstallerImpersonation(req);
  if (installerImpersonation) {
    const installerDeviceId = installerImpersonation.installerDeviceId.trim();
    if (!installerDeviceId) {
      throw new TrustedDeviceError(TRUST_ERROR_MESSAGE, 401);
    }
    try {
      await ensureActiveDevice(installerDeviceId);
    } catch (err) {
      const status = err instanceof DeviceBlockedError ? 403 : 401;
      throw new TrustedDeviceError(TRUST_ERROR_MESSAGE, status);
    }

    const trustedInstallerDevice = await prisma.trustedDevice.findUnique({
      where: {
        userId_deviceId: {
          userId: installerImpersonation.installerUserId,
          deviceId: installerDeviceId,
        },
      },
      select: { revokedAt: true },
    });
    if (!trustedInstallerDevice) {
      throw new TrustedDeviceError(TRUST_ERROR_MESSAGE, 401);
    }
    if (trustedInstallerDevice.revokedAt) {
      throw new TrustedDeviceError(TRUST_ERROR_MESSAGE, 403);
    }
    return;
  }

  const { deviceId } = readDeviceHeaders(req);
  const kioskAuth = await getKioskAuthFromRequest(req);
  if (kioskAuth) {
    // Enforce kiosk session checks (device active + trusted + sessionVersion match).
    const session = await requireKioskDeviceSession(req);
    if (session.user.id !== userId) {
      throw new TrustedDeviceError(TRUST_ERROR_MESSAGE, 401);
    }
    return;
  }

  if (!deviceId) {
    throw new TrustedDeviceError(TRUST_ERROR_MESSAGE, 401);
  }

  try {
    await ensureActiveDevice(deviceId);
  } catch (err) {
    const status = err instanceof DeviceBlockedError ? 403 : 401;
    throw new TrustedDeviceError(TRUST_ERROR_MESSAGE, status);
  }

  const trusted = await prisma.trustedDevice.findUnique({
    where: { userId_deviceId: { userId, deviceId } },
    select: { revokedAt: true },
  });
  if (!trusted) {
    throw new TrustedDeviceError(TRUST_ERROR_MESSAGE, 401);
  }
  if (trusted.revokedAt) {
    throw new TrustedDeviceError(TRUST_ERROR_MESSAGE, 403);
  }
}

// Alias for installers/other privileged flows.
export async function requireTrustedPrivilegedDevice(req: NextRequest, userId: number): Promise<void> {
  return requireTrustedAdminDevice(req, userId);
}
