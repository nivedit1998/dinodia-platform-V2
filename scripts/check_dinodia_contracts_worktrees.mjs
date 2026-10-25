// Read-only compatibility launcher; the checker now supports explicit roots directly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const names = ['DINODIA_OS_ROOT', 'DINODIA_IOS_ROOT', 'DINODIA_ALEXA_ROOT', 'DINODIA_EDGE_ROOT'];
const roots = process.argv.slice(2);
if (roots.length !== names.length || roots.some(root => !path.isAbsolute(root) || !fs.statSync(root).isDirectory())) {
  throw new Error('Supply four explicit absolute roots: Hub, iOS, Alexa, Edge (read-only)');
}
const checker = fileURLToPath(new URL('./check_dinodia_contracts.mjs', import.meta.url));
const env = { ...process.env, ...Object.fromEntries(names.map((name, index) => [name, fs.realpathSync(roots[index])])) };
const result = spawnSync(process.execPath, [checker], { stdio: 'inherit', cwd: path.dirname(checker), env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
