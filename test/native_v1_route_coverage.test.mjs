import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { stage1RouteInventory } from './stage1_route_inventory.mjs';

const root = process.cwd();
const coveragePath = 'contracts/platform-v2-route-coverage.json';
const coverage = JSON.parse(fs.readFileSync(path.join(root, coveragePath), 'utf8'));
const acRouteMatrix = coverage;
const yaml = createRequire(import.meta.url)('js-yaml');
const openApi = yaml.load(fs.readFileSync(path.join(root, 'contracts/dinodia-v1/openapi.yaml'), 'utf8'));
const methodNames = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];
const acceptanceCriterionPattern = /^AC-(?:02\.(?:[1-9]|[1-3][0-9]|4[0-5])|06\.(?:[1-9]|[1-2][0-9]|3[0-5])|07\.(?:[1-9]|1[0-9]|2[0-3])|08\.(?:[1-9]|1[0-9]|2[0-2])|09\.(?:[1-9]|[1-3][0-9])|10\.(?:[1-9]|1[0-9])|11\.(?:[1-9]|1[0-9]|2[0-5])|12\.(?:[1-9]|1[0-9]|20))$/;
const authEntries = new Map(stage1RouteInventory.map(([method, route, auth]) => [`${method} ${route}`, auth]));

function routePath(file) {
  const relative = file.replace(/^src\/app\/api/, '').replace(/\/route\.ts$/, '');
  return (`/api${relative}`).replace(/\[([^\]]+)\]/g, ':$1') || '/';
}

const entriesForCoverage = new Map(coverage.routes.flatMap((row) => row.methods.map((method) => [`${method} ${routePath(row.file)}`, row])));

function exportedMethods(source) {
  const methods = new Set();
  for (const match of source.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(/g)) methods.add(match[1]);
  for (const match of source.matchAll(/export\s+const\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*=/g)) methods.add(match[1]);
  for (const match of source.matchAll(/export\s*\{([^}]+)\}\s*from/g)) {
    for (const binding of match[1].split(',')) {
      const method = binding.trim().split(/\s+as\s+/).at(-1);
      if (methodNames.includes(method)) methods.add(method);
    }
  }
  return [...methods].sort();
}

function actualRouteFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return actualRouteFiles(absolute);
    return entry.isFile() && entry.name === 'route.ts' ? [path.relative(root, absolute)] : [];
  });
}

