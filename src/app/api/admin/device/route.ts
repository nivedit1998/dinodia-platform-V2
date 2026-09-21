// Architecture: API boundary /admin/device; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { Role } from '@prisma/client';
import { getUserWithHaConnection } from '@/lib/haConnection';
import { requireTrustedAdminDevice, toTrustedDeviceResponse } from '@/lib/deviceAuth';
import { sendAlexaAddOrUpdateReportForHaConnection } from '@/lib/alexaEvents';
import { hashForLog, safeLog } from '@/lib/safeLogger';
import { isReservedOtherLabel, OTHER_LABEL_ERROR } from '@/lib/labelValidation';

export async function POST(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.ADMIN) {
    return NextResponse.json({ error: 'Your session has ended. Please sign in again.' }, { status: 401 });
  }

  try {
    await requireTrustedAdminDevice(req, me.id);
  } catch (err) {
    const deviceError = toTrustedDeviceResponse(err);
    if (deviceError) return deviceError;
    throw err;
  }

  const body = await req.json();
  const { entityId, name, blindTravelSeconds, area, label, boilerPowerKw, heatingPricePerKwh, boilerEfficiencyBand } = body;

  if (!entityId || !name) {
    return NextResponse.json(
      { error: 'Please include both the device name and the entity id.' },
      { status: 400 }
    );
  }

  let homeId: number;
  let haConnectionId: number;
  try {
    const { user, haConnection } = await getUserWithHaConnection(me.id);
    homeId = user.homeId!;
    haConnectionId = haConnection.id;
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || 'The homeowner’s Dinodia Hub connection is missing for this home.' },
      { status: 400 }
    );
  }

  const tenantOwnedTarget = await prisma.tenantDeviceDisplayOverride.findFirst({
    where: {
      haConnectionId,
      entityId,
      tenantUser: { homeId },
    },
    select: { id: true },
  });
  if (tenantOwnedTarget) {
    return NextResponse.json(
      { error: 'Tenant-owned devices cannot be edited from homeowner device settings.' },
      { status: 403 }
    );
  }

  let blindTravelSecondsValue: number | null = null;
  if (blindTravelSeconds !== undefined && blindTravelSeconds !== null && blindTravelSeconds !== '') {
    const parsed = Number(blindTravelSeconds);
    if (Number.isFinite(parsed) && parsed > 0) {
      blindTravelSecondsValue = parsed;
    } else {
      return NextResponse.json(
        { error: 'Blind travel time must be a positive number of seconds when provided.' },
        { status: 400 }
      );
    }
  }

  const parseOptionalFloat = (value: unknown) => {
    if (value === undefined) return { present: false as const, value: null as number | null };
    if (value === null || value === '') return { present: true as const, value: null as number | null };
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      return { present: true as const, value: NaN };
    }
    return { present: true as const, value: parsed };
  };

  const boilerPowerParsed = parseOptionalFloat(boilerPowerKw);
  const heatingPriceParsed = parseOptionalFloat(heatingPricePerKwh);

  if (boilerPowerParsed.present && boilerPowerParsed.value !== null) {
    if (!Number.isFinite(boilerPowerParsed.value) || boilerPowerParsed.value <= 0 || boilerPowerParsed.value > 200) {
      return NextResponse.json(
        { error: 'Boiler power (kW) must be a positive number (max 200) when provided.' },
        { status: 400 }
      );
    }
  }

  if (heatingPriceParsed.present && heatingPriceParsed.value !== null) {
    if (!Number.isFinite(heatingPriceParsed.value) || heatingPriceParsed.value < 0 || heatingPriceParsed.value > 100) {
      return NextResponse.json(
        { error: 'Heating price per kWh must be a non-negative number (max 100) when provided.' },
        { status: 400 }
      );
    }
  }

  const hasArea = Object.prototype.hasOwnProperty.call(body, 'area');
  const areaValue =
    typeof area === 'string' && area.trim().length > 0 ? area.trim() : null;

  const hasLabel = Object.prototype.hasOwnProperty.call(body, 'label');
  const labelValue =
    typeof label === 'string' && label.trim().length > 0 ? label.trim() : null;
  if (isReservedOtherLabel(labelValue)) {
    return NextResponse.json(
      { error: OTHER_LABEL_ERROR },
      { status: 400 }
    );
  }

  const updateData: {
    name: string;
    blindTravelSeconds: number | null;
    area?: string | null;
    label?: string | null;
    boilerPowerKw?: number | null;
    heatingPricePerKwh?: number | null;
    boilerEfficiencyBand?: string | null;
  } = {
    name,
    blindTravelSeconds: blindTravelSecondsValue,
  };

  if (blindTravelSecondsValue !== null) {
    updateData.label = 'Blind';
  } else if (hasLabel) {
    updateData.label = labelValue;
  }

  if (hasArea) {
    updateData.area = areaValue;
  }

  if (boilerPowerParsed.present) {
    updateData.boilerPowerKw = boilerPowerParsed.value === null ? null : boilerPowerParsed.value;
  }

  if (heatingPriceParsed.present) {
    updateData.heatingPricePerKwh = heatingPriceParsed.value === null ? null : heatingPriceParsed.value;
  }

  const hasBoilerEfficiencyBand = Object.prototype.hasOwnProperty.call(body, 'boilerEfficiencyBand');
  let boilerEfficiencyBandValue: string | null = null;
  if (hasBoilerEfficiencyBand) {
    if (boilerEfficiencyBand === null || boilerEfficiencyBand === '') {
      boilerEfficiencyBandValue = null;
    } else if (typeof boilerEfficiencyBand === 'string') {
      const band = boilerEfficiencyBand.trim().toUpperCase();
      if (!/^[A-G]$/.test(band)) {
        return NextResponse.json(
          { error: 'Boiler efficiency band must be one of A, B, C, D, E, F, G when provided.' },
          { status: 400 }
        );
      }
      boilerEfficiencyBandValue = band;
    } else {
      return NextResponse.json(
        { error: 'Boiler efficiency band must be one of A, B, C, D, E, F, G when provided.' },
        { status: 400 }
      );
    }
  }

  const effectiveLabel = (updateData.label ?? (hasLabel ? labelValue : null))?.trim() || null;
  if (hasBoilerEfficiencyBand) {
    updateData.boilerEfficiencyBand = effectiveLabel === 'Boiler' ? boilerEfficiencyBandValue : null;
  } else if (effectiveLabel !== 'Boiler') {
    // If changing away from Boiler, clear prior band override.
    updateData.boilerEfficiencyBand = null;
  }

  const device = await prisma.device.upsert({
    where: {
      haConnectionId_entityId: {
        haConnectionId,
        entityId,
      },
    },
    update: updateData,
    create: {
      haConnectionId,
      entityId,
      name,
      area: hasArea ? areaValue : null,
      label:
        blindTravelSecondsValue !== null
          ? 'Blind'
          : hasLabel
            ? labelValue
            : null,
      blindTravelSeconds: blindTravelSecondsValue,
      boilerPowerKw: boilerPowerParsed.present ? boilerPowerParsed.value : null,
      heatingPricePerKwh: heatingPriceParsed.present ? heatingPriceParsed.value : null,
      boilerEfficiencyBand:
        (blindTravelSecondsValue !== null ? 'Blind' : hasLabel ? labelValue : null) === 'Boiler'
          ? boilerEfficiencyBandValue
          : null,
    },
  });

  try {
    await sendAlexaAddOrUpdateReportForHaConnection({
      haConnectionId,
      restrictEntityIds: [entityId],
    });
  } catch (err) {
    safeLog('warn', '[api/admin/device] AddOrUpdateReport failed', {
      entityIdHash: hashForLog(entityId),
      haConnectionId,
      err,
    });
  }

  return NextResponse.json({ ok: true, device });
}

