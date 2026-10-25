import { PrismaClient } from '@prisma/client';

let target;
try { target = new URL(process.env.DIRECT_URL || ''); } catch { throw new Error('Stage 3 backfill check requires an explicit disposable loopback DIRECT_URL'); }
if (!['127.0.0.1', 'localhost', '::1'].includes(target.hostname) || target.pathname !== '/dinodia_v2_prior_stage3') {
  throw new Error('Stage 3 backfill check refuses non-loopback or non-prior-head disposable targets');
}

const db = new PrismaClient({ datasourceUrl: target.toString() });
try {
  const [installed, incomplete, revoked] = await Promise.all([
    db.hubInstallation.findUnique({ where: { serialNumberSnapshot: 'stage3-backfill-installed' }, select: { id: true, lifecycleStatus: true, homeId: true } }),
    db.hubInstallation.findUnique({ where: { serialNumberSnapshot: 'stage3-backfill-incomplete' }, select: { id: true, lifecycleStatus: true, homeId: true } }),
    db.hubInstallation.findUnique({ where: { serialNumberSnapshot: 'stage3-backfill-revoked' }, select: { id: true, lifecycleStatus: true, homeId: true } }),
  ]);
  const [installedHome, incompleteHome, revokedHome] = await Promise.all([
    installed ? db.home.findUnique({ where: { id: installed.homeId }, select: { activeHubInstallationId: true } }) : null,
    incomplete ? db.home.findUnique({ where: { id: incomplete.homeId }, select: { activeHubInstallationId: true } }) : null,
    revoked ? db.home.findUnique({ where: { id: revoked.homeId }, select: { activeHubInstallationId: true } }) : null,
  ]);
  if (!installed || installed.lifecycleStatus !== 'ACTIVE' || installedHome?.activeHubInstallationId !== installed.id) throw new Error('completed non-revoked prior-head installation was not selected as active');
  if (!incomplete || incomplete.lifecycleStatus !== 'PENDING' || incompleteHome?.activeHubInstallationId !== null) throw new Error('incomplete prior-head installation was incorrectly promoted');
  if (!revoked || revoked.lifecycleStatus !== 'PENDING' || revokedHome?.activeHubInstallationId !== null) throw new Error('revoked prior-head installation was incorrectly promoted');
  console.log('[test:stage3-backfill] PASS: completed active hub selected; incomplete and revoked installations remain non-authoritative');
} finally {
  await db.$disconnect();
}
