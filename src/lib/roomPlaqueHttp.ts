import { NextResponse } from 'next/server';
import QRCode from 'qrcode';
import { requireCustomerSelectedHome } from './customerSelectedHome';
import { requireEmployee, Stage1AuthError, authErrorResponse } from './stage1Auth';
import { nativeV1ErrorResponse } from './contracts/nativeV1Error';
import { exact, object, revision, roomUuid, validatePlaqueOrder } from './contracts/roomQrPlaques';
import { roomTransaction, homeRoomQrMetadata, revealHomeRoomQr, createRoomPlaqueOrder, listRoomPlaqueOrders, transitionRoomPlaqueOrder, staffRoomPlaqueDetail, printRoomPlaqueOrder } from './roomPlaqueRequests';
import { enforcePersistentRateLimit } from './rateLimit';
import { PlatformDataEncryptionKeyError } from './platformDataEncryptionKey';

type Operation='library'|'reveal'|'customer-orders'|'create'|'cancel'|'staff-orders'|'detail'|'transition'|'print';
const headers={'Cache-Control':'no-store',Pragma:'no-cache'};
async function body(request:Request) {
  const reader=request.body?.getReader();if(!reader) throw new Stage1AuthError(400,'VALIDATION_FAILED','A request body is required');
  const chunks:Uint8Array[]=[];let size=0;
  try {while(true) {const part=await reader.read();if(part.done) break;size+=part.value.byteLength;if(size>24576) {await reader.cancel();throw new Stage1AuthError(413,'VALIDATION_FAILED','The request is too large');}chunks.push(part.value);}}
  finally {reader.releaseLock();}
  try {return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));} catch(error) {if(error instanceof Stage1AuthError) throw error;throw new Stage1AuthError(400,'VALIDATION_FAILED','The request is invalid');}
}
export async function roomPlaqueHttp(request:Request,params:Record<string,string>,operation:Operation) {
  params = params ?? {};
  const staff=['staff-orders','detail','transition','print'].includes(operation);
  try {
    const actor=staff?await requireEmployee(request,['CXO','SENIOR_OPERATIONS_MANAGER']):await requireCustomerSelectedHome(request);
    for(const value of Object.values(params)) if(!roomUuid.test(value)) throw new Stage1AuthError(404,'RESOURCE_NOT_FOUND');
    if(request.method==='POST'&&(staff||request.headers.has('cookie'))) {
      const expected=new URL(process.env.NEXT_PUBLIC_APP_URL||request.url).origin;
      if(request.headers.get('origin')!==expected) throw new Stage1AuthError(403,'SCOPE_DENIED','Use the signed-in Company Portal');
    }
    if(!staff&&(actor.kind!=='customer'||actor.homeId!==params.homeId||actor.credentialKind!=='account_access'||!['OWNER','PROPERTY_MANAGER'].includes(actor.role))) throw new Stage1AuthError(404,'RESOURCE_NOT_FOUND');
    // Existing durable account rate-limit helper; no background process or new scheduler.
    await enforcePersistentRateLimit(`room-plaque:${actor.id}:${request.method==='GET'?'read':'write'}`,request.method==='GET'?120:60,60000);
    const url=new URL(request.url),after=url.searchParams.get('after'),status=url.searchParams.get('status');
    if(after&&!roomUuid.test(after)||status&&!['REQUESTED','IN_PRODUCTION','DISPATCHED','COMPLETED','CANCELLED'].includes(status)) throw new Stage1AuthError(400,'VALIDATION_FAILED','Invalid request filter');
    const input=request.method==='POST'?await body(request):null;
    const key=request.headers.get('idempotency-key')||'';
    let result:unknown;
    if(actor.kind==='customer') {
      switch(operation) {
        case 'library':result=await roomTransaction(tx=>homeRoomQrMetadata(tx,actor,params.homeId));break;
        case 'reveal':exact(input!,['expectedGeneration']);result=await roomTransaction(tx=>revealHomeRoomQr(tx,actor,params.homeId,params.areaId,revision(input!.expectedGeneration)));break;
        case 'customer-orders':result=await roomTransaction(tx=>listRoomPlaqueOrders(tx,actor,params.homeId,after));break;
        case 'create': {const value=validatePlaqueOrder(input);result=await roomTransaction(tx=>createRoomPlaqueOrder(tx,actor,params.homeId,value,key));break;}
        case 'cancel':exact(input!,['expectedRevision']);result=await roomTransaction(tx=>transitionRoomPlaqueOrder(tx,actor,params.requestId,revision(input!.expectedRevision),'CANCEL',key,params.homeId));break;
        default:throw new Stage1AuthError(403,'SCOPE_DENIED');
      }
    } else {
      switch(operation) {
        case 'staff-orders':result=await roomTransaction(tx=>listRoomPlaqueOrders(tx,actor,null,after,status));break;
        case 'detail':result=await roomTransaction(tx=>staffRoomPlaqueDetail(tx,actor,params.requestId));break;
        case 'transition':exact(input!,['action','expectedRevision']);if(typeof input!.action!=='string'||!['START_PRODUCTION','DISPATCH','COMPLETE','CANCEL'].includes(input!.action)) throw new Stage1AuthError(400,'VALIDATION_FAILED');result=await roomTransaction(tx=>transitionRoomPlaqueOrder(tx,actor,params.requestId,revision(input!.expectedRevision),String(input!.action),key));break;
        case 'print': {
          exact(input!,['expectedRevision']);const bundle=await roomTransaction(tx=>printRoomPlaqueOrder(tx,actor,params.requestId,revision(input!.expectedRevision)));
          const plaques=await Promise.all(bundle.plaques.map(async plaque=>({areaId:plaque.areaId,roomLabel:plaque.roomLabel,roomLabelSnapshot:plaque.roomLabelSnapshot,generation:plaque.generation,
            image:await QRCode.toDataURL(plaque.reference,{errorCorrectionLevel:'H',margin:4,scale:8})})));
          result={schemaVersion:bundle.schemaVersion,contractVersion:1,requestReference:bundle.requestReference,plaques};break;
        }
        default:throw new Stage1AuthError(403,'SCOPE_DENIED');
      }
    }
    return NextResponse.json(result,{status:operation==='create'?201:200,headers});
  } catch(error) {
    const failure=error instanceof PlatformDataEncryptionKeyError
      ? new Stage1AuthError(503,'INTERNAL_ERROR','Secure Platform operations are temporarily unavailable')
      : error;
    return staff ? authErrorResponse(failure) : nativeV1ErrorResponse(failure);
  }
}
