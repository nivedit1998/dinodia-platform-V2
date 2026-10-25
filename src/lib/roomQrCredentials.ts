import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma, type AreaQrCredential } from '@prisma/client';
import { encryptPlatformEnvelope, decryptPlatformEnvelope } from './hubOperatorCredentials';
import { sha256 } from './stage1Crypto';
import { Stage1AuthError } from './stage1Auth';
import { roomReference } from './contracts/roomQrPlaques';

export function readRoomQrPayload(row: AreaQrCredential, homeId: string): string {
  if(row.status!=='ACTIVE'||!row.encryptedPrintablePayload) throw new Stage1AuthError(409,'REVISION_CONFLICT','QR copy needs company assistance');
  try {
    const payload=JSON.parse(decryptPlatformEnvelope(JSON.stringify(row.encryptedPrintablePayload)));
    if(Object.keys(payload).sort().join('|')!==['version','purpose','homeId','areaId','credentialId','generation','reference'].sort().join('|')||
       payload.version!==1||payload.purpose!=='room-access-qr'||payload.homeId!==homeId||payload.areaId!==row.areaId||payload.credentialId!==row.id||
       payload.generation!==row.generation||typeof payload.reference!=='string'||!roomReference.test(payload.reference)||sha256(payload.reference)!==row.resolverHash) throw new Error('invalid');
    return payload.reference;
  } catch(error) {
    if(error && typeof error==='object' && 'failureCode' in error) throw error;
    throw new Stage1AuthError(409,'REVISION_CONFLICT','QR copy needs company assistance');
  }
}

export async function issueFirstRoomQr(tx: Prisma.TransactionClient, homeId: string, areaId: string) {
  const existing=await tx.areaQrCredential.findMany({where:{areaId},orderBy:{generation:'desc'}});
  if(existing.length) {
    const active=existing.filter(row=>row.status==='ACTIVE');
    if(active.length!==1) throw new Stage1AuthError(409,'REVISION_CONFLICT','Existing room QR needs company assistance');
    readRoomQrPayload(active[0],homeId);
    return active[0];
  }
  const id=randomUUID(),reference=`dno_room_${randomBytes(32).toString('base64url')}`;
  const envelope=encryptPlatformEnvelope(JSON.stringify({version:1,purpose:'room-access-qr',homeId,areaId,credentialId:id,generation:1,reference}));
  return tx.areaQrCredential.create({data:{id,areaId,generation:1,resolverHash:sha256(reference),encryptedPrintablePayload:envelope}});
}
