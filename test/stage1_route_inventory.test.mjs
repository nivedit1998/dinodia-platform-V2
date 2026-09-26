import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stage1RouteInventory } from './stage1_route_inventory.mjs';

const root = process.cwd();
const apiRoot = path.join(root, 'src/app/api');
const routePath = (file) => `/api/${path.relative(apiRoot, file).replace(/\/route\.ts$/, '').split(path.sep).map((part) => /^\[[^\]]+\]$/.test(part) ? `:${part.slice(1, -1)}` : part).join('/')}`;
const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name === 'route.ts') files.push(full);
  }
};

test('Stage 1 method/auth inventory covers every Platform API route exactly', () => {
  walk(apiRoot);
  const discovered = new Set();
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const route = routePath(file);
    for (const [, method] of source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g)) discovered.add(`${method} ${route}`);
  }
  const inventory = stage1RouteInventory.map(([method, route]) => `${method} ${route}`).sort();
  assert.equal(new Set(inventory).size, inventory.length, 'duplicate route/method classification');
  assert.deepEqual(inventory, [...discovered].sort(), 'add or update a method-level auth classification for every API route');
  for (const [method, route, auth] of stage1RouteInventory) {
    assert.match(method, /^(GET|POST|PUT|PATCH|DELETE)$/);
    assert.ok(auth, `${method} ${route} has no authentication classification`);
  }
});
