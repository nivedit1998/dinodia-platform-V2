import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/passwords';
import { sha256 } from '@/lib/stage1Crypto';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';
import { Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const invitation = String(body.invitation ?? '').trim();
    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '');
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(invitation) || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(username) || password.length < 12 || password.length > 512) throw new Stage1AuthError(400, 'bootstrap_completion_invalid', 'A valid invitation, username and password are required');
    await enforcePersistentRateLimit(`initial-cxo-bootstrap-complete:${sha256(invitation)}`, 5, 60 * 60 * 1000);
    const invitationHash = sha256(invitation);
    const now = new Date();
    const passwordHash = hashPassword(password);
    const result = await prisma.$transaction(async (tx) => {
      const ceremony = await tx.initialCxoBootstrap.findFirst({ where: { invitationHash, deliveryStatus: 'SENT', consumedAt: null, invitationExpiresAt: { gt: now } }, select: { id: true } });
      const employee = await tx.companyEmployeeAccount.findFirst({ where: { bootstrapInvitationHash: invitationHash, status: 'PENDING', bootstrapInvitationExpiresAt: { gt: now } }, select: { id: true, emailNormalized: true, role: true, bootstrapInvitationExpiresAt: true } });
      if (!employee || !ceremony) throw new Stage1AuthError(401, 'bootstrap_invitation_invalid', 'The employee invitation is invalid or expired');
      const updated = await tx.companyEmployeeAccount.updateMany({ where: { id: employee.id, status: 'PENDING', bootstrapInvitationHash: invitationHash, bootstrapInvitationExpiresAt: { gt: now } }, data: { username, passwordHash, emailVerifiedAt: now, status: 'ACTIVE', bootstrapInvitationHash: null, bootstrapInvitationExpiresAt: null, recentAuthenticationAt: null } });
      if (updated.count !== 1) throw new Stage1AuthError(409, 'bootstrap_invitation_replayed', 'The employee invitation was already completed');
      const consumed = await tx.initialCxoBootstrap.updateMany({ where: { id: ceremony.id, invitationHash, deliveryStatus: 'SENT', consumedAt: null }, data: { consumedAt: now, deliveryStatus: 'CONSUMED' } });
      if (consumed.count !== 1) throw new Stage1AuthError(409, 'bootstrap_invitation_replayed', 'The employee invitation was already completed');
      await tx.auditEvent.create({ data: { actorType: 'EMPLOYEE', actorId: employee.id, category: 'SECURITY', action: 'initial_cxo_bootstrap_completed', targetType: 'CompanyEmployeeAccount', targetId: employee.id, metadata: { outcome: 'completed', ceremony: 'initial-cxo-v1' }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      return { id: employee.id, emailNormalized: employee.emailNormalized, role: employee.role };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return NextResponse.json({ ok: true, employee: result }, { status: 201, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
