import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
function load(file, stubs = {}) {
  const module = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(`src/lib/${file}.ts`, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  new Function('require','module','exports',js)(id => stubs[id] ?? (id.startsWith('.') ? load(`${file.includes('/') ? file.slice(0,file.lastIndexOf('/')+1) : ''}${id.slice(2)}`,stubs) : require(id)),module,module.exports);
  return module.exports;
}
class AuthError extends Error { constructor(status,code,message=code) { super(message); this.status=status; this.code=code; } }
const stubs = { '../stage1Auth': { Stage1AuthError: AuthError }, './stage1Auth': { Stage1AuthError: AuthError } };
stubs['./prisma']={prisma:{}};
test('plaque requests require exact room identity, explicit address and unique items', () => {
  const { validatePlaqueOrder }=load('contracts/roomQrPlaques', stubs);
  const item={areaId:'a8218a24-8394-4d5b-8f23-06d205887abb',kind:'FIRST_ISSUE'};
  assert.deepEqual(validatePlaqueOrder({contractVersion:1,items:[item],notes:'  test  ',confirmRegisteredAddress:true}).notes,'test');
  for(const value of [{contractVersion:1,items:[item,item],notes:'',confirmRegisteredAddress:true}, {contractVersion:1,items:[{...item,kind:'REPRINT'}],notes:'',confirmRegisteredAddress:true}, {contractVersion:1,items:[item],notes:'',confirmRegisteredAddress:false}, {contractVersion:1,items:[item],notes:'',confirmRegisteredAddress:true,status:'COMPLETED'}]) assert.throws(()=>validatePlaqueOrder(value));
});
test('only permitted physical fulfilment transitions are accepted',()=>{
  const {nextPlaqueStatus}=load('contracts/roomQrPlaques',stubs);
  assert.equal(nextPlaqueStatus('REQUESTED','START_PRODUCTION'),'IN_PRODUCTION');
  assert.equal(nextPlaqueStatus('IN_PRODUCTION','DISPATCH'),'DISPATCHED');
  assert.equal(nextPlaqueStatus('DISPATCHED','COMPLETE'),'COMPLETED');
  assert.throws(()=>nextPlaqueStatus('REQUESTED','COMPLETE'));
  assert.throws(()=>nextPlaqueStatus('DISPATCHED','CANCEL'));
});

test('only staff may resolve production or dispatched holds by explicit cancellation',()=>{
  const {nextPlaqueStatus,validateStaffCancellationReason}=load('contracts/roomQrPlaques',stubs);
  for(const status of ['IN_PRODUCTION','DISPATCHED']) {
    assert.equal(nextPlaqueStatus(status,'CANCEL','employee'),'CANCELLED');
    assert.throws(()=>nextPlaqueStatus(status,'CANCEL','customer'));
  }
  assert.throws(()=>nextPlaqueStatus('COMPLETED','CANCEL','employee'));
  assert.equal(validateStaffCancellationReason('  Address corrected  '),'Address corrected');
  for(const reason of [undefined,'',' '.repeat(5),'x'.repeat(501),'bad\u0000reason','Wrong plaque dno_room_'+ 'a'.repeat(43),'DNO_ROOM_'+ 'b'.repeat(43)]) assert.throws(()=>validateStaffCancellationReason(reason));
});

test('Platform-only plaque API contract stays separate from the shared Hub V1 bundle',()=>{
  const yaml=require('js-yaml');
  const spec=yaml.load(fs.readFileSync('contracts/platform-v2-room-qr-plaques.openapi.yaml','utf8'));
  const operations=Object.entries(spec.paths).flatMap(([route,methods])=>Object.entries(methods).map(([method,operation])=>({route,method,operation})));
  assert.equal(operations.length,9);
  assert.equal(new Set(operations.map(row=>row.operation.operationId)).size,operations.length);
  for(const {route,operation} of operations){
    assert.ok(route.startsWith('/api/'));
    assert.ok(operation.operationId);
    assert.ok(operation.responses&&Object.keys(operation.responses).length>=2);
  }
  assert.ok(!fs.readFileSync('contracts/dinodia-v1/openapi.yaml','utf8').includes('/api/v2/homes/{homeId}/room-qrs'));
});

test('initial issuance encrypts a retrievable context-bound reference and never reissues on reuse',async()=>{
  process.env.PLATFORM_DATA_ENCRYPTION_KEY=Buffer.alloc(32,7).toString('base64');
  const {issueFirstRoomQr,readRoomQrPayload}=load('roomQrCredentials',stubs);
  const rows=[];const tx={areaQrCredential:{findMany:async()=>rows,create:async({data})=>{const row={...data,status:'ACTIVE'};rows.push(row);return row;}}};
  const row=await issueFirstRoomQr(tx,'home','area'),reference=readRoomQrPayload(row,'home');
  assert.match(reference,/^dno_room_[A-Za-z0-9_-]{43}$/);assert.ok(!JSON.stringify(row).includes(reference));
  assert.equal((await issueFirstRoomQr(tx,'home','area')).id,row.id);assert.equal(rows.length,1);
  for(const altered of [{...row,areaId:'other'},{...row,id:'other'},{...row,generation:2},{...row,status:'REPLACED'},{...row,resolverHash:'bad'},{...row,encryptedPrintablePayload:null}])assert.throws(()=>readRoomQrPayload(altered,'home'));
  assert.throws(()=>readRoomQrPayload(row,'another-home'));
  const {encryptPlatformEnvelope,decryptPlatformEnvelope}=load('hubOperatorCredentials',stubs);
  const original=JSON.parse(decryptPlatformEnvelope(JSON.stringify(row.encryptedPrintablePayload)));
  for(const change of [{purpose:'home-claim'},{areaId:'other-area'},{homeId:'other-home'},{credentialId:'other-credential'},{generation:2},{reference:'dno_room_'+ 'z'.repeat(43)}]) {
    const altered={...row,encryptedPrintablePayload:encryptPlatformEnvelope(JSON.stringify({...original,...change}))};
    assert.throws(()=>readRoomQrPayload(altered,'home'),'a valid encrypted envelope cannot cross its resolver/context binding');
  }
  assert.throws(()=>readRoomQrPayload({...row,encryptedPrintablePayload:{invalid:'corrupted'}},'home'));
  const hashOnly={...row,encryptedPrintablePayload:null};rows.splice(0,1,hashOnly);
  await assert.rejects(issueFirstRoomQr(tx,'home','area'));assert.equal(rows.length,1);
  delete process.env.PLATFORM_DATA_ENCRYPTION_KEY;assert.throws(()=>readRoomQrPayload(row,'home'),/Secure Platform/);
});

test('company HTTP errors expose a bounded service-unavailable response for missing encryption configuration',async()=>{
  const cryptoConfig=load('platformDataEncryptionKey',stubs);
  const respond=error=>new Response(JSON.stringify({errorCode:error.code,message:error.message}),{status:error.status});
  const {roomPlaqueHttp}=load('roomPlaqueHttp',{
    ...stubs,
    './stage1Auth':{Stage1AuthError:AuthError,requireEmployee:async()=>{throw new cryptoConfig.PlatformDataEncryptionKeyError('PLATFORM_ENCRYPTION_KEY_MISSING');},authErrorResponse:respond},
    './platformDataEncryptionKey':cryptoConfig,
    './customerSelectedHome':{},'./roomPlaqueRequests':{},'./rateLimit':{},
    './contracts/nativeV1Error':{nativeV1ErrorResponse:respond}
  });
  const result=await roomPlaqueHttp(new Request('https://example.test/api/company/room-plaque-requests'),{},'staff-orders');
  assert.equal(result.status,503);
  const body=await result.text();assert.ok(body.includes('temporarily unavailable'));assert.ok(!body.includes('PLATFORM_ENCRYPTION_KEY'));
});
