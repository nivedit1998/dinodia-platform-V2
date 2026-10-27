// Disposable loopback-only database. Never reads .env or forwards Production credentials.
import {execFileSync,spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),ts=require('typescript');
const modules=new Map();
const authErrors={Stage1AuthError:class extends Error{constructor(status,code,message){super(message);Object.assign(this,{status,code});}}};
const name=`dinodia-udc-state-${process.pid}`,password=randomBytes(24).toString('hex');let started=false,db;
const env=Object.fromEntries(['PATH','TMPDIR','HOME','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
function load(file){file=path.resolve(file);if(modules.has(file))return modules.get(file).exports;const m={exports:{}};modules.set(file,m);const js=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('require','module','exports',js)(n=>n==='@prisma/client'?require('../src/generated/prisma'):n==='./prisma'?{prisma:db}:n==='./customerSelectedHome'?{requireCustomerSelectedHome:()=>{throw new Error('Not an HTTP authorization test');}}:n==='./stage1Auth'?authErrors:n.startsWith('.')?load(path.resolve(path.dirname(file),n+'.ts')):require(n),m,m.exports);return m.exports;}
try{
 execFileSync('docker',['run','-d','--name',name,'--memory=256m','--cpus=1','-e','POSTGRES_PASSWORD','-e','POSTGRES_DB=dinodia_udc_state','-p','127.0.0.1::5432','postgres:16-alpine'],{env:{...env,POSTGRES_PASSWORD:password},stdio:'pipe'});started=true;
 let ready=false;for(let i=0;i<40;i++){if(spawnSync('docker',['exec',name,'pg_isready','-U','postgres'],{stdio:'ignore'}).status===0){ready=true;break;}await new Promise(r=>setTimeout(r,250));}assert.ok(ready);
 const address=execFileSync('docker',['port',name,'5432/tcp'],{encoding:'utf8'}).trim();assert.match(address,/^127\.0\.0\.1:\d+$/);
 const url=`postgresql://postgres:${password}@${address}/dinodia_udc_state`;
 const migration=spawnSync('npx',['prisma','migrate','deploy'],{env:{...env,DATABASE_URL:url,DIRECT_URL:url},encoding:'utf8'});
 if(migration.status!==0){console.error(migration.stderr.replaceAll(password,'[redacted]'));throw new Error('Disposable migration failed');}
 const {PrismaClient}=require('../src/generated/prisma');db=new PrismaClient({datasourceUrl:url,log:[{emit:'event',level:'query'}]});
 let previousQuery='';db.$on('query',event=>{if(!/^(BEGIN|ROLLBACK|COMMIT|SAVEPOINT|RELEASE)/.test(event.query))previousQuery=event.query;});
 const home=await db.home.create({data:{timezone:'Europe/London'}});
 const identity=await db.hubManufacturingIdentity.create({data:{serialNumber:'UDC-SYNTHETIC',signingPublicKey:'synthetic',encryptionPublicKey:'synthetic',signingKeyFingerprint:'synthetic-sign',encryptionKeyFingerprint:'synthetic-encrypt'}});
 const hub=await db.hubInstallation.create({data:{homeId:home.id,manufacturingIdentityId:identity.id,serialNumberSnapshot:'UDC-SYNTHETIC',analyticsWriterEnabled:true}});
 const area=await db.area.create({data:{homeId:home.id,osAreaId:'a',originalName:'Synthetic'}});
 const device=await db.nativeDevice.create({data:{homeId:home.id,hubInstallationId:hub.id,osDeviceId:'d',originalName:'Synthetic',technicalLabel:'Synthetic',deviceType:'switch',managementClass:'PROPERTY_DEVICE',analyticsCategory:'TV',lifecycle:'INSTALLED'}});
 const start=new Date('2026-10-27T00:00:00.000Z'),end=new Date('2026-10-27T00:01:00.000Z');
 await db.deviceAreaAssignment.create({data:{homeId:home.id,deviceId:device.id,areaId:area.id,validFrom:start,source:'OS_SYNC'}});
 const interval=await db.nativeAnalyticsInterval.create({data:{homeId:home.id,hubInstallationId:hub.id,deviceId:device.id,analyticsCategory:'TV',selectedControlId:'power',authorizedControls:[{controlId:'power',surfaceId:'1',semanticRole:'power',observable:true,writable:true}],sourceGeneration:1,revision:1,analyticsPolicyVersion:4,validFrom:start}});
 await db.nativeAnalyticsRetention.create({data:{homeId:home.id,hubInstallationId:hub.id,timezone:'Europe/London',writerFrom:start,writerEnabled:true,barrierStreamId:'11111111-1111-4111-8111-111111111111',barrierSequence:1,legacySealedThrough:start}});
 const {multiStateDailyAggregateId}=load('src/lib/multiStateAnalyticsContract.ts');
 const {ingestMultiStateAnalytics}=load('src/lib/multiStateAnalyticsIngestion.ts');
 const p={contractVersion:1,osDeviceId:'d',osAreaId:'a',analyticsCategory:'TV',dimension:'power',controlId:'power',sourceGeneration:1,bindingRevision:1,analyticsIntervalId:interval.id,analyticsPolicyVersion:4,timezone:'Europe/London',writerFrom:start.toISOString(),dayStartAt:start.toISOString(),dayEndAt:'2026-10-28T00:00:00.000Z',assignmentEpochAt:start.toISOString(),revision:1,coverageStartAt:start.toISOString(),coverageEndAt:end.toISOString(),closedAt:null,durationsSeconds:{on:60,off:0,unknown:0},hourly:[{hourStartAt:start.toISOString(),coverageStartAt:start.toISOString(),coverageEndAt:end.toISOString(),durationsSeconds:{on:60,off:0,unknown:0}}]};
 const input={homeId:home.id,hubInstallationId:hub.id,identityGeneration:1,streamId:'11111111-1111-4111-8111-111111111111',now:new Date('2026-10-27T01:00:00.000Z'),event:{id:'22222222-2222-4222-8222-222222222222',sequence:2,type:'analytics.state.day',aggregateId:multiStateDailyAggregateId(p),payload:p}};
 await db.$transaction(tx=>ingestMultiStateAnalytics(tx,input));await db.$transaction(tx=>ingestMultiStateAnalytics(tx,input));
 assert.equal(await db.nativeAnalyticsStateDay.count(),1,'absolute replay cannot duplicate');
 assert.deepEqual((await db.nativeAnalyticsStateDay.findFirst()).durationsSeconds,p.durationsSeconds);
 const {readMultiStateAnalytics,readStateAnalyticsCategories}=load('src/lib/multiStateAnalyticsReads.ts');
 const query=new URLSearchParams({category:'TV',level:'hour',from:start.toISOString(),to:input.now.toISOString()});
 const measured=await readMultiStateAnalytics(home.id,'Europe/London',query,input.now);
 assert.equal(measured.buckets[0].durationsSeconds.on,60);
 assert.deepEqual(await readStateAnalyticsCategories(home.id),['tv']);
 assert.deepEqual((await readMultiStateAnalytics('33333333-3333-4333-8333-333333333333','Europe/London',query,input.now)).buckets,[]);
 const size=(await db.$queryRaw`SELECT pg_column_size(d)::int AS bytes FROM "NativeAnalyticsStateDay" d LIMIT 1`)[0].bytes;
 console.log(`Synthetic one-hour state-row payload: ${size} bytes (not total indexed/table storage)`);
 const conflicting={...p,durationsSeconds:{on:0,off:60,unknown:0},hourly:p.hourly.map(h=>({...h,durationsSeconds:{on:0,off:60,unknown:0}}))};
 await assert.rejects(db.$transaction(tx=>ingestMultiStateAnalytics(tx,{...input,event:{...input.event,payload:conflicting}})),e=>e.code==='hub_sync_state_revision_conflict');
 await assert.rejects(db.nativeAnalyticsStateDay.updateMany({data:{durationsSeconds:{on:61,off:0,unknown:0}}}));
 await assert.rejects(db.nativeAnalyticsStateDay.updateMany({data:{analyticsCategory:'AC'}}));
 await assert.rejects(db.$transaction(tx=>ingestMultiStateAnalytics(tx,{...input,identityGeneration:2})),e=>e.code==='hub_sync_state_coverage_invalid');
 const {exerciseStateHistoryMatrix}=await import('./universal_state_database_matrix.mjs');
 try{await exerciseStateHistoryMatrix({db,home,hub,area,device,interval,p,input,load,multiStateDailyAggregateId});}
 catch(error){console.error('SYNTHETIC_LAST_SQL '+previousQuery);throw error;}
 const account=await db.customerAccount.create({data:{displayName:'Synthetic',username:'synthetic',usernameNormalized:'synthetic',email:'synthetic@example.invalid',emailNormalized:'synthetic@example.invalid',passwordHash:'synthetic-not-a-login'}});
 const member=await db.homeMembership.create({data:{homeId:home.id,customerAccountId:account.id,role:'TENANT'}});
 await db.nativeDevice.update({where:{id:device.id},data:{managementClass:'TENANT_DEVICE',ownerMembershipId:member.id,analyticsCategory:'NONE',technicalLabel:'tenant_device'}});
 assert.deepEqual((await readMultiStateAnalytics(home.id,'Europe/London',query,input.now)).buckets,[],'private telemetry cannot enter owner analytics');
 await assert.rejects(db.nativeAnalyticsStateDay.updateMany({data:{revision:2}}),'DB rejects writes for tenant-owned devices');
 const {purgeDailyAnalytics}=load('src/lib/dailyAnalyticsErasure.ts');
 await db.$transaction(tx=>purgeDailyAnalytics(tx,{homeId:home.id,deviceIds:[device.id]}));assert.equal(await db.nativeAnalyticsStateDay.count(),0);
 console.log('PASS: additive migrations, actual ingestion/replay/conflict, DB conservation/category guards, generation rejection and scoped erasure');
}finally{await db?.$disconnect();if(started)execFileSync('docker',['rm','-f','-v',name],{stdio:'ignore'});}
