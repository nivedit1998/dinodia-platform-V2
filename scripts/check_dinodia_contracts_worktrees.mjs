// Read-only UC-02 wrapper: explicit consumers instead of implicit sibling checkouts.
// The original checker and all published fixtures remain unmodified.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const names = ['Dinodia OS', 'dinodia-ios-app-V2', 'dinodia-alexa-skill-V2', 'dinodia-edge-worker-V2'];
const roots = process.argv.slice(2);
if (roots.length !== names.length || roots.some(root => !path.isAbsolute(root) || !fs.statSync(root).isDirectory())) {
  throw new Error('Supply four explicit absolute roots: Hub, iOS, Alexa, Edge (read-only)');
}
const checker = fileURLToPath(new URL('./check_dinodia_contracts.mjs', import.meta.url));
let source = fs.readFileSync(checker, 'utf8');
source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(checker).href));
source = source.replace('"./dinodia_stage2_decisions.mjs"', JSON.stringify(new URL('./dinodia_stage2_decisions.mjs', import.meta.url).href));
for (let i = 0; i < names.length; i++) {
  source = source.replaceAll('"../' + names[i], JSON.stringify(fs.realpathSync(roots[i])).slice(0, -1));
}
const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { stdio: 'inherit', cwd: path.dirname(checker) });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
