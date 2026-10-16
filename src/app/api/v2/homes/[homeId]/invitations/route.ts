import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { validateHomePendingInvitationsReceipt } from '@/lib/contracts/dinodiaV1';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Cursor = { createdAt: Date; id: string };

function parseCursor(value: string | null): Cursor | null {
  if (value === null) return null;
  if (value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The invitation page cursor is invalid');
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== value) throw new Error('non-canonical cursor');
    const separator = decoded.indexOf('|');
    const timestamp = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    const createdAt = new Date(timestamp);
    if (separator < 1 || !UUID.test(id) || Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== timestamp) throw new Error('invalid cursor');
    return { createdAt, id };
  } catch {
    throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The invitation page cursor is invalid');
  }
}

function makeCursor(value: Cursor): string {
  return Buffer.from(`${value.createdAt.toISOString()}|${value.id}`, 'utf8').toString('base64url');
}

export async function GET(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const customer = await requireCustomerAccountSession(request);
    const { homeId } = await context.params;
    const url = new URL(request.url);
    if (!UUID.test(homeId)) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Pending invitations are not available');
    if ([...url.searchParams.keys()].some((key) => key !== 'cursor') || url.searchParams.getAll('cursor').length > 1)
      throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The invitation page query is invalid');
    const cursor = parseCursor(url.searchParams.get('cursor'));
    const [home, membership] = await Promise.all([
      prisma.home.findUnique({ where: { id: homeId }, select: { id: true, lifecycle: true, installationStatus: true, managementRevision: true } }),
      prisma.homeMembership.findUnique({ where: { customerAccountId_homeId: { customerAccountId: customer.id, homeId } }, select: { id: true, role: true, status: true } }),
    ]);
    if (!home || home.lifecycle !== 'ACTIVE' || home.installationStatus !== 'COMPLETE' || membership?.status !== 'ACTIVE'
      || !['OWNER', 'PROPERTY_MANAGER'].includes(membership.role)) {
      throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Pending invitations are not available');
    }
    const viewerRole = membership.role as 'OWNER'|'PROPERTY_MANAGER';

    const now = new Date();
    const rows = await prisma.membershipInvitation.findMany({
      where: {
        homeId, state: 'PENDING', expiresAt: { gt: now },
        ...(membership.role === 'PROPERTY_MANAGER' ? { role: 'TENANT' as const } : {}),
        ...(cursor ? { OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: PAGE_SIZE + 1,
      select: {
        id: true, targetEmail: true, role: true, createdAt: true, expiresAt: true,
        inviter: { select: { customerAccountId: true } },
        areas: { select: { areaId: true, area: { select: { originalName: true, overrideName: true } } } },
      },
    });
    const page = rows.slice(0, PAGE_SIZE);
    const invitationIds = page.map((row) => row.id);
    const actorIds = [...new Set(page.map((row) => row.inviter.customerAccountId))];
    const receiptRows = invitationIds.length === 0 ? [] : await prisma.$queryRaw<Array<{ invitationId: string; emailSubmission: string }>>`
      SELECT "responseBody"->>'invitationId' AS "invitationId",
             "responseBody"->>'emailSubmission' AS "emailSubmission"
      FROM "IdempotencyRecord"
      WHERE "namespace" = 'customer-membership-invitation:v1'
        AND "homeId" = ${homeId}::uuid
        AND "actorId" = ANY(${actorIds}::uuid[])
        AND "expiresAt" > ${now}
        AND "responseBody"->>'invitationId' = ANY(${invitationIds}::text[])
      ORDER BY "createdAt" DESC`;
    const deliveryByInvitation = new Map<string, 'PENDING'|'ACCEPTED'|'NOT_SENT'|'FAILED'>();
    for (const row of receiptRows) {
      if (!deliveryByInvitation.has(row.invitationId)
        && ['PENDING', 'ACCEPTED', 'NOT_SENT', 'FAILED'].includes(row.emailSubmission)) {
        deliveryByInvitation.set(row.invitationId, row.emailSubmission as 'PENDING'|'ACCEPTED'|'NOT_SENT'|'FAILED');
      }
    }
    const receipt = {
      schemaVersion: 'dinodia.v1', ok: true as const, homeId, managementRevision: home.managementRevision,
      generatedAt: now.toISOString(),
      invitations: page.map((row) => ({
        invitationId: row.id, targetEmail: row.targetEmail, role: row.role, state: 'PENDING' as const,
        createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
        deliveryStatus: deliveryByInvitation.get(row.id) ?? 'UNKNOWN',
        areas: row.areas.map((entry) => ({ areaId: entry.areaId, name: entry.area.overrideName ?? entry.area.originalName })),
      })),
      nextCursor: rows.length > PAGE_SIZE ? makeCursor({ createdAt: page[page.length - 1].createdAt, id: page[page.length - 1].id }) : null,
    };
    if (!validateHomePendingInvitationsReceipt(receipt, homeId, viewerRole)) {
      throw new Stage1AuthError(500, 'INTERNAL_ERROR', 'The pending invitation projection failed contract validation');
    }
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
