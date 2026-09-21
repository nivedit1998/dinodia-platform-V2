// Architecture: Shared platform helper src/lib/accessScope.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { prisma } from '@/lib/prisma';
import { Role } from '@prisma/client';

export type ScopedHomeContext = {
  userId: number;
  role: Role;
  homeId: number;
  haConnectionId: number;
};

export async function getScopedHomeContext(userId: number): Promise<ScopedHomeContext> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      homeId: true,
      home: { select: { haConnectionId: true } },
    },
  });

  if (!user) throw new Error('User not found');
  if (!user.homeId) throw new Error('User is not linked to a home.');
  const haConnectionId = user.home?.haConnectionId;
  if (!haConnectionId) {
    throw new Error('Dinodia Hub connection isn’t set up yet for this home.');
  }

  return {
    userId: user.id,
    role: user.role,
    homeId: user.homeId,
    haConnectionId,
  };
}
