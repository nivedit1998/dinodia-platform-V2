// Architecture: API boundary /admin/profile/ha-settings; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { Prisma, Role } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { getUserWithHaConnection } from '@/lib/haConnection';
import { requireTrustedAdminDevice, toTrustedDeviceResponse } from '@/lib/deviceAuth';
import { buildEncryptedHaSecrets, hashSecretForLookup } from '@/lib/haSecrets';
import { getActiveInstallerImpersonation } from '@/lib/installerSupportScope';
import { hashForLog, safeLog } from '@/lib/safeLogger';

function normalizeHaBaseUrl(value: string) {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('That doesn’t look like a valid Dinodia Hub address. It should start with http:// or https://');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Dinodia Hub addresses must start with http:// or https://');
  }
  return trimmed.replace(/\/+$/, '');
}

function normalizeCloudUrl(value: string) {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Cloud URL must be a valid https:// URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Cloud URL must start with https://');
  }
  const host = parsed.hostname.toLowerCase();
  const allowedSuffix = '.dinodiasmartliving.com';
  if (!host.endsWith(allowedSuffix)) {
    throw new Error('Cloud URL must end with dinodiasmartliving.com');
  }
  return parsed.toString().replace(/\/+$/, '');
}

async function ensureAdminWithConnection(adminId: number) {
  try {
    return await getUserWithHaConnection(adminId);
  } catch {
    throw new Error('Dinodia Hub connection isn’t set up yet for this home.');
  }
}

async function guardAdminDevice(req: NextRequest, userId: number) {
  try {
    await requireTrustedAdminDevice(req, userId);
    return null;
  } catch (err) {
    const deviceError = toTrustedDeviceResponse(err);
    if (deviceError) return deviceError;
    throw err;
  }
}

async function guardInstallerImpersonation(req: NextRequest) {
  const impersonation = await getActiveInstallerImpersonation(req);
  if (!impersonation) return null;
  return apiFailFromStatus(403, 'Installer impersonation cannot access Home Assistant credential settings.');
}

export async function GET(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.ADMIN) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }

  const impersonationError = await guardInstallerImpersonation(req);
  if (impersonationError) return impersonationError;

  const deviceError = await guardAdminDevice(req, me.id);
  if (deviceError) return deviceError;

  try {
    const { haConnection } = await ensureAdminWithConnection(me.id);
    return NextResponse.json({
      haUsername: haConnection.haUsername ?? '',
      haBaseUrl: haConnection.baseUrl ?? '',
      haCloudUrl: haConnection.cloudUrl ?? '',
      cloudEnabled: Boolean(haConnection.cloudUrl?.trim()),
      hasHaPassword: Boolean(haConnection.haPassword),
      hasLongLivedToken: Boolean(haConnection.longLivedToken),
    });
  } catch {
    return apiFailFromStatus(400, 'We couldn’t load your Dinodia Hub settings. Please try again.');
  }
}

export async function PUT(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.ADMIN) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }

  const impersonationError = await guardInstallerImpersonation(req);
  if (impersonationError) return impersonationError;

  const deviceError = await guardAdminDevice(req, me.id);
  if (deviceError) return deviceError;

  let body: {
    haUsername?: string;
    haPassword?: string;
    haBaseUrl?: string;
    haCloudUrl?: string;
    haLongLivedToken?: string;
  };
  try {
    body = await req.json();
  } catch {
    return apiFailFromStatus(400, 'Invalid request. Please check the details and try again.');
  }

  const { haUsername, haPassword, haBaseUrl, haCloudUrl, haLongLivedToken } = body ?? {};

  if (typeof haUsername !== 'string' || !haUsername.trim()) {
    return apiFailFromStatus(400, 'Enter the username you use to sign into your Dinodia Hub.');
  }
  if (typeof haBaseUrl !== 'string' || !haBaseUrl.trim()) {
    return apiFailFromStatus(400, 'Enter the local address of your Dinodia Hub (for example, http://homeassistant.local:8123).');
  }

  let normalizedBaseUrl: string;
  try {
    normalizedBaseUrl = normalizeHaBaseUrl(haBaseUrl);
  } catch (err) {
    return apiFailFromStatus(400, (err as Error).message);
  }

  if (typeof haCloudUrl === 'string' && haCloudUrl.trim().length > 0) {
    try {
      // Validate early; stored below.
      normalizeCloudUrl(haCloudUrl);
    } catch (err) {
      return apiFailFromStatus(400, (err as Error).message);
    }
  }

  let haContext;
  try {
    haContext = await ensureAdminWithConnection(me.id);
  } catch {
    return apiFailFromStatus(400, 'Dinodia Hub connection isn’t set up yet for this home.');
  }

  const encrypted = buildEncryptedHaSecrets({
    haUsername: haUsername.trim(),
    haPassword:
      typeof haPassword === 'string' && haPassword.length > 0 ? haPassword : undefined,
    longLivedToken:
      typeof haLongLivedToken === 'string' && haLongLivedToken.length > 0
        ? haLongLivedToken
        : undefined,
  });

  const updateData: Prisma.HaConnectionUpdateInput = {
    baseUrl: normalizedBaseUrl,
  };

  if (encrypted.haUsername !== undefined) {
    updateData.haUsername = encrypted.haUsername;
  }
  if (encrypted.haUsernameCiphertext !== undefined) {
    updateData.haUsernameCiphertext = encrypted.haUsernameCiphertext;
  }
  if (encrypted.haPassword !== undefined) {
    updateData.haPassword = encrypted.haPassword;
  }
  if (encrypted.haPasswordCiphertext !== undefined) {
    updateData.haPasswordCiphertext = encrypted.haPasswordCiphertext;
  }
  if (encrypted.longLivedToken !== undefined) {
    updateData.longLivedToken = encrypted.longLivedToken;
  }
  if (encrypted.longLivedTokenCiphertext !== undefined) {
    updateData.longLivedTokenCiphertext = encrypted.longLivedTokenCiphertext;
  }

  if (typeof haLongLivedToken === 'string' && haLongLivedToken.length > 0) {
    updateData.longLivedTokenHash = hashSecretForLookup(haLongLivedToken);
  }

  if (typeof haCloudUrl === 'string' && haCloudUrl.trim().length > 0) {
    try {
      updateData.cloudUrl = normalizeCloudUrl(haCloudUrl);
    } catch (err) {
      return apiFailFromStatus(400, (err as Error).message);
    }
  }

  const updated = await prisma.haConnection.update({
    where: { id: haContext.haConnection.id },
    data: updateData,
    select: {
      haUsername: true,
      haUsernameCiphertext: true,
      baseUrl: true,
      cloudUrl: true,
      haPassword: true,
      haPasswordCiphertext: true,
      longLivedToken: true,
      longLivedTokenCiphertext: true,
    },
  });

  safeLog('info', '[ha-settings] Updated HA settings for admin', { userIdHash: hashForLog(String(me.id)) });

  return NextResponse.json({
    ok: true,
    haUsername: updated.haUsername ?? '',
    haBaseUrl: updated.baseUrl ?? '',
    cloudEnabled: Boolean(updated.cloudUrl?.trim()),
    hasHaPassword: Boolean(updated.haPasswordCiphertext ?? updated.haPassword),
    hasLongLivedToken: Boolean(updated.longLivedTokenCiphertext ?? updated.longLivedToken),
  });
}
