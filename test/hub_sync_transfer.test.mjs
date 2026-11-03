import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
function routeFixture({ legacyReceipt = false, revoked = false } = {}) {
  const current = { id:'hub',homeId:'home',manufacturingIdentityId:'identity',serialNumberSnapshot:'serial',state:'ACTIVE',lifecycleStatus:'ACTIVE',syncStreamId:'stream',syncAcceptedSequence:0n,acknowledgedCloudRevision:1,cloudConfigurationRevision:1,cloudConfigurationChecksum:'hash' };
  const configuration = { revision:1,checksum:'hash',memberships:[{id:'tenant',areaIds:['area']}], padding:'x'.repeat(16000) };
  let stored = legacyReceipt ? { bodyHash:'body',response:{acceptedThroughSequence:1,streamId:'stream',configuration:{memberships:[{id:'revoked'}]},resnapshotRequired:true,nextPollAfterSeconds:30,streamReconciled:true,reconciledFromStreamId:'old',reconciledFromSequence:9} } : null;
  let applied = 0;
  const writes=[];
  const tx={hubInstallation:{findUnique:async()=>current,updateMany:async({data})=>{Object.assign(current,data);return {count:1};}},home:{findUnique:async()=>({id:'home',managementRevision:1})},hubManufacturingIdentity:{findFirst:async()=>revoked?null:{id:'identity'}},companyOperationalWorkItem:{count:async()=>0},homeMembership:{count:async()=>1},hubSyncReceipt:{findFirst:async()=>stored,create:async args=>{writes.push(args);stored={bodyHash:args.data.bodyHash,response:args.data.response};return {id:'receipt'};}},$queryRaw:async()=>stored?[{...stored,response:Object.fromEntries(Object.entries(stored.response).filter(([k])=>k!=='configuration'))}]:[]};
  class AuthError extends Error { constructor(status,code,message){super(message);this.status=status;this.code=code;} }
  const modules={
    '@/lib/prisma':{prisma:{$transaction:async fn=>fn(tx)}},
    '@/lib/stage1Auth':{Stage1AuthError:AuthError,authErrorResponse:e=>Response.json({code:e.code,message:e.message},{status:e.status||500})},
    '@/lib/stage1HubAuth':{authenticateHub:async(_r,raw)=>({installation:{id:'hub'},identity:{id:'identity',serialNumber:'serial',identityGeneration:1},body:JSON.parse(raw)})},
    '@/lib/hubCloudConfiguration':{buildHubCloudConfiguration:async()=>configuration,finalizeHubCloudConfiguration:(c,r)=>({...c,revision:r})},
    '@/lib/hubSyncIngestion':{applyHubSyncEvent:async()=>{applied++;}},
    '@/lib/deletionReferences':{suppressedSyncEvents:async()=>new Set()},
    '@/lib/hubTenantPolicyAcknowledgement':{acknowledgeAppliedTenantPolicy:async()=>{}},
    '@/lib/hubSyncEnvelope':{validateHubSyncEnvelope:()=>true,hubSyncBodyHash:()=> 'body',HUB_SYNC_MAX_BODY_BYTES:1048576,HUB_SYNC_PROCESSING_MAX_EVENTS:200},
    '@/lib/nativeInstallationSyncMode':{resolveNativeInstallationSyncMode:()=> 'ACTIVE'},
    '@/lib/hubUsageClosureRecovery':{},
  };
  const source=fs.readFileSync('src/app/api/hub-agent/v2/sync/route.ts','utf8');
  const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const module={exports:{}};
  new Function('require','module','exports',output)(id=>modules[id]||require(id),module,module.exports);
  const request=()=>new Request('http://localhost/api/hub-agent/v2/sync',{method:'POST',body:JSON.stringify({serial:'serial',identityGeneration:1,hubInstallationId:'hub',streamId:'stream',fromSequence:1,toSequence:1,acknowledgedCloudRevision:1,queueDepth:0,runtime:{version:'test',capabilities:{}},events:[{id:'event',type:'area.upsert'}]})});
  return { send:()=>module.exports.POST(request()),writes,configuration,get applied(){return applied;},get stored(){return stored;} };
}
test('real sync route persists only retry metadata and returns full current configuration',async()=>{
  const f=routeFixture();const first=await f.send();assert.equal(first.status,200);const body=await first.json();
  assert.deepEqual(body.configuration,f.configuration);
  assert.equal(Object.hasOwn(f.stored.response,'configuration'),false);
  assert.deepEqual(f.writes[0].select,{id:true});
  assert.ok(Buffer.byteLength(JSON.stringify(f.stored.response))<500);
  const retry=await f.send();const retried=await retry.json();assert.equal(retry.status,200);assert.equal(retried.duplicate,true);assert.deepEqual(retried.configuration,f.configuration);assert.equal(f.applied,1);
});
test('legacy full receipt retry rebuilds current policy and retains reconciliation metadata',async()=>{
  const f=routeFixture({legacyReceipt:true});const result=await f.send();assert.equal(result.status,200);const body=await result.json();assert.deepEqual(body.configuration,f.configuration);assert.equal(body.streamReconciled,true);assert.equal(body.reconciledFromSequence,9);assert.equal(body.resnapshotRequired,true);assert.equal(f.applied,0);
});
test('receipt lookup cannot bypass revoked Hub identity',async()=>{
  const f=routeFixture({legacyReceipt:true,revoked:true});const result=await f.send();assert.equal(result.status,401);assert.equal(f.applied,0);assert.equal(f.writes.length,0);
});
