// Architecture: Shared platform helper src/lib/haConnection.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { prisma } from '@/lib/prisma';
import type { HaConnectionLike } from '@/lib/homeAssistant';
import { resolveHaLongLivedToken } from '@/lib/haSecrets';

export type ViewMode = 'home' | 'holiday';

const userInclude = {
  home: {
    include: {
      haConnection: true,
    },
  },
  accessRules: true,
} as const;

export async function getUserWithHaConnection(userId: number) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: userInclude,
  });

  if (!user) throw new Error('User not found');

  const haConnection = user.home?.haConnection ?? null;
  if (!user.home || !haConnection) {
    throw new Error('Dinodia Hub connection isn’t set up yet for this home.');
  }

  const { longLivedToken } = resolveHaLongLivedToken(haConnection);
  const hydrated = { ...haConnection, longLivedToken };

  return { user, haConnection: hydrated };
}

export async function getCloudEnabledForUser(userId: number): Promise<boolean> {
  try {
    const { haConnection } = await getUserWithHaConnection(userId);
    return Boolean(haConnection.cloudUrl?.trim());
  } catch {
    return false;
  }
}

export function resolveHaForMode(
  haConnection: { baseUrl: string; cloudUrl: string | null; longLivedToken: string },
  mode: ViewMode
): HaConnectionLike {
  const cloud = typeof haConnection.cloudUrl === 'string' ? haConnection.cloudUrl.trim() : '';
  const hasCloud = cloud.length > 0;
  const useCloud = mode === 'holiday' && hasCloud;

  return {
    baseUrl: useCloud ? cloud : haConnection.baseUrl,
    longLivedToken: haConnection.longLivedToken,
  };
}

export function resolveHaCloudFirst(
  haConnection: { baseUrl: string; cloudUrl: string | null; longLivedToken: string }
): HaConnectionLike {
  const cloud = haConnection.cloudUrl?.trim();
  return {
    baseUrl: cloud && cloud.length > 0 ? cloud : haConnection.baseUrl,
    longLivedToken: haConnection.longLivedToken,
  };
}

export function resolveHaForRequestedMode(
  haConnection: { baseUrl: string; cloudUrl: string | null; longLivedToken: string },
  mode?: 'home' | 'cloud'
): HaConnectionLike {
  const requested = mode === 'home' || mode === 'cloud' ? mode : null;
  if (requested === 'cloud') {
    const cloud = haConnection.cloudUrl?.trim();
    if (!cloud) {
      throw new Error('Remote access is required to use cloud mode.');
    }
    return { baseUrl: cloud, longLivedToken: haConnection.longLivedToken };
  }
  if (requested === 'home') {
    return { baseUrl: haConnection.baseUrl, longLivedToken: haConnection.longLivedToken };
  }
  return resolveHaCloudFirst(haConnection);
}
