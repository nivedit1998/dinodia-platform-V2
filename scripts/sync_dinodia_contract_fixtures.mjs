import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const platform = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(platform, 'contracts/dinodia-v1');
// Every destination must be explicitly supplied. Never discover writable sibling checkouts.
const targets = JSON.parse(process.env.DINODIA_CONTRACT_TARGETS || '{}');
const targetBranches = JSON.parse(process.env.DINODIA_CONTRACT_TARGET_BRANCHES || '{}');
const paths = { hub: 'test/fixtures/contracts/dinodia-v1', ios: 'DinodiaTests/Fixtures/DinodiaV1',
  alexa: 'test/fixtures/dinodia-v1', edge: 'test/fixtures/dinodia-v1' };
if (!Object.keys(targets).length || Object.keys(targets).some(key => !Object.hasOwn(paths, key)))
  throw new Error('DINODIA_CONTRACT_TARGETS must explicitly map supported consumer names to claimed durable worktrees');
const repos = Object.entries(targets).map(([consumer, directory]) => {
  if (!path.isAbsolute(directory)) throw new Error('Consumer root must be absolute');
  const root = fs.realpathSync(directory);
  if (!root.includes('/worktrees/')) throw new Error('Refusing to mutate a primary checkout');
  const branch = execFileSync('git', ['-C', root, 'branch', '--show-current'], { encoding: 'utf8' }).trim();
  if (targetBranches[consumer] ? branch !== targetBranches[consumer] : !branch.endsWith('universal-category-analytics-20261023'))
    throw new Error('Consumer branch is not claimed for this task');
  return [root, paths[consumer]];
});
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
if (targets.ios) {
const iosPrototype = path.resolve(targets.ios, 'Dinodia/DebugFixtures');
fs.mkdirSync(iosPrototype, { recursive: true });
fs.copyFileSync(path.join(source, 'V2_STATIC_TO_LIVE_MATRIX.md'), path.join(iosPrototype, 'V2_STATIC_TO_LIVE_MATRIX.md'));
const iosPrototypeContracts = path.join(iosPrototype, 'DinodiaV1');
fs.mkdirSync(iosPrototypeContracts, { recursive: true });
fs.copyFileSync(path.join(source, 'decisions.json'), path.join(iosPrototypeContracts, 'decisions.json'));
const iosPrototypeFixtures = path.join(iosPrototype, 'DinodiaV1/fixtures');
fs.mkdirSync(iosPrototypeFixtures, { recursive: true });
for (const fixture of [
  'account-session-two-homes.json',
  'alexa-discovery-projection.json',
  'customer-hub-session-test-only.json',
  'account-relationship-lifecycle.json',
  'automation-stage11-live.json',
  'automation-full-bundle.json',
  'automation-property-impact.json',
  'invalid/automation-property-target-extra-authority.json',
  'analytics-semantics.json',
  'access-request-lifecycle.json',
  'area-edit-lifecycle.json',
  'commissioning-expired.json',
  'control-catalog-change.json',
  'customer-recovery-lifecycle.json',
  'duplicate-display-names.json',
  'hub-cloudurl-verified.json',
  'invitation-pending-no-membership.json',
  'invalid/tenant-device-wrong-owner.json',
  'multi-control-device.json',
  'offline-home-selection.json',
  'prototype-scenarios.json',
  'room-qr-lifecycle.json',
  'tenant-membership-removal-final-warning.json',
  'claim-first-wins.json',
  'claim-lifecycle.json',
  'stage2-decision-matrix.json',
  'selected-tenant-property-device.json',
  'selected-tenant-private-device.json',
  'support-ticket-private.json',
  'support-lifecycle.json',
  'support-access-revoke.json',
  'invalid/support-access-revoke-extra-authority.json',
  'invitation-lifecycle.json',
  'index.json',
  'installation-request-lifecycle.json',
  'offline-deregistration-pending.json',
  'out-of-order-events.json',
  'transfer-lifecycle.json',
  'trusted-device-revocation.json',
  'tenant-device-dashboard.json',
  'tenant-device-removal-pending.json',
  'notification-lifecycle.json',
  'updater-maintenance-status-unprovisioned.json',
  'invalid/updater-maintenance-status-exposes-authority.json',
]) {
  const target = path.join(iosPrototypeFixtures, fixture);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(source, 'fixtures', fixture), target);
}
// Keep every indexed DEBUG screen fixture in lock-step with the contract
// index. A hand-maintained subset silently leaves the app bundle stale when a
// consumer adds a legitimate screen fixture.
const debugScreenIndex = JSON.parse(fs.readFileSync(path.join(source, 'fixtures/index.json'), 'utf8'));
const debugScreenFixturePaths = [...new Set(Object.values(debugScreenIndex.screenFixtures ?? {}).flat())]
  .filter((fixture) => typeof fixture === 'string' && fixture.startsWith('fixtures/') && !fixture.split('/').includes('..'))
  .map((fixture) => fixture.slice('fixtures/'.length));
for (const fixture of debugScreenFixturePaths) {
  const target = path.join(iosPrototypeFixtures, fixture);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(source, 'fixtures', fixture), target);
}
}
console.log(`Synchronized dinodia.v1 schemas and fixtures to ${repos.length} explicit consumers`);
