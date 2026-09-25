import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const osRoot = process.env.DINODIA_OS_ROOT || path.resolve(root, '..', 'Dinodia OS');
const readOs = (file) => fs.readFileSync(path.join(osRoot, file), 'utf8');
const requireOsModule = (file) => createRequire(import.meta.url)(path.join(osRoot, file));

function loadTypeScriptModule(relativePath, overrides = {}) {
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const source = read(relativePath);
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) => overrides[specifier] ?? require(specifier);
  new Function('require', 'module', 'exports', compiled)(localRequire, module, module.exports);
  return module.exports;
}

test('Stage 1 checker passes against the active repositories', () => {
  const output = execFileSync(process.execPath, ['scripts/check_stage1_security.mjs'], { cwd: root, encoding: 'utf8' });
  assert.match(output, /check:stage1\] OK/);
});

test('native provisioning cannot expose reusable browser credentials', () => {
  const route = read('src/app/api/hub-agent/operator-session/consume/route.ts');
  assert.match(route, /sessionGrant/);
  assert.doesNotMatch(route, /NextResponse\.json\([\s\S]{0,800}\btoken\s*:/);
  assert.match(read('src/app/api/installer/home-support/homes/[homeId]/os-access/launch/route.ts'), /handoffHash|handoff/);
});

test('operator handoff proves a one-use secret inside the hub channel', () => {
  const launch = read('src/app/api/installer/home-support/homes/[homeId]/os-access/launch/route.ts');
  const consume = read('src/app/api/hub-agent/operator-session/consume/route.ts');
  assert.match(launch, /handoffSecret/);
  assert.match(launch, /handoffHash: sha256\(handoffSecret\)/);
  assert.match(launch, /handoffEnvelope/);
  assert.doesNotMatch(launch, /handoffSecret,.*NextResponse/);
  assert.match(consume, /phase === 'prepare'/);
  assert.match(consume, /sha256\(handoffSecret\) !== handoff\.handoffHash/);
  assert.match(consume, /handoff_secret_required/);
  assert.doesNotMatch(consume, /NextResponse\.json\([^\n]*handoffSecret,/);
  const osServer = readOs('src/server.js');
  assert.match(osServer, /phase: "prepare"/);
  assert.match(osServer, /phase: "consume"/);
  assert.match(osServer, /decryptCredentialDelivery\(.*operator-handoff/);
  assert.match(osServer, /handoffSecret = null/);
});

test('Stage 1 database migration includes durable privacy and authority objects', () => {
  const migration = read('prisma/migrations/20260922000000_stage1_security_authorities/migration.sql');
  for (const marker of ['SupportAccessRequest_scope_guard', 'HubCredentialVersion_hub_purpose_state_idx', 'REVOKE ALL PRIVILEGES']) assert.match(migration, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('readiness requires the completed Stage 1 migration rather than only the baseline', () => {
  assert.match(read('src/app/api/readiness/route.ts'), /REQUIRED_MIGRATION/);
  assert.match(read('src/lib/foundation.ts'), /20260925040000_r7_support_notifications/);
  assert.match(read('src/lib/foundation.ts'), /REQUIRED_MODEL_COUNT = 44/);
});

test('normal hub routes require the acknowledged machine credential', () => {
  const auth = read('src/lib/stage1HubAuth.ts');
  assert.match(auth, /machine_credential_required/);
  assert.match(auth, /allowIdentity\?\: boolean/);
  for (const route of [
    'src/app/api/hub-agent/v2/heartbeat/route.ts',
    'src/app/api/hub-agent/token-state/route.ts',
    'src/app/api/hub-agent/support/v2/status/route.ts',
    'src/app/api/hub-agent/operator-session/consume/route.ts',
    'src/app/api/hub-agent/v2/pairing/cloud-url/route.ts',
  ]) assert.doesNotMatch(read(route), /allowIdentity/);
  for (const route of [
    'src/app/api/hub-agent/v2/pairing/challenge/route.ts',
    'src/app/api/hub-agent/v2/pairing/prove/route.ts',
    'src/app/api/hub-agent/v2/pairing/acknowledge/route.ts',
  ]) assert.match(read(route), /allowIdentity: true/);
});

test('offline authority cannot replace the enrolled trusted-phone key', () => {
  const route = read('src/app/api/v2/offline-authorisations/route.ts');
  assert.match(route, /trustedDevicePublicKey/);
  assert.match(route, /offline_device_key_denied/);
  assert.match(route, /suppliedThumbprint/);
});

test('employee sessions use the employee lifetime while customer hub tokens remain five minutes', () => {
  const crypto = createRequire(import.meta.url)('node:crypto');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const { signStage1Token, verifyStage1Token } = loadTypeScriptModule('src/lib/stage1Crypto.ts');
  const now = 1_900_000_000_000;
  const issuedAt = Math.floor(now / 1000);
  const employee = signStage1Token('employee', { id: 'employee-1', sessionId: 'session-1', areaIds: [], scopes: ['company:portal'], policyRevision: 0, issuedAt, expiresAt: issuedAt + 8 * 60 * 60 }, privateKey);
  assert.equal(verifyStage1Token(employee, 'employee', [publicKey], now)?.id, 'employee-1');
  const customer = signStage1Token('customer', { id: 'customer-1', sessionId: 'session-1', homeId: 'home-1', membershipId: 'membership-1', trustedDeviceId: 'device-1', hubInstallationId: 'hub-1', role: 'TENANT', areaIds: ['area-1'], scopes: ['tenant:device-command'], policyRevision: 1, issuedAt, expiresAt: issuedAt + 300 }, privateKey);
  assert.equal(verifyStage1Token(customer, 'customer', [publicKey], now)?.id, 'customer-1');
  const overlongCustomer = signStage1Token('customer', { id: 'customer-1', sessionId: 'session-1', homeId: 'home-1', membershipId: 'membership-1', trustedDeviceId: 'device-1', hubInstallationId: 'hub-1', role: 'TENANT', areaIds: [], scopes: [], policyRevision: 1, issuedAt, expiresAt: issuedAt + 301 }, privateKey);
  assert.equal(verifyStage1Token(overlongCustomer, 'customer', [publicKey], now), null);
});

test('step-up target digests use one canonical representation for issue and consume', () => {
  const { targetDigest } = loadTypeScriptModule('src/lib/sensitiveOperationStepUp.ts', {
    './prisma': { prisma: {} },
    './stage1Auth': { Stage1AuthError: class Stage1AuthError extends Error {} },
  });
  assert.equal(targetDigest(['device-1', 'entity-1']), targetDigest(['entity-1', 'device-1']));
  assert.equal(targetDigest(['device-1', 'device-1']), targetDigest(['device-1']));
  assert.notEqual(targetDigest(['device-1']), targetDigest(['device-2']));
});

test('every real step-up consumer remains bound to the selected hub installation', () => {
  const primitive = read('src/lib/sensitiveOperationStepUp.ts');
  assert.match(primitive, /hubInstallationId: string/);
  for (const route of [
    'src/app/api/v2/support/tickets/[ticketId]/route.ts',
    'src/app/api/v2/support/tickets/[ticketId]/access-requests/[requestId]/approve/route.ts',
    'src/app/api/v2/trusted-devices/[trustedDeviceId]/route.ts',
    'src/app/api/v2/security/step-up/consume/route.ts',
  ]) {
    const source = read(route);
    assert.match(source, /consumeStepUp\(/);
    assert.match(source, /hubInstallationId:\s*customer\.hubInstallationId/);
  }
});

test('Platform step-up operation digest matches the published cross-runtime vector', () => {
  const { operationDigest, descriptorBoundValue } = loadTypeScriptModule('src/lib/sensitiveOperationStepUp.ts', {
    './prisma': { prisma: {} },
    './stage1Auth': { Stage1AuthError: class Stage1AuthError extends Error {} },
  });
  const digest = operationDigest({
    actorId: 'account-1', trustedDeviceId: 'phone-1', customerSessionId: 'session-1', homeId: 'home-1', membershipId: 'membership-1', hubInstallationId: 'hub-1',
    operationKind: 'device_sensitive_command', targetIds: ['device-1'],
    value: descriptorBoundValue({ controlId: 'control-1', temperature: 21 }, { 'device-1': 'descriptor-7' }),
  });
  assert.equal(digest, '0b7b31bd4b18558b5650808cc96c4127bff9ef43c3a2982083fb2c0402603997');
  const osVerifier = requireOsModule('src/auth/stepUpProofVerifier.js');
  assert.equal(osVerifier.digestOperation({ actorId: 'account-1', trustedDeviceId: 'phone-1', trustedSessionId: 'session-1', homeId: 'home-1', membershipId: 'membership-1', hubInstallId: 'hub-1', operation: 'device_sensitive_command', targetIds: ['device-1'], value: osVerifier.descriptorBoundValue({ controlId: 'control-1', temperature: 21 }, { 'device-1': 'descriptor-7' }) }), digest);
});

test('Platform and Dinodia OS use the same support proof-of-possession vector', () => {
  const { supportProofOfPossessionDigest } = loadTypeScriptModule('src/lib/stage1Operator.ts', {
    './hubOperatorCredentials': { encryptToHubKey: () => ({}) },
  });
  const input = {
    employeeProofHash: 'a'.repeat(64),
    serial: 'din-home-001',
    ticketId: '11111111-1111-4111-8111-111111111111',
    requestId: '22222222-2222-4222-8222-222222222222',
    codeHash: 'b'.repeat(64),
    identityGeneration: 1,
  };
  const expected = '1b02c8aca1f3d4c91ef1af9ec2e2de38a2fb72dcc249d094314b86e3b8673139';
  assert.equal(supportProofOfPossessionDigest(input), expected);
  const osProof = requireOsModule('src/auth/supportProofOfPossession.js');
  assert.equal(osProof.supportProofOfPossessionDigest(input), expected);
});

test('manufacturing certificates sign only stable identity material and use separate key types', () => {
  const crypto = createRequire(import.meta.url)('node:crypto');
  const { publicKey: rootPublicKey, privateKey: rootPrivateKey } = crypto.generateKeyPairSync('ed25519');
  const { publicKey: signingPublicKey } = crypto.generateKeyPairSync('ed25519');
  const { publicKey: encryptionPublicKey } = crypto.generateKeyPairSync('x25519');
  const pem = (key) => key.export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = (key) => crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
  const identity = { serial: 'DIN-ROOT-001', identityGeneration: 1, publicKeyPem: pem(signingPublicKey), encryptionPublicKeyPem: pem(encryptionPublicKey), publicKeyFingerprint: fingerprint(signingPublicKey), encryptionKeyFingerprint: fingerprint(encryptionPublicKey) };
  const { manufacturingIdentityPayload, validateManufacturingIdentity } = loadTypeScriptModule('src/lib/manufacturingEnrollment.ts', {
    './stage1Auth': { Stage1AuthError: class Stage1AuthError extends Error { constructor(_status, code, message = code) { super(message); } } },
    './stage1Crypto': { parsePublicKeys: () => [], sha256: () => '' },
  });
  const signature = crypto.sign(null, Buffer.from(manufacturingIdentityPayload(identity), 'utf8'), rootPrivateKey).toString('base64url');
  const verified = validateManufacturingIdentity({ ...identity, manufacturingRootSignature: signature }, [rootPublicKey]);
  assert.equal(verified.serial, identity.serial);
  assert.equal(verified.generation, 1);
  // Transient provisioning fields are deliberately outside the stable factory
  // certificate. They cannot change its bytes or invalidate a valid identity;
  // the separate hub-attempt signature authenticates those fields.
  assert.equal(validateManufacturingIdentity({ ...identity, manufacturingRootSignature: signature, attemptId: 'different-attempt' }, [rootPublicKey]).serial, identity.serial);
  assert.notEqual(manufacturingIdentityPayload(identity), manufacturingIdentityPayload({ ...identity, identityGeneration: 2 }));
  const osIdentity = createRequire(import.meta.url)(path.join(osRoot, 'src/auth/manufacturingIdentity.js'));
  assert.equal(osIdentity.stableManufacturingIdentityPayload(identity), manufacturingIdentityPayload(identity));
  const rootAuth = read('src/lib/stage1HubAuth.ts');
  assert.match(rootAuth, /manufacturingIdentityPayload/);
  assert.match(rootAuth, /stable manufacturing certificate/);
});

test('R4 production paths use opaque browser-bound handoffs, committed claim cleanup and reserved tunnel identity', () => {
  const launch = read('src/app/api/installer/home-support/homes/[homeId]/os-access/launch/route.ts');
  const consume = read('src/app/api/hub-agent/operator-session/consume/route.ts');
  const claim = read('src/lib/stage1ClaimContract.ts');
  const cloud = read('src/app/api/hub-agent/v2/pairing/cloud-url/route.ts');
  const support = read('src/app/api/hub-agent/support/v2/redeem/route.ts');
  const supportProof = read('src/app/api/hub-agent/support/v2/proof/route.ts');
  const supportIssue = read('src/app/api/v2/support/tickets/[ticketId]/access-requests/[requestId]/issue/route.ts');
  const cloudflareReserve = read('src/app/api/installer/hubs/[hubInstallationId]/cloudflare/reserve/route.ts');
  const supportPortal = read('src/app/installer/home-support/page.tsx');
  assert.match(launch, /browserBinding/);
  assert.match(launch, /handoffId/);
  assert.match(launch, /handoffSecret/);
  assert.match(launch, /handoffEnvelope/);
  assert.match(consume, /where: \{ id: handoffId \}/);
  assert.match(consume, /browserBindingHash/);
  assert.match(consume, /setupAttemptId/);
  assert.match(consume, /handoff\.consumedAt/);
  assert.match(claim, /const result = await prisma\.\$transaction/);
  assert.match(claim, /if \(result\.expired\) throw/);
  assert.match(claim, /pendingSetupCount/);
  assert.match(cloud, /reservedTunnelName/);
  assert.match(cloud, /cloudflareReservationToken/);
  assert.match(cloud, /reservationToken/);
  assert.doesNotMatch(support, /hub\.body\.employeeProofEnvelope/);
  assert.match(supportProof, /employeeHandoffEnvelope/);
  assert.match(supportProof, /requestId/);
  assert.match(supportProof, /identityGeneration/);
  assert.doesNotMatch(supportProof, /employeeProofHash/);
  assert.match(support, /employeeProofOfPossession/);
  assert.match(support, /supportProofOfPossessionDigest/);
  assert.doesNotMatch(support, /employeeProof\s*:/);
  assert.doesNotMatch(support, /verifyHubBoundOperatorGrant/);
  assert.match(support, /employeeHandoffHash/);
  assert.match(support, /employeeProofHash: String\(row\.employeeHandoffHash/);
  assert.match(supportIssue, /employeeHandoffEnvelope/);
  assert.doesNotMatch(supportIssue, /NextResponse\.json\(\{[^\n]*employeeProofEnvelope/);
  assert.doesNotMatch(supportPortal, /employeeProofEnvelope/);
  assert.doesNotMatch(supportPortal, /issuedCode|body\.code/);
  assert.doesNotMatch(supportIssue, /NextResponse\.json\([\s\S]{0,500}\bcode\s*[,}]/);
  assert.match(read('src/app/api/v2/support/tickets/[ticketId]/access-requests/[requestId]/approve/route.ts'), /oneUseCode/);
  assert.doesNotMatch(readOs('public/setup.js'), /supportProof|employeeProofEnvelope/);
  assert.doesNotMatch(support, /employeeHandoff\s*\}\)/);
  assert.match(support, /employeeHandoffConsumedAt/);
  assert.doesNotMatch(support, /requireEmployeeToken/);
  assert.match(support, /targetMembershipId/);
  assert.match(read('src/app/api/hub-agent/support/v2/status/route.ts'), /targetMembershipId/);
  assert.match(read('src/app/api/v2/support/tickets/[ticketId]/access-requests/[requestId]/approve/route.ts'), /support_access_(approved|denied)/);
  assert.match(read('src/app/api/v2/support/tickets/[ticketId]/access-requests/[requestId]/issue/route.ts'), /support_access_issued/);
  assert.match(read('src/app/api/v2/support/tickets/[ticketId]/route.ts'), /support_ticket_closed/);
  assert.match(support, /support_access_redeemed/);
  assert.doesNotMatch(cloudflareReserve, /return \{[^\n]*reservationToken/);
  const resolver = read('src/app/api/hub-agent/v2/claim/resolver/challenge/route.ts');
  assert.match(resolver, /authenticateHub\(request, raw\)/);
  assert.match(resolver, /permanentResolverHash/);
  assert.match(resolver, /homeClaimChallenge\.create/);
  assert.match(resolver, /state: \{ in: \['AVAILABLE', 'RESERVED'\] \}/);
  assert.match(readOs('src/server.js'), /\/_dinodia\/setup\/claim-challenge/);
  assert.match(readOs('src/platformPairing.js'), /requestPermanentClaimChallenge/);
  const resolverHarness = read('src/app/api/internal/stage1/claim/route.ts');
  assert.match(resolverHarness, /action === 'resolve'/);
  assert.match(resolverHarness, /signedResponseDigest/);
  assert.match(resolverHarness, /resolver_challenge_replayed/);
  assert.match(resolverHarness, /constantTimeEqual/);
});

test('installer UI can reserve the durable Cloudflare endpoint before secure OS launch', () => {
  const installer = read('src/app/installer/page.tsx');
  assert.match(installer, /cloudflare\/reserve/);
  assert.match(installer, /Reserve secure endpoint/);
  assert.match(installer, /!work\.hubInstallation\?\.cloudUrl/);
  assert.match(installer, /work\.hubInstallation\?\.cloudUrl &&/);
  assert.match(installer, /Open secure Dinodia OS/);
});

test('R3 tenant-device and device step-up paths use current membership and descriptor authority', () => {
  const osServer = readOs('src/server.js');
  const osConfig = readOs('src/config.js');
  const osExample = readOs('.env.example');
  const osStepUp = readOs('src/auth/stepUpProofVerifier.js');
  assert.match(osServer, /ownerMembershipId/);
  assert.doesNotMatch(osServer, /const ownerId = String\(device\.tenantOwnerId/);
  assert.match(osServer, /descriptorBoundValue\(\{/);
  assert.match(osServer, /targetIds: \[item\.device\.id\]/);
  assert.match(osServer, /step_up_descriptor_stale/);
  assert.match(osStepUp, /descriptorBoundValue/);
  assert.match(osConfig, /platformHeartbeatUrl: developmentCompatibility/);
  assert.match(osConfig, /platformToken: developmentCompatibility/);
  assert.doesNotMatch(osExample, /DINODIA_PLATFORM_HEARTBEAT_URL|DINODIA_PLATFORM_TOKEN/);
});

test('R3 provisioning retries are durable, request-bound and never replay the Home QR secret', () => {
  const route = read('src/app/api/installer/hubs/provision/route.ts');
  assert.match(route, /idempotencyRecord/);
  assert.match(route, /namespace_keyHash/);
  assert.match(route, /requestHash/);
  assert.match(route, /TransactionIsolationLevel\.Serializable/);
  assert.match(route, /idempotentReplay: true/);
  assert.match(route, /claimPresentation: null/);
  assert.match(route, /P2002|P2034/);
});

test('R3 authentication failures create redacted durable security evidence', () => {
  const auth = read('src/lib/stage1Auth.ts');
  assert.match(auth, /recordFailedAuthentication/);
  assert.match(auth, /identifierHash/);
  assert.match(auth, /actorType: 'SYSTEM'/);
  assert.doesNotMatch(auth, /metadata: \{[^}]*password/);
  assert.match(read('src/app/api/company/auth/session/route.ts'), /employee_login_failed/);
  assert.match(read('src/app/api/v2/auth/session/route.ts'), /customer_login_failed/);
});

test('R3 persistent rate limits serialize concurrent bucket updates', () => {
  const limiter = read('src/lib/rateLimit.ts');
  assert.match(limiter, /TransactionIsolationLevel\.Serializable/);
  assert.match(limiter, /P2002|P2034/);
  assert.match(limiter, /rate_limit_retry_exhausted/);
});

test('Stage 1 integration and clean-clone harnesses do not inherit operator secrets', () => {
  const integration = fs.readFileSync(path.join(root, 'scripts', 'stage1_integration_harness.mjs'), 'utf8');
  const cleanClone = fs.readFileSync(path.join(root, 'scripts', 'check_clean_clone.mjs'), 'utf8');
  assert.match(integration, /function safeProcessEnvironment\(source = process\.env\)/);
  assert.match(cleanClone, /function safeProcessEnvironment\(\)/);
  assert.doesNotMatch(integration, /return \{\s*\.\.\.process\.env/);
  assert.doesNotMatch(cleanClone, /env:\s*\{\s*\.\.\.process\.env/);
  assert.match(integration, /assertLoopbackTestEndpoint/);
});

test('R3 credential lifecycle uses the durable unique version and atomic revoke boundary', () => {
  const source = read('src/lib/hubOperatorCredentials.ts');
  assert.match(source, /HubCredentialVersion_hub_purpose_version_key/);
  assert.match(source, /purpose: 'operator-credential'/);
  assert.match(source, /PrismaClientKnownRequestError/);
  assert.match(source, /error\.code !== 'P2002'/);
  assert.match(source, /prisma\.\$transaction\(async \(tx\) =>/);
  assert.match(source, /accessPolicyRevision: \{ increment: 1 \}/);
});
