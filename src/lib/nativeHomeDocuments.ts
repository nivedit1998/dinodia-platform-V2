import type { Prisma, HomeDocumentKind } from '@prisma/client';
import { boundedJson, canonicalPublicId } from './nativeSchemaValidation';

export class NativeHomeDocumentError extends Error {
  constructor(readonly code: 'MEMBERSHIP_FORBIDDEN' | 'DOCUMENT_INVALID' | 'REVISION_CONFLICT') { super(code); }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function floorplanAreas(document: unknown): Array<{ areaId: string; x: number; y: number; width: number; height: number }> | null {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return null;
  const root = document as Record<string, unknown>;
  if (!exactKeys(root, ['version', 'areas']) || root.version !== 1 || !Array.isArray(root.areas) || root.areas.length > 500) return null;
  const seen = new Set<string>();
  const areas: Array<{ areaId: string; x: number; y: number; width: number; height: number }> = [];
  for (const raw of root.areas) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const area = raw as Record<string, unknown>;
    if (!exactKeys(area, ['areaId', 'x', 'y', 'width', 'height']) || !canonicalPublicId(area.areaId) || seen.has(area.areaId)) return null;
    if (![area.x, area.y, area.width, area.height].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 10000)
      || area.width === 0 || area.height === 0 || (area.x as number) + (area.width as number) > 10000 || (area.y as number) + (area.height as number) > 10000) return null;
    seen.add(area.areaId);
    areas.push({ areaId: area.areaId, x: area.x as number, y: area.y as number, width: area.width as number, height: area.height as number });
  }
  return areas;
}

/** Shared floorplan geometry is presentation-only: it cannot create area or device authority. */
export async function compareAndSetHomeDocument(db: Prisma.TransactionClient, input: {
  customerAccountId: string; membershipId: string; homeId: string; kind: HomeDocumentKind; expectedRevision: number; document: unknown;
}) {
  if (input.kind !== 'FLOORPLAN' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !boundedJson(input.document, 24 * 1024)) {
    throw new NativeHomeDocumentError('DOCUMENT_INVALID');
  }
  const areas = floorplanAreas(input.document);
  if (!areas) throw new NativeHomeDocumentError('DOCUMENT_INVALID');
  const [membership, home] = await Promise.all([
    db.homeMembership.findFirst({ where: { id: input.membershipId, customerAccountId: input.customerAccountId, homeId: input.homeId, status: 'ACTIVE', role: { in: ['OWNER', 'PROPERTY_MANAGER'] }, customerAccount: { status: 'ACTIVE' } }, select: { id: true } }),
    db.home.findFirst({ where: { id: input.homeId, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' }, select: { id: true } }),
  ]);
  if (!membership || !home) throw new NativeHomeDocumentError('MEMBERSHIP_FORBIDDEN');
  const areaIds = [...new Set(areas.map((area) => area.areaId))];
  if (areaIds.length !== areas.length || (areaIds.length && await db.area.count({ where: { homeId: input.homeId, status: 'ACTIVE', id: { in: areaIds } } }) !== areaIds.length)) {
    throw new NativeHomeDocumentError('DOCUMENT_INVALID');
  }
  const current = await db.homeDocument.findUnique({ where: { homeId_kind: { homeId: input.homeId, kind: 'FLOORPLAN' } }, select: { id: true, revision: true } });
  if (!current) {
    if (input.expectedRevision !== 0) throw new NativeHomeDocumentError('REVISION_CONFLICT');
    try {
      const created = await db.homeDocument.create({ data: { homeId: input.homeId, kind: 'FLOORPLAN', document: input.document as Prisma.InputJsonValue, revision: 1, createdByAccountId: input.customerAccountId } });
      return { revision: created.revision, document: created.document };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') throw new NativeHomeDocumentError('REVISION_CONFLICT');
      throw error;
    }
  }
  if (current.revision !== input.expectedRevision) throw new NativeHomeDocumentError('REVISION_CONFLICT');
  const update = await db.homeDocument.updateMany({ where: { id: current.id, revision: current.revision }, data: { document: input.document as Prisma.InputJsonValue, revision: { increment: 1 }, createdByAccountId: input.customerAccountId } });
  if (update.count !== 1) throw new NativeHomeDocumentError('REVISION_CONFLICT');
  const saved = await db.homeDocument.findUniqueOrThrow({ where: { id: current.id }, select: { revision: true, document: true } });
  return saved;
}
