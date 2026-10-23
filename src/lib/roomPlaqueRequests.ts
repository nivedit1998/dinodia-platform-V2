import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { isRetryableSerializationConflict } from './serializableTransaction';
import { Stage1AuthError, type CustomerPrincipal, type EmployeePrincipal } from './stage1Auth';
import { sha256 } from './stage1Crypto';
import { encryptPlatformEnvelope } from './hubOperatorCredentials';
import { currentCustomerPolicy } from './customerPolicyConfig';
import { issueFirstRoomQr, readRoomQrPayload } from './roomQrCredentials';
import { nextPlaqueStatus, validateStaffCancellationReason, type PlaqueItem } from './contracts/roomQrPlaques';

type Tx=Prisma.TransactionClient;
type Actor=CustomerPrincipal|EmployeePrincipal;
export async function roomTransaction<T>(work:(tx:Tx)=>Promise<T>):Promise<T> {
  for(let attempt=0;attempt<3;attempt++) {
    try { return await prisma.$transaction(work,{isolationLevel:'Serializable',maxWait:5000,timeout:15000}); }
    catch(error) {
      const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
      const serializationConflict=isRetryableSerializationConflict(error);
      if((serializationConflict||code==='P2002')&&attempt<2) continue;
      if(code==='P2002') throw new Stage1AuthError(409,'REVISION_CONFLICT','A request for one of these rooms already exists. Refresh the requests.');
      // A concurrent transition can invalidate the serializable snapshot on
      // every bounded retry. It is a normal revision race, not an internal
      // server failure; never expose it as HTTP 500 to a duplicate operator
      // tap. The failed transaction has committed no QR or status change.
      if(serializationConflict) throw new Stage1AuthError(409,'REVISION_CONFLICT','This request changed while you were updating it. Refresh the request.');
      throw error;
    }
  }
  throw new Stage1AuthError(409,'REVISION_CONFLICT','Refresh before trying again');
}

