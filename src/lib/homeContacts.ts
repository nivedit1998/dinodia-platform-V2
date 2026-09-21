// Architecture: Shared platform helper src/lib/homeContacts.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import 'server-only';

import { HomeContactType } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export async function getPropertyManagerEmail(homeId: number): Promise<string | null> {
  const row = await prisma.homeContact.findUnique({
    where: { homeId_type: { homeId, type: HomeContactType.PROPERTY_MANAGER } },
    select: { email: true },
  });
  const email = row?.email?.trim();
  return email ? email : null;
}

export async function setPropertyManagerEmail(homeId: number, email: string): Promise<{ email: string }> {
  const trimmed = email.trim();
  const row = await prisma.homeContact.upsert({
    where: { homeId_type: { homeId, type: HomeContactType.PROPERTY_MANAGER } },
    create: { homeId, type: HomeContactType.PROPERTY_MANAGER, email: trimmed, verifiedAt: null },
    update: { email: trimmed },
    select: { email: true },
  });
  return { email: row.email };
}

export async function clearPropertyManagerEmail(homeId: number): Promise<void> {
  await prisma.homeContact.deleteMany({
    where: { homeId, type: HomeContactType.PROPERTY_MANAGER },
  });
}
