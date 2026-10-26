import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url), ts=require('typescript');
class AuthError extends Error {constructor(status,code,message){super(message);this.status=status;this.code=code;}}
export function loadIngestion() {
  const m={exports:{}};
  const code=ts.transpileModule(fs.readFileSync('src/lib/hubSyncIngestion.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function('require','module','exports',code)(id=>id==='./stage1Auth'?{Stage1AuthError:AuthError}
    :id==='./dailyAnalyticsIngestion'?{sealedLegacyEvent:async()=>false}:id.startsWith('.')?{}:require(id),m,m.exports);
  return m.exports.applyHubSyncEvent;
}
const apply=loadIngestion();
function harness(){
  const rows=[],queries=[];
  const tx={nativeDevice:{findUnique:async({where})=>where.hubInstallationId_osDeviceId.osDeviceId==='foreign'?{id:'other',homeId:'other-home'}:{id:'device',homeId:'home'}},
    nativeDeviceOutageIncident:{
      findUnique:async()=>null,
      findFirst:async({where})=>{queries.push(where);return rows.find(r=>r.sourceIncidentKey===where.sourceIncidentKey)||null;},
      create:async({data})=>{assert.equal(Number(data.deviceId!==null)+Number(data.hubInstallationId!==null),1,'NativeOutage_exactly_one_source_check');const row={id:`incident-${rows.length}`,...data};rows.push(row);return row;},
      updateMany:async({where,data})=>{const row=rows.find(r=>r.id===where.id);Object.assign(row,data);return{count:1};},
    }};
  return{tx,rows,queries};
}
export function incidentEvent({key='a'.repeat(64),revision=1,state='open',device='os-device',kind='device_offline'}={}){
  return{id:'33333333-3333-4333-8333-333333333333',sequence:revision,type:'incident.transition',aggregateId:key,critical:true,occurredAt:'2026-10-26T12:00:00.000Z',
    payload:{incidentKey:key,revision,kind,state,severity:'critical',occurredAt:'2026-10-26T12:00:00.000Z',firstObservedAt:'2026-10-26T11:00:00.000Z',lastObservedAt:'2026-10-26T12:00:00.000Z',resolvedAt:state==='resolved'?'2026-10-26T12:00:00.000Z':null,osDeviceId:device}};
}
const input=event=>({homeId:'home',hubInstallationId:'hub',identityGeneration:1,now:new Date('2026-10-26T12:01:00.000Z'),event,suppressedEventIds:new Set()});
test('device outage open/replay/resolve uses one source and preserves device identity',async()=>{
  const h=harness();
  await apply(h.tx,input(incidentEvent()));
  await apply(h.tx,input(incidentEvent()));
  await apply(h.tx,input(incidentEvent({revision:2,state:'resolved'})));
  assert.equal(h.rows.length,1);assert.equal(h.rows[0].deviceId,'device');assert.equal(h.rows[0].hubInstallationId,null);
  assert.equal(h.rows[0].state,'RESOLVED');assert.equal(h.rows[0].sourceRevision,2);
  assert.equal(h.rows[0].alertEligibleAt.getTime()-h.rows[0].offlineObservedAt.getTime(),3600000);
  assert.equal(h.queries[0].homeId,'home');
  assert.deepEqual(h.queries[0].OR,[{hubInstallationId:'hub'},{device:{hubInstallationId:'hub'}}]);
});
test('Hub/integration outages retain hub source and seven-minute deadline',async()=>{
  const h=harness();await apply(h.tx,input(incidentEvent({device:null,kind:'integration_offline'})));
  assert.equal(h.rows[0].deviceId,null);assert.equal(h.rows[0].hubInstallationId,'hub');
  assert.equal(h.rows[0].alertEligibleAt.getTime()-h.rows[0].offlineObservedAt.getTime(),420000);
});
test('foreign Home device cannot create or rebind an outage',async()=>{
  const h=harness();await assert.rejects(apply(h.tx,input(incidentEvent({device:'foreign'}))),{code:'hub_sync_incident_device_invalid'});
  assert.equal(h.rows.length,0);
});
test('stable incident key cannot change source target or kind',async()=>{
  const h=harness();await apply(h.tx,input(incidentEvent({device:null,kind:'hub_network_unavailable'})));
  await assert.rejects(apply(h.tx,input(incidentEvent({kind:'hub_network_unavailable',revision:2}))),{code:'hub_sync_incident_source_conflict'});
  await assert.rejects(apply(h.tx,input(incidentEvent({device:null,kind:'integration_offline',revision:2}))),{code:'hub_sync_incident_kind_conflict'});
});
