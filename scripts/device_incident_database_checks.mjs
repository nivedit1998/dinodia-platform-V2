// Disposable PostgreSQL check of the real ingestion function and maintained
// migrations. This is not an HTTP authentication/notification delivery test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync,spawnSync} from 'node:child_process';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {PrismaClient} from '../src/generated/prisma/index.js';
const require=createRequire(import.meta.url),ts=require('typescript');
const name=`dinodia-incident-check-${process.pid}`,password=randomBytes(24).toString('hex');
let started=false,prisma;
const docker=(args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
try{
  docker(['run','-d','--name',name,'-e',`POSTGRES_PASSWORD=${password}`,'-e','POSTGRES_DB=incident_checks',
    '-p','127.0.0.1::5432','postgres:16-alpine']);started=true;
  const address=docker(['port',name,'5432/tcp']);assert.match(address,/^127\.0\.0\.1:\d+$/);
  const url=`postgresql://postgres:${password}@${address}/incident_checks`;
  assert.equal(new URL(url).hostname,'127.0.0.1');
  let ready=false;
  for(let i=0;i<100;i++){
    const check=spawnSync('docker',['exec',name,'pg_isready','-U','postgres'],{stdio:'ignore'});
    if(check.status===0){ready=true;break;}await new Promise(r=>setTimeout(r,100));
  }
  assert.ok(ready,'disposable PostgreSQL ready');
  const migrated=spawnSync(process.execPath,[require.resolve('prisma/build/index.js'),'migrate','deploy'],{
    env:{...process.env,DATABASE_URL:url,DIRECT_URL:url,V2_ENVIRONMENT:'test'},encoding:'utf8'});
  assert.equal(migrated.status,0,'all maintained migrations apply to disposable database');
  prisma=new PrismaClient({datasourceUrl:url});
  const cache=new Map();
  function load(name){
    const file=path.resolve('src/lib',`${name}.ts`);if(cache.has(file))return cache.get(file);
    const m={exports:{}};cache.set(file,m.exports);
    const text=name==='hubSyncIngestion'&&process.env.INCIDENT_SOURCE_BASE
      ?execFileSync('git',['show',`${process.env.INCIDENT_SOURCE_BASE}:src/lib/hubSyncIngestion.ts`],{encoding:'utf8'}):fs.readFileSync(file,'utf8');
    const js=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    new Function('require','module','exports',js)(id=>id==='./prisma'||id==='@/lib/prisma'?{prisma}
      :id==='./stage1Auth'?{Stage1AuthError:class extends Error{constructor(status,code,message){super(message);this.status=status;this.code=code;}}}
      :id.startsWith('@/lib/')?load(id.slice(6)):id.startsWith('.')?load(path.relative(path.resolve('src/lib'),path.resolve(path.dirname(file),id))):require(id),m,m.exports);
    cache.set(file,m.exports);return m.exports;
  }
  const apply=load('hubSyncIngestion').applyHubSyncEvent;
  async function fixture(suffix){
    const home=await prisma.home.create({data:{}});
    const identity=await prisma.hubManufacturingIdentity.create({data:{serialNumber:`DIN-INCIDENT-${suffix}`,signingPublicKey:'disposable-test',encryptionPublicKey:'disposable-test',
      signingKeyFingerprint:createHash('sha256').update(randomUUID()).digest('hex'),encryptionKeyFingerprint:createHash('sha256').update(randomUUID()).digest('hex')}});
    const hub=await prisma.hubInstallation.create({data:{homeId:home.id,manufacturingIdentityId:identity.id,serialNumberSnapshot:identity.serialNumber}});
    const device=await prisma.nativeDevice.create({data:{homeId:home.id,hubInstallationId:hub.id,osDeviceId:`fixture-${suffix}`,originalName:'Disposable fixture',technicalLabel:'zigbee',deviceType:'light',managementClass:'PROPERTY_DEVICE'}});
    return{home,hub,device};
  }
  const a=await fixture('A'),b=await fixture('B'),key=createHash('sha256').update(randomUUID()).digest('hex');
  const now=new Date(),first=new Date(now.getTime()-60000);
  const event=(f,revision=1,state='open',osDeviceId=f.device.osDeviceId,kind='device_offline',incidentKey=key)=>({
    id:randomUUID(),sequence:revision,type:'incident.transition',critical:true,aggregateId:incidentKey,occurredAt:now.toISOString(),
    payload:{incidentKey,revision,kind,state,severity:'critical',occurredAt:now.toISOString(),firstObservedAt:first.toISOString(),lastObservedAt:now.toISOString(),resolvedAt:state==='resolved'?now.toISOString():null,osDeviceId}});
  const ingest=(f,e)=>prisma.$transaction(tx=>apply(tx,{homeId:f.home.id,hubInstallationId:f.hub.id,identityGeneration:1,now,event:e}),{isolationLevel:'Serializable'});
  const open=event(a);await ingest(a,open);await ingest(a,open);
  let rows=await prisma.nativeDeviceOutageIncident.findMany({where:{homeId:a.home.id}});
  assert.equal(rows.length,1);assert.equal(rows[0].deviceId,a.device.id);assert.equal(rows[0].hubInstallationId,null);
  assert.equal(rows[0].alertEligibleAt.getTime()-rows[0].offlineObservedAt.getTime(),3600000);
  await ingest(a,event(a,2,'resolved'));await ingest(a,event(a,1));
  rows=await prisma.nativeDeviceOutageIncident.findMany({where:{homeId:a.home.id}});
  assert.equal(rows.length,1);assert.equal(rows[0].state,'RESOLVED');assert.equal(rows[0].sourceRevision,2);
  console.log('PASS device outage create/replay/resolve/older revision with real XOR and deadline constraints');
  await ingest(b,event(b));assert.equal(await prisma.nativeDeviceOutageIncident.count({where:{sourceIncidentKey:key}}),2);
  await assert.rejects(ingest(a,event(a,3,'open',b.device.osDeviceId)),{code:'hub_sync_incident_device_invalid'});
  console.log('PASS enrolled Home isolation, same opaque key in different Homes, foreign device rejection');
  const hubKey=createHash('sha256').update(randomUUID()).digest('hex');
  await ingest(a,event(a,1,'open',null,'integration_offline',hubKey));
  const hubRow=await prisma.nativeDeviceOutageIncident.findFirstOrThrow({where:{homeId:a.home.id,sourceIncidentKey:hubKey}});
  assert.equal(hubRow.deviceId,null);assert.equal(hubRow.hubInstallationId,a.hub.id);
  assert.equal(hubRow.alertEligibleAt.getTime()-hubRow.offlineObservedAt.getTime(),420000);
  await assert.rejects(ingest(a,event(a,2,'open',a.device.osDeviceId,'integration_offline',hubKey)),{code:'hub_sync_incident_source_conflict'});
  console.log('PASS integration outage source/deadline and stable-key source rebinding rejection');
  const constraints=await prisma.$queryRawUnsafe(`SELECT conname FROM pg_constraint WHERE conrelid='"NativeDeviceOutageIncident"'::regclass AND conname='NativeOutage_exactly_one_source_check'`);
  assert.equal(constraints.length,1);
  console.log('INCIDENT_DATABASE_CHECKS_PASSED unchanged production migrations; no HTTP/physical-device test claimed');
}finally{
  await prisma?.$disconnect();
  if(started)docker(['rm','-f',name]);
}
