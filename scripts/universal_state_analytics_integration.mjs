import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createRequire} from 'node:module';import {randomUUID} from 'node:crypto';

export async function universalStateAnalyticsIntegration({prisma,fixture:f,osRoot,base,machineRequest,fetchJson}){
 assert.equal(new URL(base).hostname,'127.0.0.1');
 const require=createRequire(path.join(osRoot,'package.json')),{Store}=require(path.join(osRoot,'src/store.js'));
 const {checkedStateFixture}=require(path.join(osRoot,'test/helpers/checked-state-fixture.js'));
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dinodia-universal-state-http-'));
 try{
  const now=Date.now(),start=Math.floor((now-7200000)/3600000)*3600000;
  const store=new Store(path.join(directory,'store.json'));store.setUsageClockTrust(()=>true);
  await store.saveArea({name:'Synthetic state room'},f.areaOneOsId);await store.savePlatform({homeId:f.homeOneId});
  const checked=await checkedStateFixture({store,directory,now:start,generation:f.identityOneGeneration,areaId:f.areaOneOsId});
  const catalog=store.getSyncOutbox().events.filter(e=>e.type==='control.catalog.upsert').at(-1).payload;
  const control=catalog.controls.find(c=>c.semanticRole==='power');assert.ok(control);
  const device=await prisma.nativeDevice.create({data:{homeId:f.homeOneId,hubInstallationId:f.hubOneId,osDeviceId:checked.deviceId,
    originalName:'Synthetic categorized TV',technicalLabel:'tv',deviceType:'switch',protocol:'zigbee',managementClass:'PROPERTY_DEVICE',
    analyticsCategory:'TV',lifecycle:'INSTALLED',capabilitySummary:{controlCatalog:catalog}}});
  await prisma.deviceAreaAssignment.create({data:{homeId:f.homeOneId,deviceId:device.id,areaId:f.areaOneId,validFrom:new Date(start),source:'OS_SYNC'}});
  const interval=await prisma.nativeAnalyticsInterval.create({data:{homeId:f.homeOneId,hubInstallationId:f.hubOneId,deviceId:device.id,
    analyticsCategory:'TV',selectedControlId:control.controlId,authorizedControls:catalog.controls,sourceGeneration:f.identityOneGeneration,
    revision:1,analyticsPolicyVersion:4,validFrom:new Date(start)}});
  await prisma.hubInstallation.update({where:{id:f.hubOneId},data:{analyticsWriterEnabled:true}});
  await prisma.nativeAnalyticsDay.deleteMany({where:{homeId:f.homeOneId}});
  await prisma.nativeAnalyticsRetention.deleteMany({where:{homeId:f.homeOneId}});
  await prisma.nativeAnalyticsRetention.create({data:{homeId:f.homeOneId,hubInstallationId:f.hubOneId,timezone:'Europe/London',writerFrom:new Date(start),writerEnabled:true}});
  store.state.platform.cloudConfiguration={analyticsHistory:{version:1,enabled:true,timezone:'Europe/London',writerFrom:new Date(start).toISOString()}};
  Object.assign(store.state.platform.devicePolicies[checked.deviceId],{analyticsCategory:'TV',osAreaIds:[f.areaOneOsId],analyticsAssignmentStartedAt:new Date(start).toISOString(),
    analyticsInterval:{id:interval.id,revision:1,validFrom:new Date(start).toISOString(),sourceGeneration:f.identityOneGeneration,
      analyticsPolicyVersion:4,writerEnabled:true,genericCollectionEnabled:false,authorizedControlIds:[control.controlId],selectedControlId:control.controlId}});
  await store.advanceSyncUsage(start);await checked.report('OFF',{advance:1000});await store.advanceSyncUsage(start+61000);
  const events=store.getSyncOutbox().events.filter(e=>['analytics.daily.barrier','analytics.state.day'].includes(e.type));assert.equal(events.length,2);
  const cursor=await prisma.hubInstallation.findUniqueOrThrow({where:{id:f.hubOneId}}),first=Number(cursor.syncAcceptedSequence)+1;
  const envelope={schemaVersion:1,hubInstallationId:f.hubOneId,streamId:cursor.syncStreamId||randomUUID(),fromSequence:first,toSequence:first+events.length-1,
    events:events.map((e,i)=>({...e,sequence:first+i})),queueDepth:events.length,acknowledgedCloudRevision:cursor.acknowledgedCloudRevision,
    runtime:{kind:'dinodia_os',version:'synthetic-universal-state',capabilities:{nativeDailyAnalyticsV1:true,nativeUniversalAnalyticsV2:true,nativeUniversalStateAnalyticsV1:true}},sentAt:new Date().toISOString()};
  const send=()=>machineRequest({base,path:'/api/hub-agent/v2/sync',machineSecret:f.machineSecret,body:{serial:f.identityOneSerial,identityGeneration:f.identityOneGeneration,...envelope}});
  const uploaded=await send();assert.equal(uploaded.response.status,200,JSON.stringify(uploaded.body));assert.equal((await send()).response.status,200);
  const saved=await prisma.nativeAnalyticsStateDay.findMany({where:{deviceId:device.id}});assert.equal(saved.length,1);assert.equal(saved[0].durationsSeconds.off,60);
  const current=await prisma.hubInstallation.findUniqueOrThrow({where:{id:f.hubOneId}});
  const ack=await machineRequest({base,path:'/api/hub-agent/v2/sync',machineSecret:f.machineSecret,body:{serial:f.identityOneSerial,identityGeneration:f.identityOneGeneration,
    ...envelope,fromSequence:Number(current.syncAcceptedSequence)+1,toSequence:Number(current.syncAcceptedSequence),events:[],queueDepth:0,
    acknowledgedCloudRevision:current.cloudConfigurationRevision,sentAt:new Date().toISOString()}});
  assert.equal(ack.response.status,200,JSON.stringify(ack.body));
  const authority=await prisma.hubInstallation.findUniqueOrThrow({where:{id:f.hubOneId}}),nonce=`synthetic-${randomUUID()}`;
  assert.equal(authority.cloudConfigurationRevision,authority.acknowledgedCloudRevision);
  const declaration={contractVersion:1,analyticsPolicyVersion:4,appliedCloudRevision:authority.cloudConfigurationRevision,runtimeSessionId:randomUUID(),requestNonce:nonce};
  const declare=await machineRequest({base,path:'/api/hub-agent/token-state',machineSecret:f.machineSecret,nonce,
    body:{serial:f.identityOneSerial,identityGeneration:f.identityOneGeneration,analyticsContract:declaration}});
  assert.equal(declare.response.status,200,JSON.stringify(declare.body));
  assert.equal((await prisma.hubInstallation.findUniqueOrThrow({where:{id:f.hubOneId}})).analyticsContractAck.analyticsContractVersion,1);
  const oldSoftware=await machineRequest({base,path:'/api/hub-agent/token-state',machineSecret:f.machineSecret,
    body:{serial:f.identityOneSerial,identityGeneration:f.identityOneGeneration}});
  assert.equal(oldSoftware.response.status,200);
  assert.equal((await prisma.hubInstallation.findUniqueOrThrow({where:{id:f.hubOneId}})).analyticsContractAck,null,'older running software invalidates the proof outside the frozen outbox');
  const owner=await fetchJson(`${base}/api/v2/mobile/session`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
    email:f.propertyEmail,password:f.propertyPassword,deviceInstallationId:f.propertyInstallationId,publicKey:f.propertyPublicKey,deviceName:'Synthetic state owner'})});
  assert.equal(owner.response.status,200);assert.ok(owner.body.accessToken);
  const query=new URLSearchParams({category:'tv',level:'hour',from:new Date(start).toISOString(),to:new Date(start+61000).toISOString(),deviceIds:device.id});
  const endpoint=`${base}/api/v2/homes/${f.homeOneId}/analytics/states?${query}`;
  const headers={authorization:`Bearer ${owner.body.accessToken}`,'x-dinodia-home-id':f.homeOneId};
  const history=await fetchJson(endpoint,{headers});assert.equal(history.response.status,200,JSON.stringify(history.body));
  assert.equal(history.body.buckets[0].durationsSeconds.off,60);assert.equal(history.body.buckets[0].durationsSeconds.on,1);
  assert.notEqual((await fetchJson(endpoint)).response.status,200,'unauthenticated callers cannot read state history');
  const tenant=await fetchJson(`${base}/api/v2/mobile/session`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
    email:f.loginEmail,password:f.loginPassword,deviceInstallationId:f.loginInstallationId,publicKey:f.loginPublicKey,deviceName:'Synthetic tenant'})});
  assert.equal(tenant.response.status,200);
  assert.notEqual((await fetchJson(endpoint,{headers:{authorization:`Bearer ${tenant.body.accessToken}`,'x-dinodia-home-id':f.homeOneId}})).response.status,200,'tenant role cannot read property analytics');
  console.log('[universal-state:integration] PASS: real checked Zigbee -> Store/outbox -> signed HTTP sync/barrier/retry -> Postgres -> owner HTTP history; tenant/anonymous denied; no physical radio');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
}
