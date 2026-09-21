// Architecture: API boundary /installer/home-support/homes/[homeId]/remove; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { requireCompanyHomeRemovalOperator } from '@/lib/companyPortalGuards';
import {
  getHomeRemovalPreview,
  performCompanyHomeRemoval,
  REMOVE_HOME_CHECKLIST_KEYS,
  type RemoveHomeChecklistState,
} from '@/lib/homeRemoval';
import { logServerError } from '@/lib/serverErrorLog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function parseHomeId(raw: string | undefined): number | null {
  if (!raw) return null;
  const num = Number(raw);
  return Number.isInteger(num) && num > 0 ? num : null;
}

function validateRemoveHomeChecklist(payload: unknown): RemoveHomeChecklistState | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const result = {} as RemoveHomeChecklistState;
  for (const key of REMOVE_HOME_CHECKLIST_KEYS) {
    if (typeof record[key] !== 'boolean') return null;
    result[key] = record[key] as boolean;
  }
  return result;
}

function matchesRemoveHomeConfirmation(homeId: number, serial: string | null, value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return false;
  if (normalized === String(homeId)) return true;
  if (serial && normalized === serial) return true;
  return false;
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ homeId: string }> }
) {
  try {
    const operator = await requireCompanyHomeRemovalOperator(req, 'start');
    if (operator instanceof NextResponse) return operator;

    const { homeId: rawHomeId } = await context.params;
    const homeId = parseHomeId(rawHomeId);
    if (!homeId) return apiFailFromStatus(400, 'Invalid home id.');

    const preview = await getHomeRemovalPreview(homeId);
    return NextResponse.json(preview);
  } catch (err) {
    logServerError('[api/installer/home-support/homes/[homeId]/remove] GET failed', err);
    return apiFailFromStatus(500, 'We could not load remove-home preview. Please try again.');
  }
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ homeId: string }> }
) {
  try {
    const operator = await requireCompanyHomeRemovalOperator(req, 'finish');
    if (operator instanceof NextResponse) return operator;

    const { homeId: rawHomeId } = await context.params;
    const homeId = parseHomeId(rawHomeId);
    if (!homeId) return apiFailFromStatus(400, 'Invalid home id.');

    const preview = await getHomeRemovalPreview(homeId);
    if (preview.alreadyRemoved) {
      return NextResponse.json({ ok: true, alreadyRemoved: true });
    }

    const body = (await req.json().catch(() => null)) as {
      checklist?: unknown;
      typedConfirmation?: unknown;
      notes?: unknown;
    } | null;

    const checklist = validateRemoveHomeChecklist(body?.checklist);
    if (!checklist) {
      return apiFailFromStatus(400, 'Checklist is incomplete.');
    }
    if (REMOVE_HOME_CHECKLIST_KEYS.some((key) => checklist[key] !== true)) {
      return apiFailFromStatus(400, 'Complete every checklist item before finishing removal.');
    }
    if (!checklist.final_completed) {
      return apiFailFromStatus(400, 'Final confirmation is required.');
    }

    const typedConfirmation = typeof body?.typedConfirmation === 'string' ? body.typedConfirmation : '';
    if (!matchesRemoveHomeConfirmation(homeId, preview.serial, typedConfirmation)) {
      return apiFailFromStatus(400, 'Typed confirmation did not match the Home ID or hub serial.');
    }

    const notes = typeof body?.notes === 'string' ? body.notes.trim() : null;
    const result = await performCompanyHomeRemoval({
      homeId,
      operatorUserId: operator.userId,
      operatorRole: operator.role,
      checklist,
      typedConfirmation,
      notes,
    });

    return NextResponse.json(result);
  } catch (err) {
    logServerError('[api/installer/home-support/homes/[homeId]/remove] DELETE failed', err);
    return apiFailFromStatus(500, 'We could not finish removing this home. Please try again.');
  }
}
