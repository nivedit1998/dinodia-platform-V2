import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildIdPath = path.join(root, '.next', 'BUILD_ID');

try {
  await import('node:fs/promises').then(({ access }) => access(buildIdPath));
} catch {
  throw new Error('A production build is required; run `npm run build` before this runtime check.');
}

const server = createServer();
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const { port } = server.address();
await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

const child = spawn(process.execPath, [
  path.join(root, 'node_modules/next/dist/bin/next'),
  'start', '--hostname', '127.0.0.1', '--port', String(port),
], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' },
  stdio: 'ignore',
});

const stopServer = async () => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
};

try {
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  let response;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Next production server exited before becoming ready (code ${child.exitCode}).`);
    try {
      response = await fetch(`${baseUrl}/.well-known/apple-app-site-association`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(1000),
      });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  assert.ok(response, 'Next production server did not become ready within 20 seconds.');
  assert.equal(response.status, 200, 'AASA must be served directly, without a redirect.');
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=300');

  const body = await response.json();
  assert.deepEqual(body, {
    applinks: {
      apps: [],
      details: [{
        appIDs: ['P759CSZK34.com.dinodia.DinodiaV2'],
        components: [{ '/': '/app/*' }],
      }],
    },
  });
  console.log(JSON.stringify({
    ok: true,
    status: response.status,
    contentType: response.headers.get('content-type'),
    cacheControl: response.headers.get('cache-control'),
    appIdentifier: body.applinks.details[0].appIDs[0],
    paths: body.applinks.details[0].components.map((component) => component['/']),
  }));
} finally {
  await stopServer();
}
