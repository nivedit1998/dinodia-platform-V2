// Architecture: Repository maintenance or verification script scripts/generate_surface_inventory.mjs; supports parity, generation, security, logging or operational checks outside request-time runtime code.
import { execFileSync } from 'node:child_process';

process.stdout.on('error', (err) => {
  if (err && typeof err === 'object' && 'code' in err && err.code === 'EPIPE') {
    process.exit(0);
  }
  throw err;
});

function runRg(args) {
  return execFileSync('rg', args, { encoding: 'utf8' });
}

function listFiles(glob) {
  try {
    const out = runRg(['--files', '--glob', glob, '--glob', '!node_modules/**', '--glob', '!.next/**']);
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .sort();
  } catch (err) {
    const code = err && typeof err === 'object' && 'status' in err ? err.status : null;
    if (code === 1) return [];
    throw err;
  }
}

const apiRoutes = listFiles('src/app/api/**/route.ts');
const installerPages = listFiles('src/app/installer/**/page.tsx');
const adminPages = listFiles('src/app/admin/**/page.tsx');

process.stdout.write(`# Surface Inventory\n`);
process.stdout.write(`Generated: ${new Date().toISOString()}\n\n`);

process.stdout.write(`## API routes (${apiRoutes.length})\n`);
for (const f of apiRoutes) process.stdout.write(`- ${f}\n`);

process.stdout.write(`\n## Installer pages (${installerPages.length})\n`);
for (const f of installerPages) process.stdout.write(`- ${f}\n`);

process.stdout.write(`\n## Admin pages (${adminPages.length})\n`);
for (const f of adminPages) process.stdout.write(`- ${f}\n`);
