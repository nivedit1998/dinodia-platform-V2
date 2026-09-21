// This is a deterministic contract gate for CI. It complements (and does not
// replace) route tests against an isolated database and a release candidate.
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const required = [
  'src/app/api/hub-agent/v2/pairing/register/route.ts',
  'src/app/api/hub-agent/v2/pairing/cloud-url/route.ts',
  'src/app/api/hub-agent/operator-session/consume/route.ts',
  'src/app/api/hub-agent/support/v2/redeem/route.ts',
  'src/app/api/hub-agent/support/v2/revocation/route.ts',
  'src/app/api/hub-agent/support/v2/status/route.ts',
  'src/app/api/installer/support/v2/access/route.ts',
  'src/app/api/installer/hubs/provision/route.ts',
  'src/app/api/installer/workflows/route.ts',
  'src/app/api/stage1/claim/route.ts',
  'src/lib/membershipAuthorization.ts',
  'src/lib/sensitiveOperationStepUp.ts',
  'src/lib/credentialLifecycle.ts',
];
for (const file of required) if (!fs.existsSync(path.join(root, file))) throw new Error(`missing Stage 1 contract file: ${file}`);

const support = read('src/app/api/installer/support/v2/access/route.ts');
if (!/Redemption is deliberately hub-authenticated/.test(support) || !/Support redemption must be performed by the paired Dinodia OS hub/.test(support)) throw new Error('browser support redemption is not explicitly closed');
const provisioning = read('src/app/api/installer/hubs/provision/route.ts');
if (!/completeDurableProvisioningAttempt/.test(provisioning) || !/installationWorkflowId/.test(provisioning)) throw new Error('provisioning completion is not workflow-bound');
const claim = read('src/app/api/stage1/claim/route.ts');
for (const marker of ['authenticateHub', 'requireVerifiedAccount', 'reserveStage1Claim', 'persistStage1SetupMutation', 'releaseStage1Reservation']) if (!claim.includes(marker)) throw new Error(`claim contract missing ${marker}`);
const schema = read('prisma/schema.prisma');
for (const marker of ['model HomeMembership', 'model HubManufacturingIdentity', 'model HubProvisioningAttempt', 'model SupportAccessSession', 'model Stage1ClaimReservation']) if (!schema.includes(marker)) throw new Error(`schema missing ${marker}`);
console.log('[test:stage1] structural contract gate passed; behavioral route/DB/hardware evidence remains separate');
