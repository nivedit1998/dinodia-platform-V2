// Stage 1 static security gate. This is intentionally small and deterministic
// so it can run in Vercel CI without a database or production credentials.
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const osRoot = path.resolve(root, '..', 'Dinodia OS');
const read = (file) => fs.readFileSync(file, 'utf8');
const failures = [];

const osConfig = read(path.join(osRoot, 'src/config.js'));
const osApp = read(path.join(osRoot, 'public/app.js'));
const osIndex = read(path.join(osRoot, 'public/index.html'));
const provisionRoute = read(path.join(root, 'src/app/api/installer/hubs/provision/route.ts'));
const provisionClient = read(path.join(root, 'src/app/installer/provision/provisionClient.tsx'));
const readIfExists = (file) => fs.existsSync(file) ? read(file) : '';
const legacyRoutes = [
  'src/app/api/claim/route.ts',
  'src/app/api/claim/recover/route.ts',
  'src/app/api/auth/register-admin/route.ts',
  'src/app/api/auth/register-serial/route.ts',
  'src/app/api/internal/support/ha/session/bootstrap/route.ts',
];
for (const relative of legacyRoutes) {
  const source = read(path.join(root, relative));
  if (!/legacyNativeRouteDisabled/.test(source)) failures.push(`Legacy route is not explicitly disabled in native production: ${relative}`);
}

if (/DINODIA_ADMIN_TOKEN",\s*nodeEnv\s*===\s*"production"\s*\?\s*""\s*:\s*"dev-token"/.test(osConfig)) failures.push('Dinodia OS still has a default development admin token');
if (/localStorage\.getItem\(["']dinodia-token/.test(osApp)) failures.push('Dinodia OS dashboard persists a token in localStorage');
if (/<input[^>]+id=["']token["']/.test(osIndex)) failures.push('Dinodia OS dashboard still renders a routine token input');
if (/haBaseUrl|haCloudUrl|haUsername|haPassword|haLongLivedToken|bootstrapSecret/.test(provisionRoute)) failures.push('Company Portal provisioning route still contains a legacy HA/bootstrap field');
if (/haBaseUrl|haCloudUrl|haUsername|haPassword|haLongLivedToken|bootstrapSecret/.test(provisionClient)) failures.push('Company Portal provisioning UI still contains a legacy HA/bootstrap field');
const productionNativeRoutes = [
  path.join(osRoot, 'src/server.js'),
  path.join(osRoot, 'src/auth/appTokenVerifier.js'),
  path.join(osRoot, 'src/auth/operatorSession.js'),
  path.join(root, 'src/app/api/hub-agent/v2/pairing/register/route.ts'),
  path.join(root, 'src/app/api/hub-agent/operator-session/consume/route.ts'),
];
for (const file of productionNativeRoutes) {
  if (!fs.existsSync(file)) continue;
  const source = read(file);
  if (/DINODIA_ADMIN_TOKEN|dev-hub-token|bootstrapSecret|oneTimeLongLivedToken|syncSecret/.test(source) && file.includes('route.ts')) failures.push(`Native production route contains a legacy/bootstrap credential path: ${path.relative(root, file)}`);
}
if (!/durableProvisioningClaimState|redeemDurableProvisioningPresentation/.test(read(path.join(root, 'src/app/api/installer/hubs/provision/route.ts')))) failures.push('Installer provisioning still uses a process-local pairing registry');
if (/stage1ProvisioningRegistry/.test(read(path.join(root, 'src/app/api/hub-agent/v2/pairing/register/route.ts')))) failures.push('Hub registration still imports the process-local provisioning harness');
if (/return[^;]*token/.test(read(path.join(root, 'src/app/api/installer/home-support/homes/[homeId]/os-access/consume/route.ts')))) failures.push('Browser-facing operator consume route still returns a bearer token');

const vercelPath = path.join(root, 'vercel.json');
if (fs.existsSync(vercelPath)) {
  const vercel = JSON.parse(read(vercelPath));
  const cronCount = Array.isArray(vercel.crons) ? vercel.crons.length : 0;
  if (cronCount > 2) failures.push(`Vercel cron ceiling exceeded: ${cronCount}`);
}

// Inspect the active V2 deployable configuration recursively. AWS is not an
// active repository in V2 and is intentionally not part of this check.
const schedulingNames = new Set(['vercel.json', 'serverless.yml', 'serverless.yaml', 'serverless.ts', 'sam.yaml', 'sam.yml', 'template.yaml', 'template.yml', 'cdk.json', 'eventbridge.json', 'sst.config.ts', 'sst.config.js', 'wrangler.toml', 'netlify.toml', 'render.yaml']);
function deployConfigFiles(directory) {
  const output = [];
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', '.next', 'dist', 'out', 'coverage'].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...deployConfigFiles(target));
    else if (schedulingNames.has(entry.name)) output.push(target);
  }
  return output;
}
for (const file of deployConfigFiles(root)) {
  const relative = path.relative(root, file);
  if (path.basename(file) === 'vercel.json') {
    try { const deployment = JSON.parse(read(file)); const cronCount = Array.isArray(deployment.crons) ? deployment.crons.length : 0; if (cronCount > 2) failures.push(`Vercel cron ceiling exceeded: ${cronCount} in ${relative}`); } catch { failures.push(`Vercel deployment configuration is invalid JSON: ${relative}`); }
  }
}
const edgeRoot = path.resolve(root, '..', 'dinodia-edge-worker-V2');
const edgeSource = readIfExists(path.join(edgeRoot, 'src/index.ts'));
const edgeConfig = readIfExists(path.join(edgeRoot, 'wrangler.toml'));
if (!edgeSource || !edgeConfig || !/VERCEL_APP_ORIGIN/.test(edgeSource + edgeConfig) || /AWS_ORIGIN|AWS_BACKEND|aws-api|dinodia-platform-aws/i.test(edgeSource + edgeConfig)) failures.push('Edge worker is not provably Vercel-only');

if (failures.length) {
  console.error('[check:stage1] FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[check:stage1] OK: production defaults, provisioning fields and cron ceiling passed static checks');
