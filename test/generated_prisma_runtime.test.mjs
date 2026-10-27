import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript'),root=path.resolve(import.meta.dirname,'..');
test('clean builds resolve Prisma types to the same worktree-local generated runtime',()=>{
 const file=ts.readConfigFile(path.join(root,'tsconfig.json'),ts.sys.readFile);assert.equal(file.error,undefined);
 const config=ts.parseJsonConfigFileContent(file.config,ts.sys,root);
 const resolved=ts.resolveModuleName('@prisma/client',path.join(root,'src/lib/areaDeletion.ts'),config.options,ts.sys).resolvedModule;
 assert.ok(resolved);assert.equal(fs.realpathSync(resolved.resolvedFileName),fs.realpathSync(path.join(root,'src/generated/prisma/index.d.ts')));
 const source=fs.readFileSync(path.join(root,'src/lib/prisma.ts'),'utf8');
 assert.match(source,/import \{ PrismaClient \} from '\.\.\/generated\/prisma'/);
 assert.doesNotMatch(source,/StablePrismaClient/,'no dependency on a separately generated shared client');
});
