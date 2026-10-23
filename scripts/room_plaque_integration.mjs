import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Called by the existing guarded, disposable Docker/HTTP harness. Never Production.
export async function roomPlaqueIntegration({ base, prisma, homeId, headers, ownerSession, fetchJson, loginEmployee, hashPassword, manager, tenant }) {
  assert.ok(new URL(base).hostname === '127.0.0.1' || new URL(base).hostname === 'localhost');
  const home=await prisma.home.findUniqueOrThrow({where:{id:homeId}});
  const areaIds=[],orderIds=[],employees=[];
  const email=`plaque-${crypto.randomUUID()}@example.test`,password='Synthetic-plaque-test-2026';
  const employee=await prisma.companyEmployeeAccount.create({data:{displayName:'Synthetic plaque operator',email,emailNormalized:email,role:'CXO',status:'ACTIVE',passwordHash:hashPassword(password)}});
  const session=await loginEmployee(base,employee,password);
  const staff={'content-type':'application/json','x-dinodia-employee-session':session.token,origin:'https://dinodia-platform-v2.vercel.app'};
  const installerEmail=`plaque-installer-${crypto.randomUUID()}@example.test`,installerPassword='Synthetic-installer-test-2026';
  const installer=await prisma.companyEmployeeAccount.create({data:{displayName:'Synthetic installer denied',email:installerEmail,emailNormalized:installerEmail,role:'INSTALLER',status:'ACTIVE',passwordHash:hashPassword(installerPassword)}});employees.push(installer.id);
  const installerLogin=await loginEmployee(base,installer,installerPassword);
  const installerHeaders={'x-dinodia-employee-session':installerLogin.token,origin:'https://dinodia-platform-v2.vercel.app'};
  async function mobileHeaders(user) {
    const {email,password,deviceInstallationId,publicKey}=user;
    const login=await fetchJson(`${base}/api/v2/mobile/session`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password,deviceInstallationId,publicKey,deviceName:'Disposable plaque access check',model:'integration-test',osFamily:'test',osVersion:'test'})});
    assert.equal(login.response.status,200,'disposable role session must be valid');
    return {authorization:`Bearer ${login.body.accessToken}`,'x-dinodia-home-id':homeId,'content-type':'application/json'};
  }
  const managerHeaders=await mobileHeaders(manager),tenantHeaders=await mobileHeaders(tenant);
  const get=async(p,h=headers)=>fetchJson(`${base}${p}`,{headers:h});
  const post=async(p,b,h=headers,key=crypto.randomUUID())=>fetchJson(`${base}${p}`,{method:'POST',headers:{...h,'content-type':'application/json','idempotency-key':key},body:JSON.stringify(b)});
  const root=`/api/v2/homes/${homeId}`;
  const noLeak=value=>{assert.ok(!JSON.stringify(value).includes('dno_room_'));assert.ok(!JSON.stringify(value).includes('encryptedPrintablePayload'));};
  try {
    await prisma.home.update({where:{id:homeId},data:{addressLine1:'1 Synthetic Test Street',city:'Test City',postcode:'TE1 1ST',country:'GB'}});
    for(let i=0;i<4;i++){const area=await prisma.area.create({data:{homeId,osAreaId:`plaque-${crypto.randomUUID()}`,originalName:i<2?'Same room':i===2?'Cancel room':'Race room'}});areaIds.push(area.id);}
    const before=await get(`${root}/room-qrs`);assert.equal(before.response.status,200);noLeak(before.body);
    for(const id of areaIds)assert.equal(before.body.rooms.find(r=>r.areaId===id).codeState,'NOT_ISSUED');
    assert.equal((await get(`${root}/room-qrs`,managerHeaders)).response.status,200,'current property manager can use the homeowner library');
    assert.equal((await get(`${root}/room-qrs`,tenantHeaders)).response.status,404,'tenant membership cannot list management QR data');
    assert.equal((await get(`/api/v2/homes/${crypto.randomUUID()}/room-qrs`,headers)).response.status,404,'another Home cannot be enumerated');
    assert.equal((await get('/api/company/room-plaque-requests',installerHeaders)).response.status,403,'installer role is not manufacturing authority');
    const tenantOrder=await post(`${root}/room-plaque-requests`,{contractVersion:1,items:[{areaId:areaIds[0],kind:'FIRST_ISSUE'}],notes:'denied',confirmRegisteredAddress:true},tenantHeaders);
    assert.equal(tenantOrder.response.status,404);assert.equal(await prisma.roomPlaqueRequest.count({where:{homeId}}),0,'denied tenant cannot create an order');
    const atomicInvalid=await post(`${root}/room-plaque-requests`,{contractVersion:1,items:[{areaId:areaIds[0],kind:'FIRST_ISSUE'},{areaId:crypto.randomUUID(),kind:'FIRST_ISSUE'}],notes:'invalid atomic set',confirmRegisteredAddress:true});
    assert.equal(atomicInvalid.response.status,400);assert.equal(await prisma.roomPlaqueRequest.count({where:{homeId}}),0,'invalid multi-room request leaves no partial order');
    const raceBody={contractVersion:1,items:[{areaId:areaIds[3],kind:'FIRST_ISSUE'}],notes:'concurrent synthetic request',confirmRegisteredAddress:true};
    const race=await Promise.all([post(`${root}/room-plaque-requests`,raceBody,headers,crypto.randomUUID()),post(`${root}/room-plaque-requests`,raceBody,headers,crypto.randomUUID())]);
    assert.deepEqual(race.map(x=>x.response.status).sort(),[201,409]);orderIds.push(race.find(x=>x.response.status===201).body.request.id);
    assert.equal(await prisma.roomPlaqueRequestItem.count({where:{requestId:orderIds.at(-1),areaId:areaIds[3]}}),1,'concurrent duplicate intent reserves one Area exactly once');
    assert.equal((await post(`/api/company/room-plaque-requests/${orderIds.at(-1)}/transition`,{action:'START_PRODUCTION',expectedRevision:1},installerHeaders)).response.status,403);
    const body={contractVersion:1,items:areaIds.slice(0,2).map(areaId=>({areaId,kind:'FIRST_ISSUE'})),notes:'Synthetic order only',confirmRegisteredAddress:true};
    const key=crypto.randomUUID();const created=await post(`${root}/room-plaque-requests`,body,headers,key);assert.equal(created.response.status,201);
    const id=created.body.request.id;orderIds.push(id);noLeak(created.body);
    assert.equal(await prisma.areaQrCredential.count({where:{areaId:{in:areaIds}}}),0,'submit must not issue');
    assert.deepEqual((await post(`${root}/room-plaque-requests`,body,headers,key)).body,created.body);
    assert.equal((await post(`${root}/room-plaque-requests`,body)).response.status,409,'different-key duplicate open order');
    assert.equal((await post(`${root}/room-plaque-requests`,{...body,notes:'changed'},headers,key)).response.status,409);
    const transition=async(action,revision=1,k=crypto.randomUUID())=>post(`/api/company/room-plaque-requests/${id}/transition`,{action,expectedRevision:revision},staff,k);
    assert.equal((await transition('COMPLETE')).response.status,409);
    const productionKeys=[crypto.randomUUID(),crypto.randomUUID()];
    const productionRace=await Promise.all(productionKeys.map(k=>transition('START_PRODUCTION',1,k)));
    assert.deepEqual(productionRace.map(x=>x.response.status).sort(),[200,409],'only one concurrent production transition may issue credentials');
    const productionIndex=productionRace.findIndex(x=>x.response.status===200),production=productionRace[productionIndex];
    assert.deepEqual((await transition('START_PRODUCTION',1,productionKeys[productionIndex])).body,production.body,'exact uncertain production retry returns its original receipt');
    assert.equal(await prisma.areaQrCredential.count({where:{areaId:{in:areaIds}}}),2);
    const row=await prisma.areaQrCredential.findFirstOrThrow({where:{areaId:areaIds[0]}});
    const reveal=await post(`${root}/room-qrs/${areaIds[0]}/reveal`,{expectedGeneration:1});assert.equal(reveal.response.status,200);
    const reference=reveal.body.reference;assert.equal(crypto.createHash('sha256').update(reference).digest('hex'),row.resolverHash);
    assert.equal((await post(`${root}/room-qrs/${areaIds[1]}/reveal`,{expectedGeneration:2})).response.status,409);
    const other=(await post(`${root}/room-qrs/${areaIds[1]}/reveal`,{expectedGeneration:1})).body.reference;assert.notEqual(other,reference);
    const scanned=await post('/api/public/areas/scan',{reference},{});assert.equal(scanned.response.status,200);
    assert.equal(await prisma.tenantAreaGrant.count({where:{areaId:{in:areaIds}}}),0,'issuing/scanning grants no access');
    const requested=await post('/api/public/areas/request-access',{reference,expectedGeneration:1,idempotencyKey:`plaque-access-${crypto.randomUUID()}`},tenantHeaders);
    assert.equal(requested.response.status,201,'newly issued plaque uses the existing signed-in access request path');
    assert.equal(await prisma.tenantAreaGrant.count({where:{areaId:areaIds[0],revokedAt:null}}),0,'requesting access still requires approval');
    const decisionValue={decision:'APPROVE',expectedRevision:requested.body.revision};
    const challenge=await post('/api/v2/security/step-up/challenge',{operationKind:'home_room_access_decision',targetIds:[requested.body.requestId],value:decisionValue},managerHeaders);
    assert.equal(challenge.response.status,200);
    const challengeMessage=Buffer.from(`DINODIA_STEP_UP_CHALLENGE_V1\n${challenge.body.challengeId}\n${challenge.body.nonce}\n${challenge.body.operationDigest}`);
    const proof=await post('/api/v2/security/step-up/issue',{challengeId:challenge.body.challengeId,nonce:challenge.body.nonce,deviceSignature:crypto.sign(null,challengeMessage,crypto.createPrivateKey(manager.signingKey)).toString('base64url')},managerHeaders);
    assert.equal(proof.response.status,200);
    const approved=await post(`${root}/room-access-requests/${requested.body.requestId}/decision`,{requestId:requested.body.requestId,...decisionValue,idempotencyKey:`plaque-approve-${crypto.randomUUID()}`,proof:proof.body.proof},managerHeaders);
    assert.equal(approved.response.status,200,'current manager approves only through the existing trusted-phone proof');
    assert.equal(await prisma.tenantAreaGrant.count({where:{areaId:areaIds[0],revokedAt:null}}),1);
    await prisma.area.update({where:{id:areaIds[0]},data:{overrideName:'Renamed synthetic room'}});
    assert.equal((await post(`${root}/room-qrs/${areaIds[0]}/reveal`,{expectedGeneration:1})).body.reference,reference);
    const print=await post(`/api/company/room-plaque-requests/${id}/print`,{expectedRevision:2},staff);assert.equal(print.response.status,200);
    assert.equal(print.body.plaques.find(p=>p.areaId===areaIds[0]).roomLabel,'Renamed synthetic room');
    if(process.platform==='darwin') {
      const temp=fs.mkdtempSync(path.join(os.tmpdir(),'dinodia-plaque-decode-'));
      const file=path.join(temp,'synthetic.png');fs.writeFileSync(file,Buffer.from(print.body.plaques.find(p=>p.areaId===areaIds[0]).image.split(',')[1],'base64'),{mode:0o600});
      const digest=execFileSync('swift',['scripts/decode_room_qr.swift',file],{encoding:'utf8'}).trim();assert.equal(digest,row.resolverHash);
      fs.unlinkSync(file);fs.rmdirSync(temp);
    }
    const secondPrint=await post(`/api/company/room-plaque-requests/${id}/print`,{expectedRevision:2},staff);assert.deepEqual(secondPrint.body,print.body);
    assert.equal((await transition('DISPATCH',2)).response.status,200);assert.equal((await transition('DISPATCH',2)).response.status,409);
    assert.equal((await transition('COMPLETE',3)).response.status,200);
    assert.equal(await prisma.roomPlaqueRequestItem.count({where:{requestId:id,closedAt:null}}),0);
    const reprint=await post(`${root}/room-plaque-requests`,{...body,items:[{areaId:areaIds[0],kind:'REPRINT',expectedGeneration:1}]});assert.equal(reprint.response.status,201);orderIds.push(reprint.body.request.id);
    const rid=reprint.body.request.id;
    assert.equal((await post(`/api/company/room-plaque-requests/${rid}/transition`,{action:'START_PRODUCTION',expectedRevision:1},staff)).response.status,200);
    await prisma.home.update({where:{id:homeId},data:{city:'Changed Synthetic City'}});
    assert.equal((await post(`/api/company/room-plaque-requests/${rid}/transition`,{action:'DISPATCH',expectedRevision:2},staff)).response.status,409,'dispatch is held when registered fulfilment address changes');
    // B1: actual HTTP/DB recovery, not just a state-machine fixture. These
    // mutations affect only the disposable harness Home and are restored.
    const cancelPath=orderId=>`/api/company/room-plaque-requests/${orderId}/transition`;
    const cancelBody={action:'CANCEL',expectedRevision:2,reason:'Registered address changed; stop physical fulfilment'};
    const beforeRejectedCancellation=await prisma.roomPlaqueRequest.findUniqueOrThrow({where:{id:rid}});
    const auditCountBefore=await prisma.auditEvent.count({where:{targetId:rid}});
    const rejectedReason=await post(cancelPath(rid),{...cancelBody,reason:`Incorrect plaque ${reference} was supplied`},staff);
    assert.equal(rejectedReason.response.status,400,'embedded raw room reference is refused before audit persistence');noLeak(rejectedReason.body);
    assert.deepEqual(await prisma.roomPlaqueRequest.findUniqueOrThrow({where:{id:rid}}),beforeRejectedCancellation,'refused reason leaves status/revision/timestamps unchanged');
    assert.equal(await prisma.roomPlaqueRequestItem.count({where:{requestId:rid,closedAt:null}}),1,'refused reason retains reservation');
    assert.equal(await prisma.auditEvent.count({where:{targetId:rid}}),auditCountBefore,'refused reason creates no audit entry');
    assert.equal((await post(cancelPath(rid),{action:'CANCEL',expectedRevision:2},staff)).response.status,400,'staff reason is mandatory');
    assert.equal((await post(`${root}/room-plaque-requests/${rid}/cancel`,{expectedRevision:2})).response.status,409,'customers cannot cancel after production starts');
    assert.equal((await post(cancelPath(rid),cancelBody,installerHeaders)).response.status,403,'installer cannot resolve a hold');
    const cancelKey=crypto.randomUUID(),cancelled=await post(cancelPath(rid),cancelBody,staff,cancelKey);
    assert.equal(cancelled.response.status,200,'address-held production can be closed without repairing the address first');
    assert.deepEqual((await post(cancelPath(rid),cancelBody,staff,cancelKey)).body,cancelled.body,'same cancellation replay returns original receipt');
    assert.equal((await post(cancelPath(rid),{...cancelBody,reason:'Different intent'},staff,cancelKey)).response.status,409,'reason is bound to the idempotency key');
    const verifyClosed=async(orderId,reason,previousStatus)=>{
      const closed=await prisma.roomPlaqueRequest.findUniqueOrThrow({where:{id:orderId}});
      assert.equal(closed.status,'CANCELLED');assert.ok(closed.productionStartedAt);assert.ok(closed.cancelledAt);
      if(previousStatus==='DISPATCHED')assert.ok(closed.dispatchedAt,'cancellation never rewinds dispatch history');
      assert.equal(await prisma.roomPlaqueRequestItem.count({where:{requestId:orderId,closedAt:null}}),0);
      const events=await prisma.auditEvent.findMany({where:{targetId:orderId,action:'room_plaque_cancel'}});
      assert.equal(events.length,1);assert.equal(events[0].actorId,employee.id);
      assert.equal(events[0].metadata.reason,reason);assert.equal(events[0].metadata.previousStatus,previousStatus);noLeak(events);
      assert.equal(await prisma.areaQrCredential.count({where:{areaId:areaIds[0]}}),1);
      assert.equal((await prisma.areaQrCredential.findUniqueOrThrow({where:{id:row.id}})).resolverHash,row.resolverHash,'closure never changes issued QR');
    };
    await verifyClosed(rid,cancelBody.reason,'IN_PRODUCTION');
    const makeReplacement=async(h=headers)=>{
      const result=await post(`${root}/room-plaque-requests`,{...body,items:[{areaId:areaIds[0],kind:'REPRINT',expectedGeneration:1}]},h);
      assert.equal(result.response.status,201,'resolved rooms can immediately be ordered again');orderIds.push(result.body.request.id);return result.body.request.id;
    };
    const transferredId=await makeReplacement();
    assert.equal((await post(cancelPath(transferredId),{action:'START_PRODUCTION',expectedRevision:1},staff)).response.status,200);
    await prisma.home.update({where:{id:homeId},data:{authorityGeneration:{increment:1}}});
    assert.equal((await post(cancelPath(transferredId),{action:'DISPATCH',expectedRevision:2},staff)).response.status,409,'ownership generation holds dispatch');
    const transferReason='Ownership changed; physical work stopped';
    assert.equal((await post(cancelPath(transferredId),{action:'CANCEL',expectedRevision:2,reason:transferReason},staff)).response.status,200);
    await verifyClosed(transferredId,transferReason,'IN_PRODUCTION');
    const managerOrder=await makeReplacement(managerHeaders);
    assert.equal((await post(cancelPath(managerOrder),{action:'START_PRODUCTION',expectedRevision:1},staff)).response.status,200);
    assert.equal((await post(cancelPath(managerOrder),{action:'DISPATCH',expectedRevision:2},staff)).response.status,200);
    const managerMembership=await prisma.homeMembership.findFirstOrThrow({where:{homeId,role:'PROPERTY_MANAGER',status:'ACTIVE'}});
    try {
      await prisma.homeMembership.update({where:{id:managerMembership.id},data:{status:'REMOVED'}});
      assert.equal((await post(cancelPath(managerOrder),{action:'COMPLETE',expectedRevision:3},staff)).response.status,409,'removed requester holds completion even after dispatch');
      const reason='Requester removed; goods handled separately';
      assert.equal((await post(cancelPath(managerOrder),{action:'CANCEL',expectedRevision:3,reason},staff)).response.status,200,'explicit staff cancellation resolves dispatched hold without pretending delivery');
      await verifyClosed(managerOrder,reason,'DISPATCHED');
      const reopened=await makeReplacement();
      assert.equal((await post(`${root}/room-plaque-requests/${reopened}/cancel`,{expectedRevision:1})).response.status,200);
    } finally {await prisma.homeMembership.update({where:{id:managerMembership.id},data:{status:managerMembership.status}});}
    console.log('[room-plaques:integration] PASS: B1 address/authority/requester holds resolved; audited reason, actor scope, exact replay, retained QR and reorder verified');
    await prisma.home.update({where:{id:homeId},data:{city:'Test City'}});
    assert.equal((await post(`${root}/room-qrs/${areaIds[0]}/reveal`,{expectedGeneration:1})).body.reference,reference);
    assert.equal(await prisma.areaQrCredential.count({where:{areaId:areaIds[0]}}),1,'reprint preserves credential');
    const cancellation=await post(`${root}/room-plaque-requests`,{...body,items:[{areaId:areaIds[2],kind:'FIRST_ISSUE'}]});assert.equal(cancellation.response.status,201);orderIds.push(cancellation.body.request.id);
    assert.equal((await post(`${root}/room-plaque-requests/${cancellation.body.request.id}/cancel`,{expectedRevision:1})).response.status,200);
    assert.equal(await prisma.areaQrCredential.count({where:{areaId:areaIds[2]}}),0);
    const legacy=`dno_room_${crypto.randomBytes(32).toString('base64url')}`;
    await prisma.areaQrCredential.create({data:{areaId:areaIds[2],resolverHash:crypto.createHash('sha256').update(legacy).digest('hex')}});
    const legacyList=await get(`${root}/room-qrs`);assert.equal(legacyList.body.rooms.find(r=>r.areaId===areaIds[2]).codeState,'RECOVERY_REQUIRED');
    assert.equal((await post('/api/public/areas/scan',{reference:legacy},{})).response.status,200,'hash-only original remains valid');
    assert.equal((await post(`${root}/room-qrs/${areaIds[2]}/reveal`,{expectedGeneration:1})).response.status,409);
    await prisma.area.update({where:{id:areaIds[1]},data:{status:'RETIRED'}});
    assert.equal((await post(`${root}/room-qrs/${areaIds[1]}/reveal`,{expectedGeneration:1})).response.status,404,'retired room cannot reveal its code');
    assert.notEqual((await post('/api/public/areas/scan',{reference:other},{})).response.status,200,'retired room cannot resolve through the scanner');
    await prisma.area.update({where:{id:areaIds[1]},data:{status:'ACTIVE'}});
    const originalPayload=row.encryptedPrintablePayload;
    await prisma.areaQrCredential.update({where:{id:row.id},data:{encryptedPrintablePayload:{invalid:'synthetic-corruption'}}});
    assert.equal((await post(`${root}/room-qrs/${areaIds[0]}/reveal`,{expectedGeneration:1})).response.status,409,'corruption cannot reveal or reissue a reference');
    assert.equal(await prisma.areaQrCredential.count({where:{areaId:areaIds[0]}}),1);
    await prisma.areaQrCredential.update({where:{id:row.id},data:{encryptedPrintablePayload:originalPayload}});
    const raceId=orderIds[0];
    const cancellationRace=await Promise.all([
      post(`${root}/room-plaque-requests/${raceId}/cancel`,{expectedRevision:1}),
      post(`/api/company/room-plaque-requests/${raceId}/transition`,{action:'START_PRODUCTION',expectedRevision:1},staff)
    ]);
    assert.deepEqual(cancellationRace.map(result=>result.response.status).sort(),[200,409],'cancellation and production have one committed winner');
    const raceOrder=await prisma.roomPlaqueRequest.findUniqueOrThrow({where:{id:raceId}});
    const raceIssued=await prisma.areaQrCredential.count({where:{areaId:areaIds[3]}});
    assert.equal(raceIssued,raceOrder.status==='CANCELLED'?0:1,'cancelled production never issues a credential');
    assert.equal((await get('/api/company/room-plaque-requests',headers)).response.status,401);
    assert.equal((await post(`/api/company/room-plaque-requests/${rid}/transition`,{action:'DISPATCH',expectedRevision:2},{...staff,origin:'https://untrusted.invalid'})).response.status,403);
    await prisma.home.update({where:{id:homeId},data:{authorityGeneration:{increment:1}}});
    assert.equal((await post(`/api/company/room-plaque-requests/${rid}/print`,{expectedRevision:2},staff)).response.status,409,'transfer generation holds printing');
    if(process.env.ROOM_QR_IOS_LIVE==='1') {
      assert.equal(process.platform,'darwin');
      const iosRoot=process.env.DINODIA_IOS_ROOT,derived=process.env.ROOM_QR_IOS_DERIVED_DATA,simulator=process.env.ROOM_QR_SIMULATOR_ID;
      assert.ok(iosRoot&&derived&&simulator&&fs.existsSync(derived),'reuse an existing iOS worktree, DerivedData and simulator');
      const fixture=path.join(iosRoot,'.room-qr-live-test.json');
      assert.ok(!fs.existsSync(fixture),'never overwrite an existing live-test fixture');
      const membership=await prisma.homeMembership.findFirstOrThrow({where:{homeId,customerAccountId:ownerSession.accountId,role:'OWNER',status:'ACTIVE'}});
      const appArea=await prisma.area.create({data:{homeId,osAreaId:`plaque-app-${crypto.randomUUID()}`,originalName:'Simulator requested room'}});areaIds.push(appArea.id);
      const log=path.join(path.dirname(derived),'ios-live-platform.log'),fd=fs.openSync(log,'w',0o600);
      try {
        fs.writeFileSync(fixture,JSON.stringify({base,homeId,accountId:ownerSession.accountId,membershipId:membership.id,areaId:areaIds[0],requestAreaId:appArea.id,refreshToken:ownerSession.refreshToken,staffToken:session.token}),{mode:0o600,flag:'wx'});
        execFileSync('xcodebuild',['-project',path.join(iosRoot,'Dinodia.xcodeproj'),'-scheme','Dinodia','-configuration','Debug',
          '-destination',`platform=iOS Simulator,id=${simulator}`,'-derivedDataPath',derived,'ONLY_ACTIVE_ARCH=YES','CODE_SIGNING_ALLOWED=NO',
          '-only-testing:DinodiaTests/DinodiaV1SessionShellTests/testRoomQrProviderAndModelAgainstDisposablePlatform','test'],{cwd:iosRoot,stdio:['ignore',fd,fd],timeout:240000});
        const testLog=fs.readFileSync(log,'utf8');
        assert.match(testLog,/testRoomQrProviderAndModelAgainstDisposablePlatform.*passed/);
        assert.match(testLog,/Executed 1 test, with 0 failures/);
        assert.ok(!/testRoomQrProviderAndModelAgainstDisposablePlatform.*skipped/.test(testLog),'the connected test must execute, not skip');
        console.log('[room-plaques:integration] PASS: production iOS provider/model refreshed and revealed the staff-issued QR against this actual disposable Platform');
      } finally {
        fs.closeSync(fd);if(fs.existsSync(fixture))fs.unlinkSync(fixture);
        const appOrders=await prisma.roomPlaqueRequest.findMany({where:{items:{some:{areaId:appArea.id}}},select:{id:true}});
        orderIds.push(...appOrders.map(order=>order.id));
      }
    }
    console.log('[room-plaques:integration] PASS: real HTTP/database request, staff issue, encrypted retrieval, repeat printing/QR decode, scan, rename, reprint, cancellation, legacy recovery and authority hold');
  } finally {
    await prisma.tenantAreaGrant.deleteMany({where:{areaId:{in:areaIds}}});
    await prisma.areaAccessRequest.deleteMany({where:{areaId:{in:areaIds}}});
    await prisma.roomPlaqueRequest.deleteMany({where:{id:{in:orderIds}}});
    await prisma.idempotencyRecord.deleteMany({where:{namespace:{startsWith:'room-plaque:'},homeId}});
    await prisma.auditEvent.deleteMany({where:{targetId:{in:orderIds},targetType:'RoomPlaqueRequest'}});
    await prisma.areaQrCredential.deleteMany({where:{areaId:{in:areaIds}}});
    await prisma.area.deleteMany({where:{id:{in:areaIds}}});
    await prisma.home.update({where:{id:homeId},data:{addressLine1:home.addressLine1,addressLine2:home.addressLine2,city:home.city,region:home.region,postcode:home.postcode,country:home.country,authorityGeneration:home.authorityGeneration}});
    await prisma.employeeSession.deleteMany({where:{employeeId:{in:[employee.id,...employees]}}});await prisma.companyEmployeeAccount.deleteMany({where:{id:{in:[employee.id,...employees]}}});
  }
}
