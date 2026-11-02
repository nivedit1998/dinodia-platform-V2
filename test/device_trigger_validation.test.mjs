import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';import {execFileSync} from 'node:child_process';
const require=createRequire(import.meta.url),ts=require('typescript');const cache=new Map();
function load(file){file=path.resolve(file);if(cache.has(file))return cache.get(file).exports;const m={exports:{}};cache.set(file,m);
 const source=process.env.AUTOMATION_BASELINE==='1'&&file.endsWith('/validation.ts')?execFileSync('git',['show','48c871e:src/lib/nativeAutomations/validation.ts'],{encoding:'utf8'}):fs.readFileSync(file,'utf8');
 new Function('require','module','exports',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>id.startsWith('.')?load(path.resolve(path.dirname(file),id+'.ts')):require(id),m,m.exports);return m.exports;}
const api=load('src/lib/nativeAutomations/validation.ts'),refs=load('src/lib/nativeAutomations/triggerReferences.ts');
const ids={home:'00000000-0000-4000-8000-000000000001',tenant:'00000000-0000-4000-8000-000000000002',area:'00000000-0000-4000-8000-000000000003',source:'00000000-0000-4000-8000-000000000004',target:'00000000-0000-4000-8000-000000000005'};
const control={controlId:'temperature',valueType:'number',readable:true,observable:true,writable:false,automatable:false,semanticRole:'ambient_temperature',riskLevel:'normal',stepUpPolicy:'none',catalogRevision:1,constraints:{minimum:0,maximum:40,step:1}};
const actionControl={...control,controlId:'power',valueType:'boolean',writable:true,automatable:true,idempotency:'set_value',semanticRole:'power',constraints:{}};
function fixture({capable=true,sourcePatch={},sourceMissing=false}={}){return{
 home:{findUnique:async()=>({activeHubInstallationId:'hub'})},
 hubInstallation:{findFirst:async()=>({capabilitySummary:{nativeDeviceTriggersV2:capable}})},
 nativeDevice:{findFirst:async({where})=>{
  assert.equal(where.homeId,ids.home);assert.equal(where.lifecycle,'INSTALLED');assert.equal(where.assignments.some.areaId,ids.area);
  assert.equal(where.OR[1].ownerMembershipId,ids.tenant);
  if(sourceMissing&&where.id===ids.source)return null;
  return{id:where.id,osDeviceId:where.id===ids.source?'unknown-brand-sensor':'light',managementClass:'PROPERTY_DEVICE',ownerMembershipId:null,descriptorRevision:1,capabilitySummary:{controlCatalog:{revision:1,controls:[where.id===ids.source?{...control,...sourcePatch}:actionControl]}},assignments:[{area:{osAreaId:'room'}}]};
 }},nativeAutomation:{findMany:async()=>[]}};}
function definition(patch={}){return{name:'Keep comfortable',trigger:{kind:'device_state',deviceId:ids.source,areaId:ids.area,controlId:'temperature',operator:'falls_below',value:{type:'number',number:18.25},conditions:{mode:'all',items:[]}},actions:[{deviceId:ids.target,areaId:ids.area,controlId:'power',targetValue:{type:'boolean',boolean:true}}],...patch};}
function validate(raw=definition(),db=fixture(),version=2){return api.validateNativeAutomationDefinition(db,{homeId:ids.home,membershipId:ids.tenant,grantedAreaIds:[ids.area],contractVersion:version,raw});}
test('actual validator supports a read-only unknown-brand sensor and resolves exact authorized bindings',async()=>{
 const d=await validate();assert.equal(d.triggerKind,'DEVICE_STATE');assert.equal(d.triggerConfiguration.source.osDeviceId,'unknown-brand-sensor');assert.equal(d.actions.length,1);
 assert.equal(d.triggerConfiguration.cooldownSeconds,30);assert.equal(refs.automationSources(d.triggerConfiguration).length,1);
 assert.equal(d.triggerConfiguration.value.number,18.25,'sensor threshold ignores actuator step grid');
});
test('custom trigger cannot be sent by an old client or to an old hub',async()=>{
 await assert.rejects(validate(definition(),fixture(),1),{code:'AUTOMATION_UPGRADE_REQUIRED'});
 await assert.rejects(validate(definition(),fixture({capable:false})),{code:'AUTOMATION_HUB_UPDATE_REQUIRED'});
});
test('unknown source, nonobservable or sensitive readings and foreign Areas fail closed',async()=>{
 await assert.rejects(validate(definition(),fixture({sourceMissing:true})),{code:'AUTOMATION_SOURCE_UNAVAILABLE'});
 await assert.rejects(validate(definition(),fixture({sourcePatch:{observable:false}})),{code:'AUTOMATION_SOURCE_UNAVAILABLE'});
 await assert.rejects(validate(definition(),fixture({sourcePatch:{riskLevel:'sensitive'}})),{code:'AUTOMATION_SOURCE_UNAVAILABLE'});
 const raw=definition();raw.trigger.areaId=ids.target;await assert.rejects(validate(raw),{code:'AUTOMATION_SCOPE_DENIED'});
});
test('conditions bind their own sources and unknown extra fields are rejected',async()=>{
 const raw=definition();raw.trigger.conditions={mode:'any',items:[{kind:'device_state',deviceId:ids.source,areaId:ids.area,controlId:'temperature',operator:'below',value:{type:'number',number:20}},{kind:'time_window',startMinute:1320,endMinute:120,weekdays:[1,2]}]};
 const d=await validate(raw);assert.equal(refs.automationSources(d.triggerConfiguration).length,2);
 const wire=refs.sourceConfigurationForClient(d.triggerConfiguration);assert.equal(wire.deviceId,ids.source);assert.equal(wire.osDeviceId,undefined);
 raw.trigger.conditions.items[0].authority='OWNER';await assert.rejects(validate(raw),{code:'AUTOMATION_CONDITIONS_INVALID'});
});
test('V1 schedules remain compatible and reject unknown trigger keys',async()=>{
 const d=await validate(definition({trigger:{minuteOfDay:420,weekdays:[1,2,3]}}),fixture(),1);assert.equal(d.minuteOfDay,420);
 await assert.rejects(validate(definition({trigger:{minuteOfDay:420,weekdays:[1],extra:true}})),{code:'AUTOMATION_TRIGGER_INVALID'});
});
test('explicit contract negotiation rejects unsupported versions',()=>{
 assert.equal(refs.automationContractVersion(new Request('https://synthetic.invalid')),1);
 assert.equal(refs.automationContractVersion(new Request('https://synthetic.invalid',{headers:{'x-dinodia-automations':'2'}})),2);
 assert.throws(()=>refs.automationContractVersion(new Request('https://synthetic.invalid',{headers:{'x-dinodia-automations':'99'}})),{code:'AUTOMATION_CONTRACT_UNSUPPORTED'});
});
