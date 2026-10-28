import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { isAvatarColourKey, isAvatarIconKey, publicAvatar } from '@/lib/avatarCatalogue';
import { validateCustomerAvatarReceipt, validateCustomerAvatarRequest } from '@/lib/contracts/dinodiaV1';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

function receipt(account: { id: string; avatarIcon: string | null; avatarColour: string | null }) {
  return { schemaVersion: 'dinodia.v1', ok: true, avatar: publicAvatar(account) };
}

export async function GET(request: Request) {
  try {
    const principal = await requireCustomerAccountSession(request);
    const account = await prisma.customerAccount.findFirst({ where: { id: principal.id, status: 'ACTIVE', securityVersion: principal.securityVersion },
      select: { id: true, avatarIcon: true, avatarColour: true } });
    if (!account) throw new Stage1AuthError(401, 'customer_session_invalid', 'The customer account session is no longer active');
    const body = receipt(account);
    if (!validateCustomerAvatarReceipt(body)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The avatar response failed contract validation');
    return NextResponse.json(body, { headers });
  } catch (error) { return nativeV1ErrorResponse(error); }
}

/**
 * Choosing an icon is cosmetic: it needs a signed-in phone but no fresh Face ID, and it is a plain idempotent PUT
 * (the last choice wins). It deliberately leaves the profile revision untouched, so it never makes a profile edit
 * in progress on another screen fail with a conflict.
 */
export async function PUT(request: Request) {
  try {
    const principal = await requireCustomerAccountSession(request);
    const body = await request.json().catch(() => null);
    if (!validateCustomerAvatarRequest(body) || !(body.icon === null || isAvatarIconKey(body.icon)) || !isAvatarColourKey(body.colour)) {
      throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'Choose an icon and a colour from the list');
    }
    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.customerAccount.findFirst({ where: { id: principal.id, status: 'ACTIVE', securityVersion: principal.securityVersion },
        select: { id: true, avatarIcon: true, avatarColour: true, updatedAt: true } });
      if (!current) throw new Stage1AuthError(401, 'customer_session_invalid', 'The customer account session is no longer active');
      if (current.avatarIcon === body.icon && current.avatarColour === body.colour) return current;
      const now = new Date();
      const updated = await tx.customerAccount.update({ where: { id: current.id },
        data: { avatarIcon: body.icon, avatarColour: body.colour, avatarUpdatedAt: now, updatedAt: current.updatedAt },
        select: { id: true, avatarIcon: true, avatarColour: true } });
      await tx.auditEvent.create({ data: { actorType: 'CUSTOMER', actorId: principal.id, category: 'ACCESS', action: 'customer_avatar_changed',
        targetType: 'CustomerAccount', targetId: principal.id, metadata: { iconChosen: body.icon !== null },
        purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      return updated;
    });
    const out = receipt(result);
    if (!validateCustomerAvatarReceipt(out)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The avatar response failed contract validation');
    return NextResponse.json(out, { headers });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
