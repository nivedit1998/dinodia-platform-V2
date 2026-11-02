import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript');
function load(file,db,cache=new Map()) {file=path.resolve(file);if(cache.has(file))return cache.get(file).exports;const m={exports:{}};cache.set(file,m);new Function('require','module','exports',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>id==='@/lib/prisma'?{prisma:db}:id.startsWith('.')?load(path.resolve(path.dirname(file),id+'.ts'),db,cache):require(id),m,m.exports);return m.exports;}
const source={deviceId:'private-sensor',areaId:'private-room',controlId:'temperature',managementClass:'TENANT_DEVICE',ownerMembershipId:'tenant'};
const trigger={id:'trigger',kind:'DEVICE_STATE',configuration:{kind:'device_state',source,conditions:{mode:'all',items:[]}},revision:1};
test('property oversight redacts a private source even when every action is a property device',async()=>{
 const date=new Date('2026-11-02T10:00:00Z');
 const row={id:'rule',name:'Secret bedtime device',status:'ACTIVE',revision:1,timezone:'UTC',createdAt:date,updatedAt:date,propertyImpact:true,createdBy:{customerAccount:{displayName:'Tenant'}},triggers:[trigger],executions:[],actions:[{id:'action',deviceId:'property',areaId:'room',controlId:'power',sortOrder:0,descriptorRevision:1,needsAttention:false,device:{managementClass:'PROPERTY_DEVICE',overrideName:'Hall light'},area:{originalName:'Hall'}}]};
 const db={homeMembership:{findFirst:async()=>({id:'owner'})},home:{findUnique:async()=>({activeHubInstallationId:'hub'})},hubInstallation:{findFirst:async()=>({cloudConfigurationRevision:1,acknowledgedCloudRevision:1})},nativeAutomation:{findMany:async()=>[row]}};
 const api=load('src/lib/nativeAutomations/summaries.ts',db);
 const result=await api.listPropertyAutomationSummaries({homeId:'home',membershipId:'owner',accountId:'account',role:'OWNER'});
 assert.equal(result.automations[0].name,'Tenant automation');assert.equal(result.automations[0].trigger,null);
 assert(!JSON.stringify(result).includes('private-sensor'));assert(!JSON.stringify(result).includes('Secret bedtime'));
});
test('read-source-only device changes suspend and read-source-only Area withdrawal purges executable bodies',async()=>{
 const row={id:'rule',name:'rule',status:'ACTIVE',revision:1,timezone:'UTC',propertyImpact:true,actions:[{deviceId:'target',areaId:'other-room',controlId:'power'}],triggers:[trigger]};const calls=[];
 const db={nativeAutomation:{findMany:async()=>[row],updateMany:async input=>{calls.push(input);return {count:1};}},nativeAutomationTrigger:{deleteMany:async()=>calls.push('trigger-purged')},nativeAutomationAction:{updateMany:async()=>calls.push('actions-suspended'),deleteMany:async()=>calls.push('actions-purged')},home:{updateMany:async()=>({count:1})},auditEvent:{create:async()=>calls.push('audit')}};
 const revalidation=load('src/lib/nativeAutomations/revalidation.ts',db);
 assert.equal(await revalidation.suspendAutomationsForDeviceChange(db,{homeId:'home',deviceId:'private-sensor',controlIds:['temperature'],reason:'device_removed',now:new Date()}),1);
 assert(calls.includes('actions-suspended'));
 const lifecycle=load('src/lib/nativeAutomations/lifecycle.ts',db);
 const result=await lifecycle.retireNativeAutomations(db,{homeId:'home',losingAreaIds:['private-room'],reason:'area_deleted',actorId:null});assert.equal(result.retiredCount,1);
 assert(calls.includes('trigger-purged'));assert(calls.includes('actions-purged'));assert(calls.includes('audit'));
});
