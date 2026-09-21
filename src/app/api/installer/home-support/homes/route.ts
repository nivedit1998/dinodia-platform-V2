// Architecture: API boundary /installer/home-support/homes; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireCompanyHomeSupportViewer } from '@/lib/companyPortalGuards';

function parseHomeId(raw: string | null): number | null {
  if (!raw) return null;
  const num = Number(raw);
  return Number.isInteger(num) && num > 0 ? num : null;
}

function parseSerial(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function GET(req: NextRequest) {
  const operator = await requireCompanyHomeSupportViewer(req);
  if (operator instanceof NextResponse) return operator;

  const homeId = parseHomeId(req.nextUrl.searchParams.get('homeId'));
  const serial = parseSerial(req.nextUrl.searchParams.get('serial'));

  if (homeId && serial) {
    return NextResponse.json(
      { error: 'Provide either homeId or serial, not both.' },
      { status: 400 }
    );
  }

  let data: Array<{ homeId: number; installedAt: Date }> = [];

  if (!homeId && !serial) {
    const homes = await prisma.home.findMany({
      where: { hubInstall: { isNot: null } },
      orderBy: [{ hubInstall: { createdAt: 'desc' } }, { createdAt: 'desc' }],
      take: 500,
      select: { id: true, createdAt: true, hubInstall: { select: { createdAt: true } } },
    });

    data = homes.map((home) => ({
      homeId: home.id,
      installedAt: home.hubInstall?.createdAt ?? home.createdAt,
    }));
  } else if (homeId) {
    const home = await prisma.home.findUnique({
      where: { id: homeId },
      select: {
        id: true,
        createdAt: true,
        hubInstall: { select: { createdAt: true } },
      },
    });

    if (home) {
      data = [
        {
          homeId: home.id,
          installedAt: home.hubInstall?.createdAt ?? home.createdAt,
        },
      ];
    }
  } else if (serial) {
    const hubInstall = await prisma.hubInstall.findUnique({
      where: { serial },
      select: {
        createdAt: true,
        home: {
          select: {
            id: true,
            createdAt: true,
          },
        },
      },
    });

    if (hubInstall?.home) {
      data = [
        {
          homeId: hubInstall.home.id,
          installedAt: hubInstall.createdAt ?? hubInstall.home.createdAt,
        },
      ];
    }
  }

  return NextResponse.json({ ok: true, homes: data });
}
