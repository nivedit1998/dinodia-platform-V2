import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const schema = read('prisma/schema.prisma');
const stage1Migration = read('prisma/migrations/20260922000000_stage1_security_authorities/migration.sql');
const osRoot = process.env.DINODIA_OS_ROOT || path.resolve(root, '../Dinodia OS');
const edgeRoot = process.env.DINODIA_EDGE_ROOT || path.resolve(root, '../dinodia-edge-worker-V2');
const crossRepoAvailable = fs.existsSync(path.join(osRoot, 'src/server.js')) && fs.existsSync(path.join(edgeRoot, 'wrangler.toml'));
const osServer = crossRepoAvailable ? fs.readFileSync(path.join(osRoot, 'src/server.js'), 'utf8') : '';
const osConfig = crossRepoAvailable ? fs.readFileSync(path.join(osRoot, 'src/config.js'), 'utf8') : '';
const edgeConfig = crossRepoAvailable ? fs.readFileSync(path.join(edgeRoot, 'wrangler.toml'), 'utf8') : '';
const edgeSource = crossRepoAvailable ? fs.readFileSync(path.join(edgeRoot, 'src/index.ts'), 'utf8') : '';

const stage1Models = ['EmployeeSession', 'OperatorHandoff', 'StepUpChallenge', 'SupportTicket', 'SupportAccessRequest', 'SupportSession', 'OfflineMembershipAuthorisation', 'CloudUrlVerification'];
for (const model of stage1Models) {
  if (!schema.includes(`model ${model}`)) failures.push(`missing Stage 1 Prisma model ${model}`);
  if (!stage1Migration.includes(`CREATE TABLE "${model}"`)) failures.push(`Stage 1 migration does not create ${model}`);
}
if (schema.includes('currentAreaId')) failures.push('NativeDevice.currentAreaId remains in the schema');
if (!schema.includes('purpose                   String')) failures.push('hub credential purpose is not persisted');
const envExample = read('.env.example');
for (const name of [
  'DATABASE_URL', 'DIRECT_URL', 'SUPABASE_PROJECT_REF', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
  'JWT_SECRET', 'PLATFORM_DATA_ENCRYPTION_KEY', 'CLAIM_REFERENCE_PEPPER', 'AUDIT_LOG_HASH_SALT', 'CRON_SECRET',
  'COMPANY_PORTAL_SESSION_PRIVATE_KEY', 'COMPANY_PORTAL_SESSION_PUBLIC_KEYS', 'DINODIA_APP_SESSION_PRIVATE_KEY',
  'DINODIA_APP_PUBLIC_KEYS', 'OPERATOR_SESSION_PRIVATE_KEY', 'DINODIA_OPERATOR_PUBLIC_KEY',
  'MANUFACTURING_ROOT_PUBLIC_KEYS', 'MANUFACTURING_ENROLLMENT_OPERATOR_PUBLIC_KEYS',
  'STAGE1_CONTRACT_SECRET', 'COMPANY_PORTAL_INITIAL_CXO_BOOTSTRAP_SECRET',
]) if (!new RegExp(`^${name}=`, 'm').test(envExample)) failures.push(`.env.example is missing ${name}`);
if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(envExample)) failures.push('.env.example contains a private key');
if (envExample.includes('dinodia-platform-v1') || envExample.includes('app.dinodiasmartliving.com')) failures.push('.env.example contains an abandoned backend origin');
if (crossRepoAvailable) {
  if (!/runtimeConfig\.nodeEnv\s*===\s*["']production["'][\s\S]{0,80}\?\s*false/.test(osServer)) failures.push('OS legacy compatibility is not explicitly disabled in production');
  if (osServer.includes('legacyAuthorized')) failures.push('removed legacyAuthorized native bypass remains');
  if (!osServer.includes('setupInitialBrowserSessionValid') || !osServer.includes('matchesBrowserSession')) failures.push('setup browser binding is not wired into the OS routes');
  const osPairing = fs.readFileSync(path.join(osRoot, 'src/platformPairing.js'), 'utf8');
  if (!osPairing.includes('operatorCredentialDelivery') || !osPairing.includes('/api/hub-agent/v2/credentials/acknowledge')) failures.push('operator credential delivery acknowledgement is not wired into OS sync');
  if (!osConfig.includes('developmentCompatibility')) failures.push('OS production configuration boundary is not explicit');
}
if (!read('src/app/api/hub-agent/operator-session/consume/route.ts').includes('sessionGrant')) failures.push('operator handoff does not return an encrypted hub grant');
if (read('src/app/api/hub-agent/operator-session/consume/route.ts').includes('token:')) failures.push('operator handoff route contains a browser bearer token response');
if (!read('src/app/api/hub-agent/v2/pairing/cloud-url/route.ts').includes('crypto.verify')) failures.push('CloudURL route does not verify a signed hub response');
if (!read('src/lib/stage1ClaimContract.ts').includes('FOR UPDATE')) failures.push('claim reservation does not serialize first-wins redemption');
if (!stage1Migration.includes('dinodia-native-operations') || !stage1Migration.includes("'*/2 * * * *'") || !stage1Migration.includes('vault.decrypted_secrets')) failures.push('Supabase two-minute native-operations schedule contract is missing');

const deployment = JSON.parse(read('vercel.json'));
if (!Array.isArray(deployment.crons) || deployment.crons.length > 2) failures.push('Vercel cron ceiling exceeded');
if (crossRepoAvailable) {
  if (/AWS_BACKEND|AWS_ORIGIN|awsOrigin|awsFallback|fallbackOrigin/i.test(edgeConfig + '\n' + edgeSource)) failures.push('edge worker contains an AWS origin/fallback');
  if (!/VERCEL_APP_ORIGIN\s*=\s*"https:\/\/dinodia-platform-v2\.vercel\.app\/?"/i.test(edgeConfig)) failures.push('edge worker does not pin its configured origin to the canonical Vercel V2 Production origin');
  if (!edgeSource.includes('CANONICAL_VERCEL_ORIGIN') || !edgeSource.includes('isCanonicalOrigin')) failures.push('edge worker runtime does not enforce the canonical Vercel V2 Production origin');
  if (!edgeSource.includes('x-dinodia-api-backend') || !edgeSource.includes('vercel-v2')) failures.push('edge worker Vercel marker is missing');
}

if (failures.length) {
  console.error('[check:stage1] FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[check:stage1] OK: native Stage 1 routes, production fail-closed boundary, claim serialization, CloudURL signature verification and Vercel-only edge topology are present');