export async function assertRoomCustomer(tx:Tx,p:CustomerPrincipal,homeId:string) {
  if(p.homeId!==homeId||p.credentialKind!=='account_access'||!['OWNER','PROPERTY_MANAGER'].includes(p.role)) throw new Stage1AuthError(404,'RESOURCE_NOT_FOUND','Room QR codes are unavailable for this Home');
  await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id"=${homeId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id"=${p.id}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "id"=${p.sessionId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "TrustedDevice" WHERE "id"=${p.trustedDeviceId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "HomeMembership" WHERE "id"=${p.membershipId}::uuid FOR UPDATE`;
  const now=new Date();
  const session=await tx.customerSession.findUnique({where:{id:p.sessionId},include:{customerAccount:true,trustedDevice:true}});
  if(!session||session.customerAccountId!==p.id||session.trustedDeviceId!==p.trustedDeviceId||session.accessTokenHash!==p.tokenHash||
    !session.accessTokenExpiresAt||session.accessTokenExpiresAt<=now||session.revokedAt||session.expiresAt<=now||session.absoluteExpiresAt<=now||
    session.customerAccount.status!=='ACTIVE'||!session.customerAccount.emailVerifiedAt||session.customerAccount.mustChangePassword||session.customerAccount.usernameSelectionRequired||session.customerAccount.securityVersion!==session.securityVersion||
    session.trustedDevice.revokedAt||session.trustedDevice.customerAccountId!==p.id||session.trustedDevice.sessionVersion!==session.trustedDeviceSessionVersion) throw new Stage1AuthError(401,'customer_session_invalid','Sign in again to view room codes');
  const policy=currentCustomerPolicy();
  if(!policy||!await tx.policyAcceptance.findUnique({where:{customerAccountId_policyKind_policyVersion:{customerAccountId:p.id,policyKind:'DINODIA_NATIVE',policyVersion:policy.version}}})) throw new Stage1AuthError(403,'customer_policy_acceptance_required','Accept the current Dinodia policy');
  const membership=await tx.homeMembership.findFirst({where:{id:p.membershipId,homeId,customerAccountId:p.id,status:'ACTIVE',role:p.role},include:{home:true}});
  if(!membership||membership.home.lifecycle!=='ACTIVE'||membership.home.installationStatus!=='COMPLETE') throw new Stage1AuthError(404,'RESOURCE_NOT_FOUND','Room QR codes are unavailable for this Home');
  return membership.home;
}
async function assertRoomEmployee(tx:Tx,p:EmployeePrincipal) {
  await tx.$queryRaw`SELECT "id" FROM "CompanyEmployeeAccount" WHERE "id"=${p.id}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "EmployeeSession" WHERE "id"=${p.sessionId}::uuid FOR UPDATE`;
  const employee=await tx.companyEmployeeAccount.findUnique({where:{id:p.id}});
  const session=await tx.employeeSession.findUnique({where:{id:p.sessionId}});
  if(!employee||employee.status!=='ACTIVE'||!['CXO','SENIOR_OPERATIONS_MANAGER'].includes(employee.role)||employee.role!==p.role||
    !session||session.employeeId!==p.id||session.status!=='ACTIVE'||session.tokenHash!==p.tokenHash||session.expiresAt<=new Date()||p.expiresAt<=Date.now()) throw new Stage1AuthError(403,'SCOPE_DENIED','Operations permission is required');
}
function address(home:{addressLine1:string|null;addressLine2:string|null;city:string|null;region:string|null;postcode:string|null;country:string|null}) {
  return [home.addressLine1,home.addressLine2,home.city,home.region,home.postcode,home.country].map(v=>v?.trim()||'');
}
const orderInclude={items:{include:{area:true}}} satisfies Prisma.RoomPlaqueRequestInclude;
type Order=Prisma.RoomPlaqueRequestGetPayload<{include:typeof orderInclude}>;
function orderReceipt(row:Order) {
  return {id:row.id,reference:row.publicReference,status:row.status,revision:row.revision,createdAt:row.createdAt.toISOString(),
    productionStartedAt:row.productionStartedAt?.toISOString()??null,dispatchedAt:row.dispatchedAt?.toISOString()??null,completedAt:row.completedAt?.toISOString()??null,cancelledAt:row.cancelledAt?.toISOString()??null,
    canCancel:row.status==='REQUESTED',notes:row.notes,items:row.items.map(item=>({areaId:item.areaId,kind:item.kind,roomLabel:item.area.overrideName||item.area.originalName,roomLabelSnapshot:item.roomLabelSnapshot,generation:item.credentialGeneration,areaActive:item.area.status==='ACTIVE'}))};
}
async function audit(tx:Tx,p:Actor,homeId:string,id:string,action:string,details:Prisma.InputJsonObject={}) {
  await tx.auditEvent.create({data:{homeId,actorType:p.kind==='employee'?'EMPLOYEE':'CUSTOMER',actorId:p.id,category:'ACCESS',action:`room_plaque_${action}`,targetType:'RoomPlaqueRequest',targetId:id,metadata:{outcome:'committed',...details},purgeAt:new Date(Date.now()+365*86400000)}});
}
async function replay(tx:Tx,p:Actor,namespace:string,key:string,body:unknown) {
  if(!/^[A-Za-z0-9._:-]{16,160}$/.test(key)) throw new Stage1AuthError(400,'VALIDATION_FAILED','A request key is required');
  const keyHash=sha256(`${p.id}:${key}`),requestHash=sha256(JSON.stringify(body));
  const row=await tx.idempotencyRecord.findUnique({where:{namespace_keyHash:{namespace,keyHash}}});
  if(row&&(row.actorId!==p.id||row.requestHash!==requestHash||row.expiresAt<=new Date()||!row.responseBody)) throw new Stage1AuthError(409,'IDEMPOTENCY_CONFLICT','This request key was already used');
  return {keyHash,requestHash,saved:row?.responseBody};
}
async function remember(tx:Tx,p:Actor,homeId:string,namespace:string,record:{keyHash:string;requestHash:string},body:unknown) {
  await tx.idempotencyRecord.create({data:{namespace,keyHash:record.keyHash,requestHash:record.requestHash,actorId:p.id,homeId,responseStatus:200,responseBody:body as Prisma.InputJsonValue,responseDigest:sha256(JSON.stringify(body)),expiresAt:new Date(Date.now()+86400000)}});
}
export async function homeRoomQrMetadata(tx:Tx,p:CustomerPrincipal,homeId:string) {
  const home=await assertRoomCustomer(tx,p,homeId);
  const areas=await tx.area.findMany({where:{homeId,status:'ACTIVE'},orderBy:[{createdAt:'asc'},{id:'asc'}],take:65,include:{qrCredentials:true,plaqueItems:{where:{closedAt:null},include:{request:true}}}});
  if(areas.length>64) throw new Stage1AuthError(409,'REVISION_CONFLICT','This Home has more rooms than the supported library limit. Contact operations.');
  return {schemaVersion:'dinodia.v1',contractVersion:1,homeId,address:address(home).filter(Boolean).join(', '),rooms:areas.map(area=>{
    const active=area.qrCredentials.filter(row=>row.status==='ACTIVE');
    let codeState=area.qrCredentials.length?'RECOVERY_REQUIRED':'NOT_ISSUED';
    if(active.length===1) {try {readRoomQrPayload(active[0],homeId);codeState='ISSUED';} catch(error) {if(!(error instanceof Stage1AuthError)) throw error;}}
    const open=area.plaqueItems[0]?.request;
    return {areaId:area.id,displayName:area.overrideName||area.originalName,originalName:area.originalName,codeState,generation:active.length===1?active[0].generation:null,
      canReveal:codeState==='ISSUED',canRequestPlaque:!open&&['ISSUED','NOT_ISSUED'].includes(codeState),openRequest:open?{id:open.id,reference:open.publicReference,status:open.status}:null};
  }),nextCursor:null};
}
export async function revealHomeRoomQr(tx:Tx,p:CustomerPrincipal,homeId:string,areaId:string,expectedGeneration:number) {
  await assertRoomCustomer(tx,p,homeId);
  const area=await tx.area.findFirst({where:{id:areaId,homeId,status:'ACTIVE'},include:{qrCredentials:{where:{status:'ACTIVE'}}}});
  if(!area) throw new Stage1AuthError(404,'RESOURCE_NOT_FOUND','This room is unavailable');
  const row=area.qrCredentials;
  if(row.length!==1||row[0].generation!==expectedGeneration) throw new Stage1AuthError(409,'REVISION_CONFLICT','This Room QR changed. Refresh the room list.');
  return {schemaVersion:'dinodia.v1',contractVersion:1,homeId,areaId,generation:row[0].generation,reference:readRoomQrPayload(row[0],homeId)};
}
export async function createRoomPlaqueOrder(tx:Tx,p:CustomerPrincipal,homeId:string,input:{items:PlaqueItem[];notes:string},key:string) {
  const home=await assertRoomCustomer(tx,p,homeId);
  const namespace='room-plaque:create:v1',record=await replay(tx,p,namespace,key,{homeId,...input});
  if(record.saved) return record.saved;
  const lines=[];
  for(const item of input.items) {
    await tx.$queryRaw`SELECT "id" FROM "Area" WHERE "id"=${item.areaId}::uuid FOR UPDATE`;
    const area=await tx.area.findFirst({where:{id:item.areaId,homeId,status:'ACTIVE'},include:{qrCredentials:true}});
    if(!area) throw new Stage1AuthError(400,'VALIDATION_FAILED','Choose current rooms from this Home');
    const open=await tx.roomPlaqueRequestItem.findFirst({where:{areaId:item.areaId,closedAt:null},include:{request:true}});
    if(open) throw new Stage1AuthError(409,'REVISION_CONFLICT',`A plaque request already exists: ${open.request.publicReference}`);
    let credential=null;
    if(item.kind==='FIRST_ISSUE') {
      if(area.qrCredentials.length) throw new Stage1AuthError(409,'REVISION_CONFLICT','This room already has QR history. Refresh or contact company assistance.');
    } else {
      const active=area.qrCredentials.filter(row=>row.status==='ACTIVE');
      if(active.length!==1||active[0].generation!==item.expectedGeneration) throw new Stage1AuthError(409,'REVISION_CONFLICT','This room QR changed. Refresh before ordering.');
      credential=active[0];readRoomQrPayload(credential,homeId);
    }
    lines.push({areaId:item.areaId,kind:item.kind,roomLabelSnapshot:area.overrideName||area.originalName,credentialId:credential?.id??null,credentialGeneration:credential?.generation??null});
  }
  const row=await tx.roomPlaqueRequest.create({data:{homeId,publicReference:`PLQ-${randomBytes(8).toString('hex').toUpperCase()}`,requesterAccountId:p.id,requesterMembershipId:p.membershipId,requesterRole:p.role,authorityGeneration:home.authorityGeneration,
    addressFingerprint:sha256(JSON.stringify(address(home))),encryptedAddress:encryptPlatformEnvelope(JSON.stringify(address(home))),notes:input.notes,items:{create:lines}},include:orderInclude});
  const result={schemaVersion:'dinodia.v1',contractVersion:1,request:orderReceipt(row)};
  await audit(tx,p,homeId,row.id,'requested');await remember(tx,p,homeId,namespace,record,result);return result;
}
export async function listRoomPlaqueOrders(tx:Tx,p:Actor,homeId:string|null,after:string|null,status:string|null=null) {
  if(p.kind==='customer') await assertRoomCustomer(tx,p,homeId!);else await assertRoomEmployee(tx,p);
  const rows=await tx.roomPlaqueRequest.findMany({where:{...(homeId?{homeId}:{}),...(status?{status:status as Prisma.EnumRoomPlaqueStatusFilter}: {})},include:orderInclude,
    orderBy:[{createdAt:'desc'},{id:'desc'}],take:51,...(after?{cursor:{id:after},skip:1}:{})});
  return {schemaVersion:'dinodia.v1',contractVersion:1,requests:rows.slice(0,50).map(row=>({...orderReceipt(row),...(p.kind==='employee'?{homeId:row.homeId}: {})})),nextCursor:rows.length>50?rows[49].id:null};
}
async function currentOrder(tx:Tx,id:string) {
  await tx.$queryRaw`SELECT "id" FROM "RoomPlaqueRequest" WHERE "id"=${id}::uuid FOR UPDATE`;
  const row=await tx.roomPlaqueRequest.findUnique({where:{id},include:orderInclude});
  if(!row) throw new Stage1AuthError(404,'RESOURCE_NOT_FOUND','This plaque request is unavailable');
  return row;
}
async function fulfilmentHome(tx:Tx,row:Order) {
  await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id"=${row.homeId}::uuid FOR UPDATE`;
  const home=await tx.home.findUnique({where:{id:row.homeId}});
  const member=row.requesterMembershipId?await tx.homeMembership.findFirst({where:{id:row.requesterMembershipId,customerAccountId:row.requesterAccountId!,homeId:row.homeId,status:'ACTIVE',role:{in:['OWNER','PROPERTY_MANAGER']}},include:{customerAccount:true}}):null;
  if(!home||home.lifecycle!=='ACTIVE'||home.installationStatus!=='COMPLETE'||home.authorityGeneration!==row.authorityGeneration||!member||member.customerAccount.status!=='ACTIVE'||member.role!==row.requesterRole) throw new Stage1AuthError(409,'REVISION_CONFLICT','Fulfilment is held because Home authority changed');
  if(!home.addressLine1||!home.city||!home.postcode||!home.country||sha256(JSON.stringify(address(home)))!==row.addressFingerprint) throw new Stage1AuthError(409,'REVISION_CONFLICT','Fulfilment details required: confirm the current registered address with the homeowner');
  return home;
}
export async function transitionRoomPlaqueOrder(tx:Tx,p:Actor,requestId:string,expectedRevision:number,action:string,key:string,homeId?:string,cancellationReason?:unknown) {
  if(p.kind==='customer') {await assertRoomCustomer(tx,p,homeId!);if(action!=='CANCEL') throw new Stage1AuthError(403,'SCOPE_DENIED');} else await assertRoomEmployee(tx,p);
  const row=await currentOrder(tx,requestId);
  if(p.kind==='customer'&&row.homeId!==homeId) throw new Stage1AuthError(404,'RESOURCE_NOT_FOUND');
  const reason=p.kind==='employee'&&action==='CANCEL'?validateStaffCancellationReason(cancellationReason):undefined;
  const namespace='room-plaque:transition:v1',record=await replay(tx,p,namespace,key,{requestId,expectedRevision,action,homeId:homeId??null,...(reason?{reason}: {})});
  if(record.saved) return record.saved;
  if(row.revision!==expectedRevision) throw new Stage1AuthError(409,'REVISION_CONFLICT','This request changed. Refresh its status.');
  const status=nextPlaqueStatus(row.status,action,p.kind);
  if(action!=='CANCEL') {
    await fulfilmentHome(tx,row);
    for(const item of [...row.items].sort((a,b)=>a.areaId.localeCompare(b.areaId))) {
      await tx.$queryRaw`SELECT "id" FROM "Area" WHERE "id"=${item.areaId}::uuid FOR UPDATE`;
      const area=await tx.area.findFirst({where:{id:item.areaId,homeId:row.homeId,status:'ACTIVE'}});
      if(!area) throw new Stage1AuthError(409,'REVISION_CONFLICT','A room in this request is no longer active');
      if(action==='START_PRODUCTION'&&item.kind==='FIRST_ISSUE') {
        const qr=await issueFirstRoomQr(tx,row.homeId,item.areaId);
        await tx.roomPlaqueRequestItem.update({where:{id:item.id},data:{credentialId:qr.id,credentialGeneration:qr.generation}});
      } else {
        const qr=item.credentialId?await tx.areaQrCredential.findFirst({where:{id:item.credentialId,areaId:item.areaId,status:'ACTIVE',generation:item.credentialGeneration!}}):null;
        if(!qr) throw new Stage1AuthError(409,'REVISION_CONFLICT','A room QR changed. Contact company assistance.');
        readRoomQrPayload(qr,row.homeId);
      }
    }
  }
  const now=new Date();
  const updated=await tx.roomPlaqueRequest.update({where:{id:requestId},data:{status,revision:{increment:1},...(status==='IN_PRODUCTION'?{productionStartedAt:now}:status==='DISPATCHED'?{dispatchedAt:now}:status==='COMPLETED'?{completedAt:now}:{cancelledAt:now})},include:orderInclude});
  if(['CANCELLED','COMPLETED'].includes(status)) await tx.roomPlaqueRequestItem.updateMany({where:{requestId},data:{closedAt:now}});
  const result={schemaVersion:'dinodia.v1',contractVersion:1,request:orderReceipt(updated)};
  await audit(tx,p,row.homeId,row.id,action.toLowerCase(),reason?{reason,previousStatus:row.status,physicalWorkMayExist:row.status!=='REQUESTED'}:{});await remember(tx,p,row.homeId,namespace,record,result);return result;
}
export async function staffRoomPlaqueDetail(tx:Tx,p:EmployeePrincipal,requestId:string) {
  await assertRoomEmployee(tx,p);const row=await currentOrder(tx,requestId);
  const home=await tx.home.findUniqueOrThrow({where:{id:row.homeId}});
  let blockedReason:string|null=null;try {await fulfilmentHome(tx,row);} catch(error) {if(error instanceof Stage1AuthError) blockedReason=error.message;else throw error;}
  return {schemaVersion:'dinodia.v1',contractVersion:1,request:{...orderReceipt(row),homeId:row.homeId,address:address(home).filter(Boolean).join(', '),blockedReason}};
}
export async function printRoomPlaqueOrder(tx:Tx,p:EmployeePrincipal,requestId:string,expectedRevision:number) {
  await assertRoomEmployee(tx,p);const row=await currentOrder(tx,requestId);await fulfilmentHome(tx,row);
  if(row.revision!==expectedRevision||!['IN_PRODUCTION','DISPATCHED','COMPLETED'].includes(row.status)) throw new Stage1AuthError(409,'REVISION_CONFLICT','Refresh this request before printing');
  const plaques=[];
  for(const item of row.items) {
    const qr=item.credentialId?await tx.areaQrCredential.findFirst({where:{id:item.credentialId,areaId:item.areaId,status:'ACTIVE',generation:item.credentialGeneration!}}):null;
    if(!qr||item.area.status!=='ACTIVE'||item.area.homeId!==row.homeId) throw new Stage1AuthError(409,'REVISION_CONFLICT','A room or code changed. Refresh before printing.');
    plaques.push({areaId:item.areaId,roomLabel:item.area.overrideName||item.area.originalName,roomLabelSnapshot:item.roomLabelSnapshot,reference:readRoomQrPayload(qr,row.homeId),generation:qr.generation});
  }
  return {schemaVersion:'dinodia.v1',contractVersion:1,requestReference:row.publicReference,plaques};
}
