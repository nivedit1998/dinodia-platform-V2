import { Stage1AuthError } from '../stage1Auth';
export const roomUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const roomReference = /^dno_room_[A-Za-z0-9_-]{40,64}$/;
export type PlaqueItem = { areaId: string; kind: 'FIRST_ISSUE'|'REPRINT'; expectedGeneration?: number };
export function invalid(message: string): never { throw new Stage1AuthError(400,'VALIDATION_FAILED',message); }
export function object(value: unknown): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('The request is invalid');
  return value as Record<string,unknown>;
}
export function exact(value: Record<string,unknown>, keys: string[]) {
  if(Object.keys(value).sort().join('|')!==keys.sort().join('|')) invalid('The request contains unsupported fields');
}
export function revision(value: unknown): number {
  if(!Number.isSafeInteger(value)||Number(value)<1) invalid('Refresh before trying again');
  return Number(value);
}
export function validatePlaqueOrder(value: unknown) {
  const body=object(value); exact(body,['contractVersion','items','notes','confirmRegisteredAddress']);
  if(body.contractVersion!==1||body.confirmRegisteredAddress!==true||!Array.isArray(body.items)||body.items.length<1||body.items.length>64) invalid('Choose 1–64 rooms and confirm the registered address');
  const seen=new Set<string>();
  const items=body.items.map(value=>{
    const item=object(value); const kind=item.kind;
    if(kind!=='FIRST_ISSUE'&&kind!=='REPRINT') invalid('Choose a plaque request type');
    exact(item,kind==='REPRINT'?['areaId','kind','expectedGeneration']:['areaId','kind']);
    if(typeof item.areaId!=='string'||!roomUuid.test(item.areaId)||seen.has(item.areaId)) invalid('Choose distinct rooms from this Home');
    seen.add(item.areaId);
    return {areaId:item.areaId,kind,...(kind==='REPRINT'?{expectedGeneration:revision(item.expectedGeneration)}:{})} as PlaqueItem;
  }).sort((a,b)=>a.areaId.localeCompare(b.areaId));
  if(typeof body.notes!=='string') invalid('The note is invalid');
  const notes=body.notes.normalize('NFC').trim();
  if(notes.length>1000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(notes)) invalid('Use a note of at most 1000 characters');
  return {items,notes};
}
export function validateStaffCancellationReason(value: unknown): string {
  if(typeof value!=='string') invalid('A staff cancellation reason is required');
  const reason=value.normalize('NFC').trim();
  if(!reason||reason.length>500||/[\u0000-\u001f\u007f]/u.test(reason)) invalid('Use a cancellation reason of 1–500 characters, without control characters');
  if(/dno_room_/iu.test(reason)) invalid('Do not include room QR references in a cancellation reason');
  return reason;
}
export function nextPlaqueStatus(status: string, action: string, actor: 'employee'|'customer' = 'customer') {
  // Explicit operations closure, never a rewind: preserve all production/dispatch timestamps.
  if(actor==='employee'&&action==='CANCEL'&&['IN_PRODUCTION','DISPATCHED'].includes(status)) return 'CANCELLED';
  const next:Record<string,Record<string,string>>={REQUESTED:{START_PRODUCTION:'IN_PRODUCTION',CANCEL:'CANCELLED'},IN_PRODUCTION:{DISPATCH:'DISPATCHED'},DISPATCHED:{COMPLETE:'COMPLETED'}};
  const value=next[status]?.[action];
  if(!value) throw new Stage1AuthError(409,'REVISION_CONFLICT','This plaque request cannot make that transition');
  return value as 'IN_PRODUCTION'|'DISPATCHED'|'COMPLETED'|'CANCELLED';
}
