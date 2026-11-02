import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

/** Only called by the disposable loopback harness, never a Production operator. */
export async function automationV2Integration({prisma, fixture:f, base, fetchJson, machineRequest, buildConfiguration, osRoot}) {
  assert(['127.0.0.1','localhost'].includes(new URL(base).hostname));
  const headers={cookie:`dinodia_customer_session=${encodeURIComponent(f.customerSessionSecret)}`,
    'x-dinodia-home-id':f.homeOneId,'content-type':'application/json','x-dinodia-automations':'2'};
  const request=(url,method='GET',body,extra={})=>fetchJson(base+url,{method,headers:{...headers,...extra},...(body?{body:JSON.stringify(body)}:{})});
  const hub=await prisma.hubInstallation.findUniqueOrThrow({where:{id:f.hubOneId},select:{capabilitySummary:true}});
  const devices=[];let id;
  try {
    for(const [name,control] of [['Sensor',{controlId:'temperature',label:'Temperature',valueType:'number',readable:true,observable:true,writable:false,automatable:false,semanticRole:'ambient_temperature',constraints:{minimum:0,maximum:40,step:1}}],['Light',{controlId:'power',label:'Power',valueType:'boolean',readable:true,observable:true,writable:true,automatable:true,idempotency:'set_value',semanticRole:'power',constraints:{}}]]) {
      const digest=crypto.randomBytes(32).toString('hex');
      const d=await prisma.nativeDevice.create({data:{homeId:f.homeOneId,hubInstallationId:f.hubOneId,osDeviceId:`custom-${crypto.randomUUID()}`,originalName:`Disposable ${name}`,technicalLabel:'LIGHT',managementClass:'PROPERTY_DEVICE',deviceType:'test.unknown',protocol:'virtual',lifecycle:'INSTALLED',descriptorRevision:1,descriptorDigest:digest,capabilitySummary:{protocol:'virtual',descriptorDigest:digest,controlCatalog:{revision:1,descriptorDigest:digest,controls:[{...control,riskLevel:'normal',stepUpPolicy:'none',catalogRevision:1}]}}}});
      await prisma.deviceAreaAssignment.create({data:{homeId:f.homeOneId,deviceId:d.id,areaId:f.areaOneId,source:'AUTOMATION_V2_DISPOSABLE_TEST',validFrom:new Date()}});devices.push(d);
    }
    const definition={name:'Disposable custom rule',enabled:false,trigger:{kind:'device_state',deviceId:devices[0].id,areaId:f.areaOneId,controlId:'temperature',operator:'falls_below',value:{type:'number',number:18.25},resetMargin:0.5,conditions:{mode:'all',items:[{kind:'time_window',startMinute:1320,endMinute:120,weekdays:[1,2,3,4,5]}]}},actions:[{deviceId:devices[1].id,areaId:f.areaOneId,controlId:'power',targetValue:{type:'boolean',boolean:true}}]};
    await prisma.hubInstallation.update({where:{id:f.hubOneId},data:{capabilitySummary:{...(hub.capabilitySummary||{}),nativeDeviceTriggersV2:false}}});
    const unsupported=await request('/api/automations','POST',definition,{'idempotency-key':crypto.randomUUID()});
    assert.equal(unsupported.response.status,409,JSON.stringify(unsupported.body));assert.equal(unsupported.body.error.code,'FEATURE_NOT_ENABLED');
    await prisma.hubInstallation.update({where:{id:f.hubOneId},data:{capabilitySummary:{...(hub.capabilitySummary||{}),nativeDeviceTriggersV2:true}}});
    const key=crypto.randomUUID(),created=await request('/api/automations','POST',definition,{'idempotency-key':key});
    assert.equal(created.response.status,201,JSON.stringify(created.body));id=created.body.automationId;assert(id);
    const replay=await request('/api/automations','POST',definition,{'idempotency-key':key});assert.equal(replay.body.automationId,id);assert.equal(await prisma.nativeAutomation.count({where:{id}}),1);
    const row=await prisma.nativeAutomation.findUniqueOrThrow({where:{id},include:{triggers:true,actions:true}});
    assert.equal(row.status,'PAUSED');assert.equal(row.triggers[0].kind,'DEVICE_STATE');assert.equal(row.triggers[0].configuration.source.osDeviceId,devices[0].osDeviceId);
    const listed=await request('/api/automations');assert.equal(listed.response.status,200,JSON.stringify(listed.body));
    const rootContract=JSON.parse(fs.readFileSync(new URL('../contracts/dinodia-v1/contract.json',import.meta.url)));
    const versioned=JSON.parse(fs.readFileSync(new URL('../contracts/dinodia-automations-v2/schemas/automations-v2.schema.json',import.meta.url)));
    const ajv=new Ajv2020({strict:false,formats:{'date-time':s=>/^\d{4}-\d{2}-\d{2}T.*Z$/.test(s)&&Number.isFinite(Date.parse(s))}});ajv.addSchema(rootContract);ajv.addSchema(versioned);
    const validateProjection=ajv.getSchema(versioned.$id+'#/$defs/projection');assert.equal(validateProjection(listed.body),true,JSON.stringify(validateProjection.errors));
    const item=listed.body.automations.find(r=>r.id===id);assert(item);assert.equal(item.trigger.kind,'DEVICE_STATE');assert.equal(item.trigger.configuration.deviceId,devices[0].id);assert(!JSON.stringify(item.trigger).includes('osDeviceId'));
    const legacy=await request('/api/automations','GET',undefined,{'x-dinodia-automations':''});assert.equal(legacy.response.status,200);assert.equal(legacy.body.automations.find(r=>r.id===id).trigger,null);
    const overwrite=await request(`/api/automations/${id}`,'PUT',{expectedRevision:1,definition:{name:'Wrong old edit',trigger:{minuteOfDay:420,weekdays:[1]},actions:definition.actions}},{'x-dinodia-automations':'','idempotency-key':crypto.randomUUID()});
    assert.equal(overwrite.response.status,409);assert.equal(overwrite.body.error.code,'FEATURE_NOT_ENABLED');
    const denied=structuredClone(definition);denied.trigger.areaId=f.homeTwoId;
    const foreign=await request('/api/automations','POST',denied,{'idempotency-key':crypto.randomUUID()});assert.equal(foreign.response.status,403,JSON.stringify(foreign.body));
    const login=await fetchJson(base+'/api/v2/mobile/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:f.loginEmail,password:f.loginPassword,deviceInstallationId:f.loginInstallationId,publicKey:f.loginPublicKey,deviceName:'Disposable automation V2',model:'test',osFamily:'test',osVersion:'test'})});
    assert.equal(login.response.status,200);
    const proxy=await machineRequest({base,path:'/api/hub-agent/v2/tenant-automations',machineSecret:f.machineSecret,body:{serial:f.identityOneSerial,identityGeneration:f.identityOneGeneration,schemaVersion:'dinodia.v1',homeId:f.homeOneId,membershipId:f.tenantMembershipId,operation:'list',accountAccessToken:login.body.accessToken,automationContractVersion:2}});
    assert.equal(proxy.response.status,200,JSON.stringify(proxy.body));assert.equal(validateProjection(proxy.body),true,JSON.stringify(validateProjection.errors));assert.equal(proxy.body.automations.find(r=>r.id===id).trigger.kind,'DEVICE_STATE');
    // Simulate the already-tested signed acknowledgement in this disposable fixture only.
    const current=await prisma.hubInstallation.findUniqueOrThrow({where:{id:f.hubOneId},select:{cloudConfigurationRevision:true}});
    await prisma.hubInstallation.update({where:{id:f.hubOneId},data:{acknowledgedCloudRevision:current.cloudConfigurationRevision}});
    const enable=await request(`/api/automations/${id}/enabled`,'POST',{enabled:true,expectedRevision:1},{'idempotency-key':crypto.randomUUID()});assert.equal(enable.response.status,200,JSON.stringify(enable.body));
    const beforeFlag=process.env.DINODIA_NATIVE_AUTOMATIONS_ENABLED;process.env.DINODIA_NATIVE_AUTOMATIONS_ENABLED='true';
    try {
      const require=createRequire(path.join(osRoot,'package.json'));
      const {validateCloudConfiguration}=require(path.join(osRoot,'src/sync/cloudConfiguration.js'));
      const capable=await buildConfiguration(prisma,{homeId:f.homeOneId,hubInstallationId:f.hubOneId});
      assert.equal(validateCloudConfiguration(capable),true,'real Platform bundle must pass the actual Hub boundary');
      assert.equal(capable.tenantAutomationProjection.version,2);assert.equal(capable.automations.find(r=>r.id===id).triggers[0].kind,'DEVICE_STATE');
      await prisma.hubInstallation.update({where:{id:f.hubOneId},data:{capabilitySummary:{...(hub.capabilitySummary||{}),nativeDeviceTriggersV2:false}}});
      const legacyBundle=await buildConfiguration(prisma,{homeId:f.homeOneId,hubInstallationId:f.hubOneId});
      assert.equal(legacyBundle.tenantAutomationProjection.version,1);assert(!legacyBundle.automations.some(r=>r.id===id));assert.equal(validateCloudConfiguration(legacyBundle),true);
      await prisma.hubInstallation.update({where:{id:f.hubOneId},data:{capabilitySummary:{...(hub.capabilitySummary||{}),nativeDeviceTriggersV2:true}}});
    } finally {if(beforeFlag===undefined)delete process.env.DINODIA_NATIVE_AUTOMATIONS_ENABLED;else process.env.DINODIA_NATIVE_AUTOMATIONS_ENABLED=beforeFlag;}
    const removed=await request(`/api/automations/${id}`,'DELETE',{expectedRevision:2},{'idempotency-key':crypto.randomUUID()});assert.equal(removed.response.status,200,JSON.stringify(removed.body));
    assert.equal(await prisma.nativeAutomationTrigger.count({where:{automationId:id}}),0);assert.equal(await prisma.nativeAutomationAction.count({where:{automationId:id}}),0);
    console.log('[automation-v2:integration] PASS real HTTP/DB create paused, exact read-only bindings, idempotency, V1 projection, overwrite refusal, source authority, signed proxy and retirement');
  } finally {
    if(id) {await prisma.nativeAutomationTrigger.deleteMany({where:{automationId:id}});await prisma.nativeAutomationAction.deleteMany({where:{automationId:id}});await prisma.nativeAutomation.deleteMany({where:{id}});}
    await prisma.deviceAreaAssignment.deleteMany({where:{deviceId:{in:devices.map(d=>d.id)}}});await prisma.nativeDevice.deleteMany({where:{id:{in:devices.map(d=>d.id)}}});
    await prisma.hubInstallation.update({where:{id:f.hubOneId},data:{capabilitySummary:hub.capabilitySummary||{}}});
  }
}
