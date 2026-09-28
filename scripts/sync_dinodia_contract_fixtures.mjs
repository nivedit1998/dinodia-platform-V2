import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
const platform = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(platform, 'contracts/dinodia-v1');
const repos = [
  ['../Dinodia OS', 'test/fixtures/contracts/dinodia-v1'],
  ['../dinodia-ios-app-V2', 'DinodiaTests/Fixtures/DinodiaV1'],
  ['../dinodia-alexa-skill-V2', 'test/fixtures/dinodia-v1'],
  ['../dinodia-edge-worker-V2', 'test/fixtures/dinodia-v1'],
];
for (const [repo, relative] of repos) {
  const target = path.resolve(platform, repo, relative);
  fs.mkdirSync(target, { recursive: true });
  for (const name of ['contract.json', 'decisions.json', 'openapi.yaml', 'V2_STATIC_TO_LIVE_MATRIX.md', 'schemas', 'fixtures']) fs.cpSync(path.join(source, name), path.join(target, name), { recursive: true, force: true });
  const files = [];
  const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (entry.name !== 'manifest.json') files.push([path.relative(target, file).split(path.sep).join('/'), fs.readFileSync(file)]); } };
  walk(target);
  const hash = crypto.createHash('sha256');
  for (const [name, bytes] of files) hash.update(name).update('\0').update(bytes).update('\0');
  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify({ contractVersion: 'dinodia.v1', bundleSha256: hash.digest('hex') }, null, 2) + '\n');
}
const iosPrototype = path.resolve(platform, '../dinodia-ios-app-V2/Dinodia/DebugFixtures');
fs.mkdirSync(iosPrototype, { recursive: true });
fs.copyFileSync(path.join(source, 'V2_STATIC_TO_LIVE_MATRIX.md'), path.join(iosPrototype, 'V2_STATIC_TO_LIVE_MATRIX.md'));
console.log(`Synchronized dinodia.v1 schemas and fixtures to ${repos.length} consumers and the DEBUG-only iOS prototype`);
