import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { serializableTransaction } from '@/lib/serializableTransaction';
import { compareAndSetHomeDocument, NativeHomeDocumentError } from '@/lib/nativeHomeDocuments';
import { sha256 } from '@/lib/stage1Crypto';
import { floorplanDocument, submittedFloorplan } from '@/lib/homeFloorplan';
import type { Prisma } from '@prisma/client';

export const dynamic = 'force-dynamic';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyPattern = /^[A-Za-z0-9._:-]{16,160}$/;
const namespace = 'homeowner-floorplan:v1';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

function mapError(error: unknown): never {
  if (error instanceof NativeHomeDocumentError) {
    if (error.code === 'MEMBERSHIP_FORBIDDEN') throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Floorplan is unavailable for this selected Home');
    if (error.code === 'REVISION_CONFLICT') throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The floorplan changed. Reload it before editing again.');
    throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The floorplan is invalid for this Home');
  }
  throw error;
}

export async function GET(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const selected = await requireCustomerSelectedHome(request);
    const { homeId } = await context.params;
    if (!uuid.test(homeId) || selected.homeId !== homeId || !['OWNER', 'PROPERTY_MANAGER'].includes(selected.role)) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Floorplan is unavailable for this selected Home');
    const [row, activeRows] = await Promise.all([
      prisma.homeDocument.findUnique({ where: { homeId_kind: { homeId, kind: 'FLOORPLAN' } }, select: { revision: true, document: true } }),
      prisma.area.findMany({ where: { homeId, status: 'ACTIVE' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 64, select: { id: true } }),
    ]);
    // The saved plan is kept: rooms added since are placed beside it, rooms removed are dropped.
    const document = floorplanDocument(activeRows.map((area) => area.id), row?.document);
    return NextResponse.json({ schemaVersion: 'dinodia.v1', ok: true, homeId, revision: row?.revision ?? 0, document }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}

export async function PUT(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const selected = await requireCustomerSelectedHome(request);
    const { homeId } = await context.params;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const key = request.headers.get('idempotency-key') ?? '';
    if (!uuid.test(homeId) || selected.homeId !== homeId || !['OWNER', 'PROPERTY_MANAGER'].includes(selected.role)
      || selected.credentialKind !== 'account_access') throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Floorplan is unavailable for this selected Home');
    if (!keyPattern.test(key) || !body || Object.keys(body).sort().join(',') !== 'document,expectedRevision'
      || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0 || !body.document || typeof body.document !== 'object') {
      throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A valid floorplan, revision and idempotency key are required');
    }
    const keyHash = sha256(`${selected.id}:${key}`);
    const requestHash = sha256(canonical({ homeId, membershipId: selected.membershipId, expectedRevision: body.expectedRevision, document: body.document }));
    const response = await serializableTransaction(async (tx) => {
      // Prisma cannot deserialize PostgreSQL's `void` lock result directly;
      // project it to a boolean while retaining the transaction-scoped lock.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${namespace}:${keyHash}`}, 0)) IS NULL AS acquired`;
      const prior = await tx.idempotencyRecord.findUnique({ where: { namespace_keyHash: { namespace, keyHash } }, select: { actorId: true, homeId: true, requestHash: true, responseBody: true, expiresAt: true } });
      const now = new Date();
      if (prior) {
        if (prior.actorId !== selected.id || prior.homeId !== homeId || prior.requestHash !== requestHash || prior.expiresAt <= now || !prior.responseBody || typeof prior.responseBody !== 'object') throw new Stage1AuthError(409, 'IDEMPOTENCY_CONFLICT', 'This request key was already used');
        return prior.responseBody as Record<string, unknown>;
      }
      let saved: { revision: number; document: unknown };
      const currentAreaIds = (await tx.area.findMany({ where: { homeId, status: 'ACTIVE' }, orderBy: { id: 'asc' }, select: { id: true } })).map((area) => area.id);
      const currentRow = await tx.homeDocument.findUnique({ where: { homeId_kind: { homeId, kind: 'FLOORPLAN' } }, select: { document: true } });
      const submission = submittedFloorplan(currentAreaIds, body.document, currentRow?.document);
      if (!submission.ok) {
        if (submission.reason === 'FLOORS_NEED_NEW_APP') throw new Stage1AuthError(409, 'UPDATE_REQUIRED', 'This Home has several floors. Update the Dinodia app to edit its floor plan.');
        throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The floorplan must include every current Area exactly once, with no overlaps on a floor');
      }
      try {
        saved = await compareAndSetHomeDocument(tx, { customerAccountId: selected.id, membershipId: selected.membershipId, homeId, kind: 'FLOORPLAN', expectedRevision: Number(body.expectedRevision), document: submission.stored });
      } catch (error) { mapError(error); }
      const receipt = { schemaVersion: 'dinodia.v1', ok: true, homeId, revision: saved.revision, document: floorplanDocument(currentAreaIds, saved.document) };
      await tx.idempotencyRecord.create({ data: { namespace, keyHash, actorId: selected.id, homeId, requestHash, responseStatus: 200, responseBody: receipt as Prisma.InputJsonValue, responseDigest: sha256(canonical(receipt)), expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) } });
      await tx.auditEvent.create({ data: { homeId, actorType: 'CUSTOMER', actorId: selected.id, category: 'MANAGEMENT', action: 'home_floorplan_changed', targetType: 'HomeDocument', targetId: homeId, metadata: { revision: saved.revision, areaCount: currentAreaIds.length, floorCount: submission.stored.floors.length }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      return receipt;
    });
    return NextResponse.json(response, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    if (error instanceof NativeHomeDocumentError) mapError(error);
    return nativeV1ErrorResponse(error);
  }
}
