import type { Prisma, NativeSupportCategory } from '@prisma/client';
import { resolveNativeHomeContext } from './nativeHomeContext';

const categories = new Set<NativeSupportCategory>([
  'ACCOUNT_OR_SIGN_IN', 'ACCESS_OR_PERMISSIONS', 'DEVICE_PROBLEM', 'HUB_OR_CONNECTION', 'AUTOMATION', 'ALEXA', 'OTHER',
]);

export class NativeSupportInputError extends Error {
  constructor(readonly code: 'CATEGORY_INVALID' | 'DESCRIPTION_INVALID' | 'REFERENCE_INVALID') { super(code); }
}

export async function createNativeSupportTicket(
  db: Prisma.TransactionClient,
  input: {
    customerAccountId: string; membershipId: string; homeId: string;
    publicReference: string; category: NativeSupportCategory; description: string; now?: Date;
  },
) {
  if (!categories.has(input.category)) throw new NativeSupportInputError('CATEGORY_INVALID');
  if (typeof input.description !== 'string' || input.description.trim().length < 1 || [...input.description].length > 4000) throw new NativeSupportInputError('DESCRIPTION_INVALID');
  if (!/^DNO-[A-Z0-9_-]{1,17}$/.test(input.publicReference)) throw new NativeSupportInputError('REFERENCE_INVALID');
  const context = await resolveNativeHomeContext(db, {
    customerAccountId: input.customerAccountId, membershipId: input.membershipId, homeId: input.homeId,
  });
  const now = input.now ?? new Date();
  const purgeAt = new Date(now);
  purgeAt.setUTCMonth(purgeAt.getUTCMonth() + 12);
  return db.supportTicket.create({
    data: {
      publicReference: input.publicReference,
      customerAccountId: context.customerAccountId,
      homeId: context.homeId,
      selectedMembershipId: context.membershipId,
      category: input.category,
      nativeCategory: input.category,
      description: input.description.trim(),
      purgeAt,
      timeline: { create: {
        homeId: context.homeId,
        eventCode: 'CUSTOMER_CREATED',
        actorType: 'CUSTOMER',
        actorId: context.customerAccountId,
        customerVisible: true,
        safeSummary: 'Support request created',
        purgeAt,
        createdAt: now,
      } },
    },
    select: { id: true, publicReference: true, status: true, nativeCategory: true, createdAt: true },
  });
}
