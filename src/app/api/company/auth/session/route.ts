import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { verifyPassword } from '@/lib/passwords';
import { signStage1Token } from '@/lib/stage1Crypto';
import { authErrorResponse, recordFailedAuthentication, requireEmployeeToken, Stage1AuthError } from '@/lib/stage1Auth';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';

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
    const now = new Date();
    // Bind the durable row to the signed token's session identifier.  The
    // browser never receives a separate raw lookup secret, so storing a hash
    // of an unrelated transient value would make every real session unusable.
    const sessionId = crypto.randomUUID();
    const session = await prisma.$transaction(async (tx) => {
      const created = await tx.employeeSession.create({ data: { id: sessionId, employeeId: employee.id, tokenHash: crypto.createHash('sha256').update(sessionId).digest('hex'), recentAuthenticatedAt: now, expiresAt: new Date(now.getTime() + 8 * 60 * 60 * 1000) }, select: { id: true, recentAuthenticatedAt: true, expiresAt: true } });
      await tx.auditEvent.create({ data: { actorType: 'EMPLOYEE', actorId: employee.id, category: 'SECURITY', action: 'employee_login_succeeded', targetType: 'EmployeeSession', targetId: created.id, metadata: { outcome: 'succeeded' }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      return created;
    });
    const token = signStage1Token('employee', { id: employee.id, sessionId: session.id, areaIds: [], scopes: ['company:portal'], policyRevision: 0, issuedAt: Math.floor(now.getTime() / 1000), expiresAt: Math.floor(session.expiresAt.getTime() / 1000), recentAuthenticatedAt: now.getTime() }, signingKey());
    return NextResponse.json({ ok: true, employee: { id: employee.id, role: employee.role }, expiresAt: session.expiresAt }, { headers: { 'Set-Cookie': `dinodia_employee_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=28800`, 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}

export async function DELETE(request: Request) {
  const value = request.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith('dinodia_employee_session='))?.slice('dinodia_employee_session='.length) ?? '';
  if (value) {
    try {
      const principal = await requireEmployeeToken(decodeURIComponent(value));
      await prisma.employeeSession.updateMany({ where: { id: principal.sessionId, employeeId: principal.id, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date() } });
    } catch {
      // Logout is idempotent for an expired or already-invalid cookie.
    }
  }
  return new NextResponse(null, { status: 204, headers: { 'Set-Cookie': 'dinodia_employee_session=; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=0', 'Cache-Control': 'no-store' } });
}
