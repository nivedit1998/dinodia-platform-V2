import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';import path from 'node:path';
const require=createRequire(import.meta.url),ts=require('typescript');
function load(file){const m={exports:{}};const js=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('require','module','exports',js)(n=>n==='./prisma'?{prisma:{}}:n==='./stage1Auth'?{Stage1AuthError:Error}:n==='./nativeAnalyticsAccess'?{}:n.startsWith('.')?load(path.resolve(path.dirname(file),n+'.ts')):require(n),m,m.exports);return m.exports;}
const {aggregateStateDays}=load('src/lib/multiStateAnalyticsReads.ts');
const start=Date.parse('2026-10-25T00:00:00.000Z');
function row(device,seconds,at=start){return{deviceId:device,areaId:'room',dayStartAt:new Date(at),dayEndAt:new Date(at+86400000),
 coverageStartAt:new Date(at),coverageEndAt:new Date(at+seconds*1000),durationsSeconds:{on:seconds,off:0,unknown:0},
 hourly:[{hourStartAt:new Date(at).toISOString(),coverageStartAt:new Date(at).toISOString(),coverageEndAt:new Date(at+seconds*1000).toISOString(),durationsSeconds:{on:seconds,off:0,unknown:0}}]};}
test('larger periods average contributing device-days, not epoch fragments or averages',()=>{
 const a=row('a',60),fragment={...row('a',120),coverageStartAt:new Date(start+60000),coverageEndAt:new Date(start+180000)};
 const [bucket]=aggregateStateDays([a,fragment,row('b',300)],'TV','month','Europe/London',start,start+86400000);
 assert.equal(bucket.contributingDeviceDays,2);assert.equal(bucket.durationsSeconds.on,240);assert.equal(bucket.coverageSeconds,240);
});
test('hourly history sums devices and never guesses a partial aggregate split',()=>{
 const [bucket]=aggregateStateDays([row('a',60),row('b',120)],'TV','hour','UTC',start,start+3600000);
 assert.equal(bucket.durationsSeconds.on,180);
 assert.deepEqual(aggregateStateDays([row('a',60)],'TV','hour','UTC',start+1000,start+3600000),[]);
});
