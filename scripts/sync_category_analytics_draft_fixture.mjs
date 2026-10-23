// UC-02 ONLY: synchronize the draft truth table, never the published multi-repo bundle.
// Replaces use of the broad sibling-path sync script for this phase.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.length !== 2 || !['--check', '--apply'].includes(args[0]) || !path.isAbsolute(args[1])) {
  throw new Error('Usage: node scripts/sync_category_analytics_draft_fixture.mjs --check|--apply ABSOLUTE_HUB_WORKTREE');
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hub = fs.realpathSync(args[1]);
const branch = execFileSync('git', ['-C', hub, 'branch', '--show-current'], { encoding: 'utf8' }).trim();
if (branch !== 'feat/hub-universal-category-analytics-20261023' || !hub.includes('/worktrees/')) {
  throw new Error('Refusing a primary checkout or a different branch');
}
const relative = 'test/fixtures/category-analytics-next-policy.json';
const source = fs.readFileSync(path.join(root, relative));
const target = path.join(hub, relative);
if (args[0] === '--apply') fs.writeFileSync(target, source);
if (!source.equals(fs.readFileSync(target))) throw new Error('Draft truth tables differ');
console.log('UC-02 draft truth-table parity OK; published bundles and other consumers untouched');
