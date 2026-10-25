import { prisma } from '@/lib/prisma';
import { serializableTransaction } from '@/lib/serializableTransaction';
import { alexaOAuthClientAuthenticated, alexaOAuthConfig } from '@/lib/nativeAlexaOAuth';
import { sha256 } from '@/lib/stage1Crypto';

export const dynamic = 'force-dynamic';

function response() {
  return Response.json({ revoked: true }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
}

export async function POST(request: Request) {
  const config = alexaOAuthConfig();
  if (!config || !String(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) return response();
  const raw = await request.text();
  if (Buffer.byteLength(raw, 'utf8') > 8192) return response();
  const fields = new URLSearchParams(raw);
  if ([...fields.keys()].some((key) => !['token', 'token_type_hint', 'client_id'].includes(key))
    || ['token'].some((key) => fields.getAll(key).length !== 1)
    || !alexaOAuthClientAuthenticated(request, fields, config)) return response();
  const token = fields.get('token') ?? '';
  if (!/^dno-alexa-(?:access|refresh)-[A-Za-z0-9_-]{40,128}$/.test(token)) return response();
  const tokenHash = sha256(token);
  const access = token.startsWith('dno-alexa-access-');
  const candidate = access
    ? await prisma.alexaOAuthAccessToken.findUnique({ where: { tokenHash }, select: { id: true, familyId: true, family: { select: { linkId: true, link: { select: { customerAccountId: true } } } } } })
    : await prisma.alexaOAuthRefreshToken.findUnique({ where: { tokenHash }, select: { id: true, familyId: true, family: { select: { linkId: true, link: { select: { customerAccountId: true } } } } } });
  if (!candidate) return response();

  await serializableTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${candidate.family.link.customerAccountId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AlexaNativeLink" WHERE "id" = ${candidate.family.linkId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AlexaOAuthTokenFamily" WHERE "linkId" = ${candidate.family.linkId}::uuid ORDER BY "id" FOR UPDATE`;
    const link = await tx.alexaNativeLink.findUnique({ where: { id: candidate.family.linkId }, select: { id: true, status: true, revokedAt: true } });
    if (!link || link.revokedAt || link.status !== 'ACTIVE') return;
    const now = new Date();
    await tx.alexaNativeLink.update({ where: { id: link.id }, data: { status: 'REVOKED', revokedAt: now, revision: { increment: 1 }, updatedAt: now } });
    const scopes = await tx.alexaNativeHomeScope.findMany({ where: { linkId: link.id, revokedAt: null }, select: { id: true } });
    const scopeIds = scopes.map((scope) => scope.id);
    if (scopeIds.length) await tx.alexaNativeAreaSelection.updateMany({ where: { homeScopeId: { in: scopeIds }, revokedAt: null }, data: { revokedAt: now, updatedAt: now } });
    await tx.alexaNativeHomeScope.updateMany({ where: { linkId: link.id, revokedAt: null }, data: { revokedAt: now, updatedAt: now } });
    await tx.alexaNativeEndpointProjection.updateMany({ where: { linkId: link.id, status: { not: 'REVOKED' } }, data: { status: 'REVOKED', updatedAt: now } });
    const families = await tx.alexaOAuthTokenFamily.findMany({ where: { linkId: link.id }, select: { id: true } });
    const familyIds = families.map((family) => family.id);
    await tx.alexaOAuthTokenFamily.updateMany({ where: { linkId: link.id, revokedAt: null }, data: { revokedAt: now, revokeReason: 'provider_revocation' } });
    if (familyIds.length) await tx.alexaOAuthAccessToken.updateMany({ where: { familyId: { in: familyIds }, revokedAt: null }, data: { revokedAt: now } });
    if (familyIds.length) await tx.alexaOAuthRefreshToken.updateMany({ where: { familyId: { in: familyIds }, revokedAt: null }, data: { revokedAt: now } });
  }, 2);
  return response();
}
