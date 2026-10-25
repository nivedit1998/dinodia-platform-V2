import { createHash } from 'node:crypto';
import { historyDay } from './analyticsHistoryCalendar';
export const DAILY_ANALYTICS_VERSION=1;
export const DAILY_PAYLOAD_KEYS=['osDeviceId','osAreaId','kind','analyticsCategory','controlId','sourceGeneration',
  'bindingRevision','analyticsIntervalId','analyticsPolicyVersion','timezone','writerFrom','dayStartAt','dayEndAt','assignmentEpochAt',
  'revision','onSeconds','offSeconds','unknownSeconds','knownMilliseconds','celsiusMilliseconds','minimumCelsius','maximumCelsius',
  'sampleCount','lastCelsius','lastObservedAt','lastValidUntil','coverageStartAt','coverageEndAt'];
const integer=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
const date=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const number=(v:unknown)=>typeof v==='number'&&Number.isFinite(v);
const text=(v:unknown,max:number)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
export function dailyAggregateId(p:Record<string,unknown>){
  return createHash('sha256').update([p.osDeviceId,p.osAreaId,p.kind,p.analyticsCategory,p.controlId,p.sourceGeneration,
    p.bindingRevision,p.assignmentEpochAt||'',Date.parse(String(p.dayStartAt))].join('|')).digest('hex');
}
export function validDailyPayload(p:Record<string,unknown>){
  if(Object.keys(p).sort().join('|')!==[...DAILY_PAYLOAD_KEYS].sort().join('|')
    ||!text(p.osDeviceId,160)||!text(p.osAreaId,160)||!text(p.controlId,160)||!['USAGE','TEMPERATURE'].includes(String(p.kind))
    ||!['LIGHT','RADIATOR','BOILER'].includes(String(p.analyticsCategory))||p.kind==='TEMPERATURE'&&p.analyticsCategory!=='RADIATOR'
    ||!integer(p.sourceGeneration)||Number(p.sourceGeneration)<1||!integer(p.bindingRevision)||!integer(p.revision)||Number(p.revision)<1
    ||![1,2,3].includes(Number(p.analyticsPolicyVersion))||!(p.analyticsIntervalId===null||/^[a-f0-9-]{36}$/i.test(String(p.analyticsIntervalId)))
    ||!['writerFrom','dayStartAt','dayEndAt','assignmentEpochAt','coverageStartAt','coverageEndAt'].every(k=>date(p[k]))
    ||!['onSeconds','offSeconds','unknownSeconds','knownMilliseconds','sampleCount'].every(k=>integer(p[k]))
    ||!number(p.celsiusMilliseconds)||Math.abs(Number(p.celsiusMilliseconds))>1e13)return false;
  try{const d=historyDay(Date.parse(String(p.dayStartAt)),String(p.timezone));
    if(d.start!==Date.parse(String(p.dayStartAt))||d.end!==Date.parse(String(p.dayEndAt)))return false;}catch{return false;}
  const start=Date.parse(String(p.coverageStartAt)),end=Date.parse(String(p.coverageEndAt));
  if(start<Math.max(Date.parse(String(p.dayStartAt)),Date.parse(String(p.writerFrom)),Date.parse(String(p.assignmentEpochAt)))
    ||end<=start||end>Date.parse(String(p.dayEndAt))||Date.parse(String(p.writerFrom))%3600000!==0)return false;
  if(p.kind==='USAGE')return Number(p.onSeconds)+Number(p.offSeconds)+Number(p.unknownSeconds)===(end-start)/1000
    &&p.knownMilliseconds===0&&p.celsiusMilliseconds===0&&p.minimumCelsius===null&&p.maximumCelsius===null
    &&p.lastCelsius===null&&p.lastObservedAt===null&&p.lastValidUntil===null&&p.sampleCount===0;
  return p.onSeconds===0&&p.offSeconds===0&&p.unknownSeconds===0&&Number(p.knownMilliseconds)>0&&Number(p.knownMilliseconds)<=end-start
    &&[p.minimumCelsius,p.maximumCelsius,p.lastCelsius].every(v=>number(v)&&Number(v)>=-50&&Number(v)<=80)
    &&Number(p.minimumCelsius)<=Number(p.maximumCelsius)&&date(p.lastObservedAt)&&date(p.lastValidUntil)
    &&Date.parse(String(p.lastValidUntil))>=Date.parse(String(p.lastObservedAt))
    &&Number(p.celsiusMilliseconds)>=Number(p.minimumCelsius)*Number(p.knownMilliseconds)-0.1
    &&Number(p.celsiusMilliseconds)<=Number(p.maximumCelsius)*Number(p.knownMilliseconds)+0.1;
}