export async function DELETE(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.ADMIN) {
    return NextResponse.json({ error: 'Your session has ended. Please sign in again.' }, { status: 401 });
  }

  try {
    await requireTrustedAdminDevice(req, me.id);
  } catch (err) {
    const deviceError = toTrustedDeviceResponse(err);
    if (deviceError) return deviceError;
    throw err;
  }

  let homeId: number;
  let haConnectionId: number;
  try {
    const { user, haConnection } = await getUserWithHaConnection(me.id);
    homeId = user.homeId!;
    haConnectionId = haConnection.id;
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || 'The homeowner’s Dinodia Hub connection is missing for this home.' },
      { status: 400 }
    );
  }

  const tenantOwnedRows = await prisma.tenantDeviceDisplayOverride.findMany({
    where: { haConnectionId, tenantUser: { homeId } },
    select: { entityId: true },
  });
  const tenantEntityIds = new Set(
    tenantOwnedRows.map((row) => row.entityId).filter((value): value is string => Boolean(value))
  );

  const rows = await prisma.device.findMany({
    where: { haConnectionId },
    select: {
      id: true,
      entityId: true,
      blindTravelSeconds: true,
      boilerPowerKw: true,
      heatingPricePerKwh: true,
      boilerEfficiencyBand: true,
    },
  });

  const touchedEntityIds: string[] = [];
  await prisma.$transaction(
    rows
      .filter((row) => !tenantEntityIds.has(row.entityId))
      .map((row) => {
        touchedEntityIds.push(row.entityId);
        const hasProtectedValues =
          row.blindTravelSeconds != null ||
          row.boilerPowerKw != null ||
          row.heatingPricePerKwh != null ||
          row.boilerEfficiencyBand != null;
        if (!hasProtectedValues) {
          return prisma.device.delete({ where: { id: row.id } });
        }
        return prisma.device.update({
          where: { id: row.id },
          data: { name: '', area: null, label: null },
        });
      })
  );

  if (touchedEntityIds.length > 0) {
    try {
      await sendAlexaAddOrUpdateReportForHaConnection({
        haConnectionId,
        restrictEntityIds: touchedEntityIds,
      });
    } catch (err) {
      safeLog('warn', '[api/admin/device] reset AddOrUpdateReport failed', {
        haConnectionId,
        count: touchedEntityIds.length,
        err,
      });
    }
  }

  return NextResponse.json({ ok: true, resetCount: touchedEntityIds.length });
}
