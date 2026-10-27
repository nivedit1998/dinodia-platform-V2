import assert from 'node:assert/strict';

export async function exerciseStateHistoryMatrix({db,home,hub,area,device,interval,p,input,load,multiStateDailyAggregateId}) {
 const at=n=>new Date(Date.parse(p.coverageStartAt)+n*60000),stamp=n=>at(n).toISOString();
 const ingest=load('src/lib/multiStateAnalyticsIngestion.ts').ingestMultiStateAnalytics;
 const send=payload=>({...input,event:{...input.event,aggregateId:multiStateDailyAggregateId(payload),payload}});
 const area2=await db.area.create({data:{homeId:home.id,osAreaId:'b',originalName:'Synthetic second'}});
 await db.nativeAnalyticsInterval.update({where:{id:interval.id},data:{validUntil:at(1)}});
 await db.deviceAreaAssignment.updateMany({where:{deviceId:device.id},data:{validUntil:at(1)}});
 const controls=id=>[{controlId:id,surfaceId:'1',semanticRole:'power',observable:true,writable:true}];
 const makeInterval=(category,control,revision,from)=>db.nativeAnalyticsInterval.create({data:{homeId:home.id,hubInstallationId:hub.id,deviceId:device.id,
  analyticsCategory:category,selectedControlId:control,authorizedControls:controls(control),sourceGeneration:1,revision,analyticsPolicyVersion:4,validFrom:at(from)}});
 await db.nativeDevice.update({where:{id:device.id},data:{analyticsCategory:'SOCKET'}});
 const second=await makeInterval('SOCKET','power2',2,1);
 await db.deviceAreaAssignment.create({data:{homeId:home.id,deviceId:device.id,areaId:area2.id,validFrom:at(1),source:'OS_SYNC'}});
 const payload=(category,control,epoch,room,from,to)=>({...p,analyticsCategory:category,controlId:control,bindingRevision:epoch.revision,analyticsIntervalId:epoch.id,
  osAreaId:room,assignmentEpochAt:stamp(from),coverageStartAt:stamp(from),coverageEndAt:stamp(to),
  durationsSeconds:{on:60,off:0,unknown:0},hourly:[{hourStartAt:p.dayStartAt,coverageStartAt:stamp(from),coverageEndAt:stamp(to),durationsSeconds:{on:60,off:0,unknown:0}}]});
 const p2=payload('SOCKET','power2',second,'b',1,2);await db.$transaction(tx=>ingest(tx,send(p2)));
 await db.nativeAnalyticsInterval.update({where:{id:second.id},data:{validUntil:at(2)}});
 await db.deviceAreaAssignment.updateMany({where:{deviceId:device.id,validUntil:null},data:{validUntil:at(2)}});
 await db.nativeDevice.update({where:{id:device.id},data:{analyticsCategory:'TV'}});
 const third=await makeInterval('TV','power',3,2);
 await db.deviceAreaAssignment.create({data:{homeId:home.id,deviceId:device.id,areaId:area.id,validFrom:at(2),source:'OS_SYNC'}});
 const p3=payload('TV','power',third,'a',2,3);await db.$transaction(tx=>ingest(tx,send(p3)));
 assert.equal(await db.nativeAnalyticsStateDay.count(),3,'switch-back uses a new epoch, not old series');
 const totals=await db.$queryRaw`SELECT "analyticsCategory",sum(("durationsSeconds"->>'on')::int)::int AS seconds FROM "NativeAnalyticsStateDay" GROUP BY "analyticsCategory"`;
 assert.deepEqual(Object.fromEntries(totals.map(r=>[r.analyticsCategory,r.seconds])),{TV:120,SOCKET:60});
 const straddling={...p,revision:2,coverageEndAt:stamp(2),durationsSeconds:{on:120,off:0,unknown:0},hourly:[{...p.hourly[0],coverageEndAt:stamp(2),durationsSeconds:{on:120,off:0,unknown:0}}]};
 const {applyHubSyncEvent}=load('src/lib/hubSyncIngestion.ts');
 await db.$transaction(tx=>applyHubSyncEvent(tx,{...send(straddling),suppressedEventIds:new Set()}));
 assert.equal(await db.nativeAnalyticsUnallocated.count(),1,'real savepoint wrapper retains straddling evidence unallocated');
 assert.equal(await db.nativeAnalyticsStateDay.count(),3);
 await db.$transaction(tx=>ingest(tx,input));assert.equal(await db.nativeAnalyticsStateDay.count(),3,'delayed old epoch replay is idempotent');
 // Both directions of the actual DB overlap guard, racing for one exact device window.
 const binary={homeId:home.id,deviceId:device.id,areaId:area.id,kind:'USAGE',analyticsCategory:'LIGHT',controlId:'power',sourceGeneration:1,bindingRevision:1,
  analyticsPolicyVersion:3,timezone:'Europe/London',dayStartAt:new Date(p.dayStartAt),dayEndAt:new Date(p.dayEndAt),writerFrom:new Date(p.writerFrom),
  assignmentEpochAt:new Date(p.assignmentEpochAt),origin:'HUB',revision:1,onSeconds:60,coverageStartAt:at(0),coverageEndAt:at(1),payloadDigest:'a'.repeat(64),purgeAt:new Date('2027-10-28')};
 await assert.rejects(db.nativeAnalyticsDay.create({data:binary}), 'binary cannot overlap state coverage');
 await db.nativeAnalyticsStateDay.delete({where:{id:multiStateDailyAggregateId(p)}});
 const race=await Promise.allSettled([db.nativeAnalyticsDay.create({data:binary}),db.$transaction(tx=>ingest(tx,input))]);
 assert.equal(race.filter(r=>r.status==='fulfilled').length,1,'device-row lock serializes concurrent binary/state writers');
 assert.equal(await db.nativeAnalyticsDay.count()+await db.nativeAnalyticsStateDay.count(),3,'exactly one representation survives the race');
 await db.nativeAnalyticsDay.deleteMany({where:{deviceId:device.id}});
 if(!await db.nativeAnalyticsStateDay.findUnique({where:{id:multiStateDailyAggregateId(p)}}))await db.$transaction(tx=>ingest(tx,input));
 const {maintainDailyAnalytics}=load('src/lib/dailyAnalyticsMaintenance.ts');
 await db.nativeAnalyticsRetention.update({where:{hubInstallationId:hub.id},data:{backfillThrough:new Date(p.writerFrom)}});
 const prior=process.env.DINODIA_CALENDAR_ANALYTICS_ENABLED;process.env.DINODIA_CALENDAR_ANALYTICS_ENABLED='true';
 try {
  const later=new Date('2026-11-03T01:00:00Z');await maintainDailyAnalytics(db,later);
  assert.ok((await db.nativeAnalyticsStateDay.findMany()).every(r=>r.hourly.length===0),'real maintenance compacts prior-week detail');
  await db.$transaction(tx=>ingest(tx,{...send({...p3,revision:2}),now:later}));
  assert.deepEqual((await db.nativeAnalyticsStateDay.findUnique({where:{id:multiStateDailyAggregateId(p3)}})).hourly,[],'late update cannot resurrect compacted detail');
  // Erase exactly the second Area while retaining the surviving Area series.
  const operationId='44444444-4444-4444-8444-444444444444',fence='a'.repeat(64);
  const operation=await db.nativeDomainOutbox.create({data:{homeId:home.id,hubInstallationId:hub.id,aggregateType:'AreaDeletion',aggregateId:area2.id,
   eventType:'AREA_DELETE_V1',idempotencyKey:`area-delete:${hub.id}:${operationId}`,state:'WAITING_HUB',expiresAt:new Date('9999-12-31'),
   payload:{version:1,actorId:'55555555-5555-4555-8555-555555555555',digest:'b'.repeat(64),localFenceDigest:fence,
    snapshot:{areaId:area2.id,osAreaId:'b',areaRevision:1,managementRevision:1,deviceIds:[],osDeviceIds:[],membershipIds:[],legacyDeviceIds:[],legacyOsDeviceIds:[]}}}});
  const {deletedTargetReference}=load('src/lib/deletionReferences.ts');
  await db.deletionSecurityReceipt.create({data:{anonymousReference:deletedTargetReference(hub.id,'area','b'),actionType:'AREA_DEVICE_ERASURE',purgeAt:new Date('9999-12-31')}});
  const {finishAreaDeletion}=load('src/lib/areaDeletion.ts');
  const finish=()=>db.$transaction(async tx=>{await tx.$queryRaw`SELECT set_config('dinodia.area_deletion_operation',${operation.id},true)`;
   await tx.area.updateMany({where:{id:area2.id},data:{status:'RETIRED'}});
   return finishAreaDeletion(tx,{homeId:home.id,hubInstallationId:hub.id},{operationId,localFenceDigest:fence});},{timeout:20000});
  assert.equal((await finish()).state,'COMPLETE');assert.equal((await finish()).state,'COMPLETE','finish retry remains idempotent');
  assert.equal(await db.nativeAnalyticsStateDay.count(),2);assert.equal(await db.nativeAnalyticsStateDay.count({where:{areaId:area2.id}}),0);
  assert.equal(await db.area.count({where:{id:area2.id}}),0,'real finish workflow removes the exact Area and new history');
  assert.equal(await db.nativeDevice.count({where:{id:device.id}}),1,'surviving Area device is preserved');
  await db.$transaction(tx=>applyHubSyncEvent(tx,send(p2)));
  assert.equal(await db.nativeAnalyticsStateDay.count(),2,'security receipt suppresses old erased-Area state replay');
  assert.equal(await db.nativeAnalyticsUnallocated.count({where:{areaId:area2.id}}),0,'erased payload does not reappear in quarantine');
  await maintainDailyAnalytics(db,new Date('2027-11-03T01:00:00Z'));
  assert.equal(await db.nativeAnalyticsStateDay.count(),0,'real annual maintenance removes expired new-state rows');
  await assert.rejects(db.$transaction(tx=>ingest(tx,{...send({...p3,revision:3}),now:new Date('2027-11-03T01:00:00Z')})),e=>e.code==='hub_sync_state_coverage_invalid');
  // Recreate a valid fixture at its original test clock for the subsequent
  // private-device DB guard test; not a restore or production-clock operation.
  await db.$transaction(tx=>ingest(tx,send({...p3,revision:3})));
 } finally {if(prior===undefined)delete process.env.DINODIA_CALENDAR_ANALYTICS_ENABLED;else process.env.DINODIA_CALENDAR_ANALYTICS_ENABLED=prior;}
 console.log('PASS: real new-table category/source/Area switch-back, savepoint unallocated straddle, replay, binary overlap rejection, week compaction/late update, Area-scoped purge and annual expiry');
}
