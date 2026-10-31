import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { recordFailedAuthentication, requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { verifyPassword } from '@/lib/passwords';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';
import { dispatchHomeownerAccessRemovalNotices } from '@/lib/installationRequestDelivery';
import { queueMfaChangedNotice } from '@/lib/roomAccessNotices';
import { accountMfaRequirement, issueMfaChallenge, maskEmail, mfaEnforced, MFA_PURPOSE, MFA_SNOOZE_MS, mfaFailureError, mfaPromptState, sessionBinding, verifyMfaChallenge } from '@/lib/accountMfa';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

async function status(accountId: string, email: string) {
  const [requirement, account] = await Promise.all([
    accountMfaRequirement(prisma, accountId),
    prisma.customerAccount.findUnique({ where: { id: accountId }, select: { mfaPromptSnoozedUntil: true, mfaPromptDismissCount: true } }),
  ]);
  const available = mfaEnforced();
  return { schemaVersion: 'dinodia.v1' as const, ok: true as const, available, requirement: requirement.requirement, reason: requirement.reason,
    enabled: requirement.requirement !== 'NONE', canTurnOff: requirement.requirement === 'ENABLED', maskedEmail: maskEmail(email),
    promptDue: available && account ? mfaPromptState(account, requirement) : false };
}

/** Where this account stands: whether it is on, whether it is required (and why), and whether to nudge. */
export async function GET(request: Request) {
  try {
    const principal = await requireCustomerAccountSession(request);
    return NextResponse.json(await status(principal.id, principal.email), { headers: NO_STORE });
  } catch (error) { return nativeV1ErrorResponse(error); }
}

function challengeJson(issued: { challengeId: string; clientSecret: string; maskedEmail: string; expiresAt: Date; resendAvailableAt: Date }) {
  return { schemaVersion: 'dinodia.v1' as const, ok: true as const, challengeId: issued.challengeId, clientSecret: issued.clientSecret, maskedEmail: issued.maskedEmail,
    expiresAt: issued.expiresAt.toISOString(), resendAvailableAt: issued.resendAvailableAt.toISOString(), codeLength: 6 };
}

/**
 * Turn two-step verification on or off, and put the reminder off. Turning it on needs a code sent to the account's email;
 * turning it off needs the password and a code. Homeowners and property managers cannot turn it off.
 */
export async function POST(request: Request) {
  try {
    const principal = await requireCustomerAccountSession(request);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || Array.isArray(body) || typeof body.action !== 'string') throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'An action is required');
    if (!mfaEnforced()) throw new Stage1AuthError(404, 'FEATURE_NOT_ENABLED', 'Two-step verification is not available yet');
    const binding = sessionBinding(principal.sessionId);
    const requirement = await accountMfaRequirement(prisma, principal.id);

    if (body.action === 'snooze_prompt') {
      await prisma.customerAccount.update({ where: { id: principal.id }, data: { mfaPromptSnoozedUntil: new Date(Date.now() + MFA_SNOOZE_MS), mfaPromptDismissCount: { increment: 1 } } });
      return NextResponse.json(await status(principal.id, principal.email), { headers: NO_STORE });
    }
    if (body.action === 'enable_start') {
      if (requirement.requirement !== 'NONE') throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'Two-step verification is already on for this account.');
      const issued = await issueMfaChallenge({ accountId: principal.id, email: principal.email, purpose: MFA_PURPOSE.ENABLE, bindingHash: binding });
      return NextResponse.json(challengeJson(issued), { headers: NO_STORE });
    }
    if (body.action === 'enable_confirm') {
      const result = await verifyMfaChallenge({ challengeId: body.challengeId, clientSecret: body.clientSecret, code: body.code, purpose: MFA_PURPOSE.ENABLE, bindingHash: binding });
      if (!result.ok) throw mfaFailureError(result);
      const now = new Date();
      await prisma.$transaction(async (tx) => {
        await tx.customerAccount.update({ where: { id: principal.id }, data: { mfaEnabledAt: now } });
        await tx.auditEvent.create({ data: { actorType: 'CUSTOMER', actorId: principal.id, category: 'SECURITY', action: 'mfa_enabled', targetType: 'CustomerAccount', targetId: principal.id,
          metadata: { sessionId: principal.sessionId }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
        await queueMfaChangedNotice(tx, { accountId: principal.id, enabled: true, now });
      });
      try { await dispatchHomeownerAccessRemovalNotices(); } catch { /* the scheduled dispatcher retries */ }
      return NextResponse.json(await status(principal.id, principal.email), { headers: NO_STORE });
    }
    if (body.action === 'disable_start') {
      if (requirement.requirement === 'REQUIRED') throw new Stage1AuthError(403, 'SCOPE_DENIED', 'Two-step verification is required for homeowners and property managers and cannot be turned off.');
      if (requirement.requirement !== 'ENABLED') throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'Two-step verification is already off.');
      if (typeof body.password !== 'string' || !body.password || body.password.length > 1024) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'Your password is required');
      await enforcePersistentRateLimit(`mfa-disable:${principal.id}`, 5, 15 * 60 * 1000);
      const account = await prisma.customerAccount.findUnique({ where: { id: principal.id }, select: { passwordHash: true } });
      if (!account || !(await verifyPassword(body.password, account.passwordHash))) {
        await recordFailedAuthentication('mfa_disable_password_failed', principal.email);
        throw new Stage1AuthError(401, 'AUTH_REQUIRED', 'That password isn’t right.');
      }
      const issued = await issueMfaChallenge({ accountId: principal.id, email: principal.email, purpose: MFA_PURPOSE.DISABLE, bindingHash: binding });
      return NextResponse.json(challengeJson(issued), { headers: NO_STORE });
    }
    if (body.action === 'disable_confirm') {
      if (requirement.requirement !== 'ENABLED') throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'Two-step verification cannot be turned off for this account.');
      const result = await verifyMfaChallenge({ challengeId: body.challengeId, clientSecret: body.clientSecret, code: body.code, purpose: MFA_PURPOSE.DISABLE, bindingHash: binding });
      if (!result.ok) throw mfaFailureError(result);
      const now = new Date();
      await prisma.$transaction(async (tx) => {
        await tx.customerAccount.update({ where: { id: principal.id }, data: { mfaEnabledAt: null } });
        await tx.auditEvent.create({ data: { actorType: 'CUSTOMER', actorId: principal.id, category: 'SECURITY', action: 'mfa_disabled', targetType: 'CustomerAccount', targetId: principal.id,
          metadata: { sessionId: principal.sessionId }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
        await queueMfaChangedNotice(tx, { accountId: principal.id, enabled: false, now });
      });
      try { await dispatchHomeownerAccessRemovalNotices(); } catch { /* the scheduled dispatcher retries */ }
      return NextResponse.json(await status(principal.id, principal.email), { headers: NO_STORE });
    }
    throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'That action is not recognised');
  } catch (error) { return nativeV1ErrorResponse(error); }
}
