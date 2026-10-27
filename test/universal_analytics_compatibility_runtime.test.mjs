import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';import path from 'node:path';
const require=createRequire(import.meta.url),ts=require('typescript');
class AuthError extends Error {constructor(status,code,message){super(message);Object.assign(this,{status,code});}}
function load(file){const module={exports:{}};const source=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('require','module','exports',source)(name=>name==='./stage1Auth'?{Stage1AuthError:AuthError}:name.startsWith('.')?load(path.resolve(path.dirname(file),name+'.ts')):require(name),module,module.exports);return module.exports;}
const api=load('src/lib/universalAnalyticsCompatibility.ts');
const now=new Date('2026-10-27T12:00:00.000Z');
function fixture(){let proof=null;const current={homeId:'home',state:'ACTIVE',manufacturingIdentityId:'identity',cloudConfigurationRevision:8,acknowledgedCloudRevision:8,analyticsWriterEnabled:true};
 const tx={$queryRaw:async sql=>sql.join('').includes('FROM "HubInstallation"')?[{...current,analyticsContractAck:proof}]:[],
  $executeRaw:async(_sql,value)=>{proof=JSON.parse(value);return 1;},home:{findFirst:async()=>({id:'home'})},hubManufacturingIdentity:{findFirst:async()=>({id:'identity'})}};
 const input={homeId:'home',hubInstallationId:'hub',identity:{id:'identity',identityGeneration:2},requestNonce:'fresh-nonce',now,
 declaration:{contractVersion:1,analyticsPolicyVersion:4,appliedCloudRevision:8,requestNonce:'fresh-nonce',runtimeSessionId:'11111111-1111-4111-8111-111111111111'}};
 return {tx,current,input,proof:()=>proof};}
test('fresh nonce-bound running-process declaration opens the exact revision gate',async()=>{
 const prior=process.env.DINODIA_UNIVERSAL_ANALYTICS_ENABLED;process.env.DINODIA_UNIVERSAL_ANALYTICS_ENABLED='true';
 try{const f=fixture();await api.recordUniversalAnalyticsCompatibility(f.tx,f.input);
 assert.equal(f.proof().appliedCloudRevision,8);await api.requireUniversalAnalyticsCompatibility(f.tx,f.input);
 f.current.cloudConfigurationRevision=9;await assert.rejects(api.requireUniversalAnalyticsCompatibility(f.tx,f.input),e=>e.code==='analytics_contract_unavailable');
 }finally{if(prior===undefined)delete process.env.DINODIA_UNIVERSAL_ANALYTICS_ENABLED;else process.env.DINODIA_UNIVERSAL_ANALYTICS_ENABLED=prior;}
});
test('old software, stale configuration, replayed nonce and malformed session clear the saved proof',async()=>{
 for(const change of [null,{requestNonce:'old-nonce'},{appliedCloudRevision:7},{runtimeSessionId:'------------------------------------'},{contractVersion:2}]){
  const f=fixture();await api.recordUniversalAnalyticsCompatibility(f.tx,f.input);assert.ok(f.proof());
  await api.recordUniversalAnalyticsCompatibility(f.tx,{...f.input,declaration:change===null?null:{...f.input.declaration,...change}});
  assert.equal(f.proof(),null);
 }
});
