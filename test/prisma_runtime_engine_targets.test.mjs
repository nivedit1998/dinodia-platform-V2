import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('Prisma generates the engine for Vercel Linux ARM64 even from a macOS build host', () => {
  const generator = schema.match(/generator client\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(generator, /binaryTargets\s*=\s*\[[^\]]*"native"/);
  assert.match(generator, /binaryTargets\s*=\s*\[[^\]]*"linux-arm64-openssl-3\.0\.x"/);
});

test('the production build regenerates Prisma Client before Next bundles server functions', () => {
  assert.match(packageJson.scripts?.build ?? '', /prisma generate\s*&&\s*next build/);
});