test('every executable Platform Native V2 route method has an explicit contract-boundary classification', () => {
  assert.equal(coverage.schemaVersion, 'dinodia.v1');
  assert.equal(coverage.evidenceLevel, 'route-inventory-and-auth-boundary-only');
  const entries = new Map();
  for (const row of coverage.routes) {
    assert.ok(row.file.startsWith('src/app/api/v2/'), `out-of-scope route ${row.file}`);
    assert.ok(row.boundary, `route missing boundary classification ${row.file}`);
    assert.ok(fs.existsSync(path.join(root, row.file)), `route file missing ${row.file}`);
    assert.ok(Array.isArray(row.methods) && row.methods.length > 0, `route has no methods ${row.file}`);
    assert.deepEqual([...row.methods].sort(), [...new Set(row.methods)].sort(), `route methods must be unique ${row.file}`);
    const source = fs.readFileSync(path.join(root, row.file), 'utf8');
    assert.deepEqual(exportedMethods(source), [...row.methods].sort(), `route method drift ${row.file}`);
    const route = routePath(row.file);
    for (const method of row.methods) {
      const key = `${method} ${route}`;
      assert.equal(entries.has(key), false, `duplicate contract coverage ${key}`);
      entries.set(key, row);
    }
  }

  const actualFiles = actualRouteFiles(path.join(root, 'src/app/api/v2')).sort();
  assert.deepEqual(coverage.routes.map((row) => row.file).sort(), actualFiles, 'new or removed Native V2 route files require a reviewed map update');

  for (const [methodAndRoute, row] of entries) {
    assert.ok(authEntries.has(methodAndRoute), `runtime auth inventory omits ${methodAndRoute}`);
    const authClass = authEntries.get(methodAndRoute);
    const source = fs.readFileSync(path.join(root, row.file), 'utf8');
    if (row.boundary === 'explicit_feature_disabled') {
      assert.equal(authClass, 'public-disabled-feature', `${methodAndRoute} must remain an explicit disabled boundary`);
      assert.match(source, /nativeFeatureNotEnabled/, `${methodAndRoute} must use the canonical disabled response`);
    } else if (authClass !== 'public-login') {
      if (authClass === 'public-oauth-intent') {
        assert.equal(row.principalProfile, 'public_oauth_intent', `${methodAndRoute} must use the one-use tenant-connect-intent profile`);
        assert.match(source, /lockAndValidateAlexaConnectIntent/, `${methodAndRoute} must revalidate its one-use tenant connect intent`);
      } else if (authClass === 'public-oauth-client') {
        assert.equal(row.principalProfile, 'public_oauth_client', `${methodAndRoute} must use the OAuth-client-authenticated profile`);
        assert.match(source, /alexaOAuthClientAuthenticated/, `${methodAndRoute} must validate the exact OAuth client`);
      } else assert.ok(['customer', 'employee'].includes(authClass), `${methodAndRoute} lacks an explicit principal class`);
      const harness = fs.readFileSync(path.join(root, 'scripts/stage1_integration_harness.mjs'), 'utf8');
      assert.match(harness, /stage1RouteInventory\.filter\(/, 'integration harness must execute the protected-route inventory');
    }
  }
});

test('every Native V2 route method has an explicit role-profile and AC cross-reference', () => {
  assert.equal(acRouteMatrix.evidenceLevel, 'route-inventory-and-auth-boundary-only', 'the route index must not overstate acceptance evidence');
  assert.ok(acRouteMatrix.principalProfiles && Object.keys(acRouteMatrix.principalProfiles).length > 0, 'principal profiles are required');
  const indexed = new Set();
  for (const row of acRouteMatrix.routes) {
    assert.ok(Array.isArray(row.acceptanceCriteria) && row.acceptanceCriteria.length > 0, `AC cross-reference missing for ${row.file}`);
    for (const criterion of row.acceptanceCriteria) assert.match(criterion, acceptanceCriterionPattern, `invalid AC reference ${criterion} in ${row.file}`);
    for (const method of row.methods) {
      const profile = typeof row.principalProfile === 'string' ? row.principalProfile : row.principalProfile?.[method];
      assert.ok(profile, `principal profile missing for ${method} ${routePath(row.file)}`);
      assert.ok(acRouteMatrix.principalProfiles[profile], `unknown principal profile ${profile} for ${method} ${routePath(row.file)}`);
      const routeKey = `${method} ${routePath(row.file)}`;
      assert.ok(acRouteMatrix.principalProfiles[profile].stage1AuthClasses.includes(authEntries.get(routeKey)), `role profile/auth inventory mismatch for ${routeKey}`);
      const key = `${method} ${routePath(row.file)}`;
      assert.equal(indexed.has(key), false, `duplicate role/AC index row ${key}`);
      indexed.add(key);
      assert.ok(entriesForCoverage.has(key), `role/AC index is not tied to an inventoried route ${key}`);
    }
  }
  assert.deepEqual([...indexed].sort(), [...entriesForCoverage.keys()].sort(), 'every route method must have exactly one role/AC index entry');
});

test('property-support revoke OpenAPI binds the approving customer and exact step-up DTO', () => {
  const route = '/api/v2/support/tickets/{ticketId}/access-requests/{requestId}/revoke';
  const operation = openApi.paths[route]?.post;
  assert.ok(operation, 'support revocation route is documented');
  assert.ok(operation.parameters.some((parameter) => parameter.$ref === '#/components/parameters/StepUpProof'));
  assert.equal(operation.parameters.some((parameter) => parameter.$ref === '#/components/parameters/IdempotencyKey'), false);
  assert.equal(operation.requestBody?.content?.['application/json']?.schema?.$ref, './contract.json#/$defs/supportAccessRevokeRequest');
  assert.equal(operation.responses?.['200']?.content?.['application/json']?.schema?.$ref, './contract.json#/$defs/supportAccessRevokeReceipt');
  const indexed = coverage.routes.find((row) => row.file === 'src/app/api/v2/support/tickets/[ticketId]/access-requests/[requestId]/revoke/route.ts');
  assert.equal(indexed?.principalProfile, 'customer_membership');
  assert.equal(indexed?.boundary, 'customer_step_up_stage1_projection');
});

test('support approval never returns the one-use code; only the assigned-employee issue response may carry it', () => {
  const approve = openApi.paths['/api/v2/support/tickets/{ticketId}/access-requests/{requestId}/approve'].post;
  const issue = openApi.paths['/api/v2/support/tickets/{ticketId}/access-requests/{requestId}/issue'].post;
  assert.equal(approve.responses['200'].content['application/json'].schema.$ref, './contract.json#/$defs/supportAccessDecisionReceipt');
  assert.equal(issue.responses['200'].content['application/json'].schema.$ref, './contract.json#/$defs/supportAccessIssueReceipt');
  assert.equal(issue.parameters.some((parameter) => parameter.$ref === '#/components/parameters/IdempotencyKey'), false, 'one-time plaintext cannot be replayed for re-disclosure');
  const customerRoute = fs.readFileSync(path.join(root, 'src/app/api/v2/support/tickets/[ticketId]/access-requests/[requestId]/approve/route.ts'), 'utf8');
  const employeeRoute = fs.readFileSync(path.join(root, 'src/app/api/v2/support/tickets/[ticketId]/access-requests/[requestId]/issue/route.ts'), 'utf8');
  assert.doesNotMatch(customerRoute, /oneUseCode/);
  assert.match(employeeRoute, /requireEmployeeRecentAuth/);
  assert.match(employeeRoute, /requestedByEmployeeId:\s*employee\.id/);
  assert.match(employeeRoute, /status:\s*'ISSUED',\s*codeHash/);
  assert.match(employeeRoute, /validateSupportAccessIssueReceipt\(receipt\)/);
});

test('support approval inbox has an explicit selected-membership privacy contract', () => {
  const route = '/api/v2/support/access-requests';
  assert.ok(openApi.paths[route]?.get);
  assert.equal(openApi.paths[route].get.responses['200'].content['application/json'].schema.$ref, './contract.json#/$defs/supportAccessApprovalProjection');
  const indexed = coverage.routes.find((row) => row.file === 'src/app/api/v2/support/access-requests/route.ts');
  assert.equal(indexed?.principalProfile, 'customer_membership');
  assert.equal(indexed?.boundary, 'customer_session_native_projection');
  const source = fs.readFileSync(path.join(root, 'src/app/api/v2/support/access-requests/route.ts'), 'utf8');
  assert.match(source, /customer\.role === 'TENANT'[\s\S]*?targetMembershipId === customer\.membershipId/);
  assert.match(source, /customer\.role === 'OWNER' \|\| customer\.role === 'PROPERTY_MANAGER'/);
  assert.doesNotMatch(source, /description|safeDiagnostics|targetIds/);
});

test('all active Native V2 non-Alexa routes preserve the canonical Native V1 error adapter', () => {
  for (const row of coverage.routes.filter((item) => !item.file.includes('/alexa/') && !['explicit_feature_disabled', 'delegates_to_canonical_customer_session_handlers'].includes(item.boundary))) {
    const source = fs.readFileSync(path.join(root, row.file), 'utf8');
    if (/nativeV1ErrorResponse/.test(source)) continue;
    // A small compatibility path may delegate to the canonical route handler;
    // verify that concrete target owns the error adapter instead of requiring
    // every alias to duplicate its error mapping.
    const delegated = source.match(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
    assert.ok(delegated, `${row.file} must either map errors directly or delegate to a canonical route`);
    assert.ok(row.methods.every((method) => delegated[1].includes(method)), `${row.file} must delegate each indexed method`);
    const targetBase = path.resolve(path.dirname(path.join(root, row.file)), delegated[2]);
    const targets = [`${targetBase}.ts`, path.join(targetBase, 'route.ts')];
    const target = targets.find((candidate) => fs.existsSync(candidate));
    assert.ok(target, `${row.file} delegation target must exist`);
    assert.match(fs.readFileSync(target, 'utf8'), /nativeV1ErrorResponse/, `${row.file} delegated handler must map errors through the canonical envelope`);
  }
});

test('customer-facing Alexa management routes preserve the canonical Native V1 error adapter', () => {
  const customerRoutes = [
    ['src/app/api/v2/alexa/home-scope/route.ts', 1],
    ['src/app/api/v2/alexa/home-scope/unlink/route.ts', 1],
    ['src/app/api/v2/alexa/link-status/route.ts', 2],
  ];
  for (const [file, expectedCatches] of customerRoutes) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(source, /import\s+\{\s*nativeV1ErrorResponse\s*\}\s+from\s+['"]@\/lib\/contracts\/nativeV1Error['"]/);
    assert.equal([...source.matchAll(/return nativeV1ErrorResponse\(error\)/g)].length, expectedCatches, `${file} must map each customer route error through the canonical envelope`);
  }
});

test('OpenAPI documents every currently executable Native V2 route method', () => {
  for (const row of coverage.routes) {
    const openApiPath = routePath(row.file).replace(/:([^/]+)/g, '{$1}');
    for (const method of row.methods) {
      assert.ok(openApi.paths?.[openApiPath]?.[method.toLowerCase()], `OpenAPI omits ${method} ${openApiPath}`);
    }
  }
  assert.equal(openApi.paths?.['/api/v2/support/tickets/{ticketId}/access-request'], undefined, 'the retired singular support path must not compete with the executable plural route');
  assert.ok(openApi.paths?.['/api/v2/support/tickets/{ticketId}/access-requests']?.post, 'the executable plural support request path must remain canonical');
});

test('trusted-device removal documents the exact optional-proof request and account-wide receipt', () => {
  const operation = openApi.paths?.['/api/v2/trusted-devices/{trustedDeviceId}']?.delete;
  assert.ok(operation, 'the account-wide trusted-device revocation route must be documented');
  assert.equal(operation.requestBody?.required, false, 'the proof may be supplied by the documented header');
  const requestRef = operation.requestBody?.content?.['application/json']?.schema?.$ref;
  assert.equal(requestRef, './contract.json#/$defs/trustedDeviceRemovalRequest');
  assert.ok(operation.parameters?.some((parameter) => parameter.$ref === '#/components/parameters/StepUpProof'), 'step-up proof header must be part of the route contract');
  const success = operation.responses?.['200']?.content?.['application/json']?.schema?.$ref;
  assert.equal(success, './contract.json#/$defs/trustedDeviceRemovalReceipt', 'the route must report the account-wide revocation receipt');
  assert.equal(operation.responses?.['204'], undefined, 'the route does not use the old empty 204 response');
});

test('customer login aliases share one canonical request and document every emitted error status', () => {
  const canonicalRef = './contract.json#/$defs/customerSessionLoginRequest';
  const errors = ['400', '401', '403', '409', '429'];
  for (const route of ['/api/v2/auth/session', '/api/v2/session']) {
    const operation = openApi.paths?.[route]?.post;
    assert.ok(operation, `${route} POST must remain documented`);
    assert.equal(operation.requestBody?.content?.['application/json']?.schema?.$ref, canonicalRef, `${route} must use the shared login DTO`);
    for (const status of errors) assert.ok(operation.responses?.[status], `${route} login response ${status} must be documented`);
    for (const status of errors) {
      const response = operation.responses[status];
      if (response.$ref) continue;
      assert.equal(response.content?.['application/json']?.schema?.$ref, '#/components/schemas/NativeError');
    }
  }
  assert.equal(openApi.components?.schemas?.NativeError?.$ref, './contract.json#/$defs/error');
  for (const route of ['/api/v2/auth/session', '/api/v2/session', '/api/v2/session/logout']) {
    const method = route === '/api/v2/session/logout' ? 'post' : 'delete';
    assert.equal(openApi.paths?.[route]?.[method]?.responses?.['200']?.content?.['application/json']?.schema?.$ref, './contract.json#/$defs/customerSessionLogoutReceipt');
  }
});
