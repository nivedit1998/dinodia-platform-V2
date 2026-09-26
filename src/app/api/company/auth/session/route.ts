import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { verifyPassword } from '@/lib/passwords';
import { signStage1Token } from '@/lib/stage1Crypto';
import { authErrorResponse, recordFailedAuthentication, requireEmployee, requireEmployeeToken, Stage1AuthError } from '@/lib/stage1Auth';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';
import { DEFAULT_EMPLOYEE_SESSION_SECONDS, INTERNAL_EMPLOYEE_SESSION_SECONDS, INTERNAL_OPERATOR_DAY_SESSION_POLICY, internalOperatorDaySessionEnabled, stage1NowMs } from '@/lib/internalOperatorDaySession';

export const dynamic = 'force-dynamic';

function signingKey(): crypto.KeyObject {
  const pem = String(process.env.COMPANY_PORTAL_SESSION_PRIVATE_KEY ?? '').replaceAll('\\n', '\n');
  if (!pem) throw new Stage1AuthError(503, 'employee_auth_unconfigured', 'Company Portal authentication is not configured');
  try { return crypto.createPrivateKey(pem); } catch { throw new Stage1AuthError(503, 'employee_auth_unconfigured', 'Company Portal authentication is not configured'); }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    if (!email || !password || password.length > 512) {
      await recordFailedAuthentication('employee_login_failed', email || 'missing-email');
      throw new Stage1AuthError(400, 'employee_credentials_invalid', 'Email and password are required');
    }
    await enforcePersistentRateLimit(`employee-login:${crypto.createHash('sha256').update(email, 'utf8').digest('hex')}`, 8, 15 * 60 * 1000);
    const employee = await prisma.companyEmployeeAccount.findUnique({ where: { emailNormalized: email }, select: { id: true, role: true, status: true, passwordHash: true } });
    if (!employee || employee.status !== 'ACTIVE' || !employee.passwordHash || !verifyPassword(password, employee.passwordHash)) {
      await recordFailedAuthentication('employee_login_failed', email);
      throw new Stage1AuthError(401, 'employee_credentials_invalid', 'The employee credentials are invalid');
    }
    const dayPolicyEnabled = internalOperatorDaySessionEnabled();
    const issuedAt = Math.floor(stage1NowMs() / 1000);
    const lifetimeSeconds = dayPolicyEnabled ? INTERNAL_EMPLOYEE_SESSION_SECONDS : DEFAULT_EMPLOYEE_SESSION_SECONDS;
    const now = new Date(issuedAt * 1000);
    const expiresAt = new Date((issuedAt + lifetimeSeconds) * 1000);
    // Bind the durable row to the signed token's session identifier.  The
    // browser never receives a separate raw lookup secret, so storing a hash
    // of an unrelated transient value would make every real session unusable.
    const sessionId = crypto.randomUUID();
    const session = await prisma.$transaction(async (tx) => {
      const created = await tx.employeeSession.create({ data: { id: sessionId, employeeId: employee.id, tokenHash: crypto.createHash('sha256').update(sessionId).digest('hex'), recentAuthenticatedAt: now, expiresAt }, select: { id: true, recentAuthenticatedAt: true, expiresAt: true } });
      await tx.auditEvent.create({ data: { actorType: 'EMPLOYEE', actorId: employee.id, category: 'SECURITY', action: 'employee_login_succeeded', targetType: 'EmployeeSession', targetId: created.id, metadata: { outcome: 'succeeded' }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      return created;
    });
    const token = signStage1Token('employee', { id: employee.id, sessionId: session.id, areaIds: [], scopes: ['company:portal'], policyRevision: 0, issuedAt, expiresAt: issuedAt + lifetimeSeconds, recentAuthenticatedAt: now.getTime(), ...(dayPolicyEnabled ? { sessionPolicy: INTERNAL_OPERATOR_DAY_SESSION_POLICY } : {}) }, signingKey());
    return NextResponse.json({ ok: true, employee: { id: employee.id, role: employee.role }, expiresAt: session.expiresAt }, { headers: { 'Set-Cookie': `dinodia_employee_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=${lifetimeSeconds}`, 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}

export async function DELETE(request: Request) {
  const value = request.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith('dinodia_employee_session='))?.slice('dinodia_employee_session='.length) ?? '';
  if (value) {
    try {
      const principal = await requireEmployeeToken(decodeURIComponent(value));
      const now = new Date(stage1NowMs());
      await prisma.$transaction(async (tx) => {
        await tx.employeeSession.updateMany({ where: { id: principal.sessionId, employeeId: principal.id, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: now } });
        const candidates = await tx.operatorHandoff.findMany({ where: { employeeId: principal.id, consumedAt: { not: null }, revokedAt: null }, select: { id: true, scope: true } });
        const owned = candidates.filter((row) => row.scope && typeof row.scope === 'object' && !Array.isArray(row.scope) && (row.scope as Record<string, unknown>).employeeSessionId === principal.sessionId);
        for (const row of owned) await tx.operatorHandoff.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: now } });
        await tx.auditEvent.create({ data: { actorType: 'EMPLOYEE', actorId: principal.id, category: 'SECURITY', action: 'employee_logout_succeeded', targetType: 'EmployeeSession', targetId: principal.sessionId, metadata: { outcome: 'revoked', affectedOperatorHandoffs: owned.length }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      });
    } catch {
      // Logout is idempotent for an expired or already-invalid cookie.
    }
  }
  return new NextResponse(null, { status: 204, headers: { 'Set-Cookie': 'dinodia_employee_session=; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=0', 'Cache-Control': 'no-store' } });
}

export async function GET(request: Request) {
  try {
    const principal = await requireEmployee(request);
    return NextResponse.json({ ok: true, expiresAt: new Date(principal.expiresAt).toISOString() }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
