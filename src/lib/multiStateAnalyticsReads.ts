import {prisma} from './prisma';
import {Stage1AuthError} from './stage1Auth';
import {MULTISTATE_STATES} from './multiStateAnalyticsContract';
import {parseAnalyticsWindow,usagePeriod,type NativeAnalyticsLevel} from './nativeAnalytics';
import {historyWeek,historyYearCutoff} from './analyticsHistoryCalendar';
import {parseUuidList,ANALYTICS_MAX_ROWS,ANALYTICS_MAX_DEVICES,ANALYTICS_MAX_AREAS} from './nativeAnalyticsAccess';

type Row={deviceId:string;areaId:string;dayStartAt:Date;dayEndAt:Date;coverageStartAt:Date;coverageEndAt:Date;
  durationsSeconds:Record<string,number>;hourly:Array<{hourStartAt:string;coverageStartAt:string;coverageEndAt:string;durationsSeconds:Record<string,number>}>};
export async function readStateAnalyticsCategories(homeId:string){
 const [schema]=await prisma.$queryRaw<Array<{available:boolean}>>`SELECT to_regclass('public."NativeAnalyticsStateDay"') IS NOT NULL AS available`;
 if(!schema?.available)return [];
 const rows=await prisma.$queryRaw<Array<{category:string}>>`SELECT DISTINCT d."analyticsCategory"::text AS category
  FROM "NativeDevice" d WHERE d."homeId"=${homeId}::uuid AND d."managementClass"='PROPERTY_DEVICE' AND d."ownerMembershipId" IS NULL
  AND d.lifecycle IN ('INSTALLED','VIEW_ONLY') AND d."analyticsCategory"::text IN ('SOCKET','TV','BLIND','AC','WASHING_MACHINE')
  AND EXISTS(SELECT 1 FROM "DeviceAreaAssignment" a JOIN "Area" room ON room.id=a."areaId" AND room.status='ACTIVE'
    WHERE a."deviceId"=d.id AND a."homeId"=${homeId}::uuid AND a."validUntil" IS NULL)
  UNION SELECT DISTINCT i."analyticsCategory"::text AS category FROM "NativeAnalyticsInterval" i
  JOIN "NativeDevice" d ON d.id=i."deviceId" AND d."homeId"=i."homeId"
  WHERE i."homeId"=${homeId}::uuid AND (i."validUntil" IS NULL OR i."validUntil">CURRENT_TIMESTAMP-interval '1 year')
    AND i."analyticsCategory"::text IN ('SOCKET','TV','BLIND','AC','WASHING_MACHINE') AND d."managementClass"='PROPERTY_DEVICE'
    AND d."ownerMembershipId" IS NULL AND d.lifecycle NOT IN ('REMOVED','REMOVAL_PENDING')`;
 return rows.map(r=>r.category.toLowerCase()).filter(c=>Object.hasOwn(MULTISTATE_STATES,c.toUpperCase())).sort();
}
/** Same denominator as existing analytics: hours sum device time; larger
 * periods average contributing device-days. Unknown stays a distinct state. */
export function aggregateStateDays(rows:Row[],category:keyof typeof MULTISTATE_STATES,level:NativeAnalyticsLevel,timezone:string,from:number,to:number){
 const states=MULTISTATE_STATES[category].states;
 const buckets=new Map<string,{id:string;start:string;end:string;label:string;durationsSeconds:Record<string,number>;contributors:Set<string>;coverageSeconds:number}>();
 for(const row of rows){
  const fragments=level==='hour'?row.hourly.map(h=>({at:new Date(h.hourStartAt),start:Date.parse(h.coverageStartAt),end:Date.parse(h.coverageEndAt),durations:h.durationsSeconds}))
   :[{at:row.dayStartAt,start:row.coverageStartAt.getTime(),end:row.coverageEndAt.getTime(),durations:row.durationsSeconds}];
  for(const f of fragments){
   // An absolute aggregate cannot be proportionally sliced at an arbitrary boundary.
   if(f.start<from||f.end>to||f.end<=f.start)continue;
   const period=usagePeriod({deviceId:row.deviceId,areaId:row.areaId,bucketStart:f.at,closedAt:null,onSeconds:0,offSeconds:0,unknownSeconds:0},level,timezone);
   let b=buckets.get(period.key);if(!b){b={id:period.key,start:period.start,end:period.end,label:period.label,durationsSeconds:Object.fromEntries(states.map(s=>[s,0])),contributors:new Set(),coverageSeconds:0};buckets.set(period.key,b);}
   for(const s of states)b.durationsSeconds[s]+=Number(f.durations[s]||0);
   b.coverageSeconds+=(f.end-f.start)/1000;b.contributors.add(`${row.deviceId}|${row.dayStartAt.toISOString()}`);
  }
 }
 return [...buckets.values()].sort((a,b)=>a.start.localeCompare(b.start)).map(({contributors,...b})=>({...b,contributingDeviceDays:contributors.size,
   durationsSeconds:Object.fromEntries(states.map(s=>[s,b.durationsSeconds[s]/(level==='hour'?1:contributors.size)])),
   coverageSeconds:b.coverageSeconds/(level==='hour'?1:contributors.size)}));
}
export async function readMultiStateAnalytics(homeId:string,timezone:string,search:URLSearchParams,now=new Date()){
 const category=String(search.get('category')||'').toUpperCase();
 if(!Object.hasOwn(MULTISTATE_STATES,category))throw new Stage1AuthError(400,'VALIDATION_FAILED','Choose a supported state category');
 const level=String(search.get('level')||'day') as NativeAnalyticsLevel;
 if(!['hour','day','week','month','year'].includes(level))throw new Stage1AuthError(400,'VALIDATION_FAILED','Choose a supported interval');
 const window=parseAnalyticsWindow({from:search.get('from'),to:search.get('to')},now);
 const areas=parseUuidList(search.get('areaIds'),ANALYTICS_MAX_AREAS,'Area'),devices=parseUuidList(search.get('deviceIds'),ANALYTICS_MAX_DEVICES,'device');
 const from=Math.max(window.from.getTime(),historyYearCutoff(now.getTime(),timezone));
 if(level==='hour'&&from<historyWeek(now.getTime(),timezone).start)throw new Stage1AuthError(409,'hourly_history_compacted','Hourly detail is available for the current calendar week only');
 const [schema]=await prisma.$queryRaw<Array<{available:boolean}>>`SELECT to_regclass('public."NativeAnalyticsStateDay"') IS NOT NULL AS available`;
 const rows=schema?.available?await prisma.$queryRaw<Row[]>`SELECT s."deviceId",s."areaId",s."dayStartAt",s."dayEndAt",s."coverageStartAt",s."coverageEndAt",s."durationsSeconds",s.hourly
  FROM "NativeAnalyticsStateDay" s JOIN "NativeDevice" d ON d.id=s."deviceId" AND d."homeId"=s."homeId"
  JOIN "Area" a ON a.id=s."areaId" AND a."homeId"=s."homeId"
  WHERE s."homeId"=${homeId}::uuid AND s."analyticsCategory"=${category} AND s."purgeAt">${now}
   AND d."managementClass"='PROPERTY_DEVICE' AND d."ownerMembershipId" IS NULL AND d.lifecycle NOT IN ('REMOVED','REMOVAL_PENDING')
   AND a.status='ACTIVE' AND s."coverageEndAt">${new Date(from)} AND s."coverageStartAt"<${window.to}
   AND (${areas===null} OR s."areaId" IN(SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(areas||[])}::jsonb)))
   AND (${devices===null} OR s."deviceId" IN(SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(devices||[])}::jsonb)))
  ORDER BY s."dayStartAt",s.id LIMIT ${ANALYTICS_MAX_ROWS+1}`:[];
 const unallocated=schema?.available?await prisma.$queryRaw<Array<{present:boolean}>>`SELECT EXISTS(
  SELECT 1 FROM "NativeAnalyticsUnallocated" u JOIN "NativeDevice" d ON d.id=u."deviceId" AND d."homeId"=u."homeId"
  WHERE u."homeId"=${homeId}::uuid AND u."analyticsCategory"::text=${category} AND u."purgeAt">${now}
    AND u."coverageStartAt"<${window.to} AND u."coverageEndAt">${new Date(from)}
    AND d."managementClass"='PROPERTY_DEVICE' AND d."ownerMembershipId" IS NULL
    AND (${areas===null} OR u."areaId" IN(SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(areas||[])}::jsonb)))
    AND (${devices===null} OR u."deviceId" IN(SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(devices||[])}::jsonb)))
 ) AS present`:[];
 if(rows.length>ANALYTICS_MAX_ROWS)throw new Stage1AuthError(413,'VALIDATION_FAILED','Choose a shorter history period');
 const policy=MULTISTATE_STATES[category as keyof typeof MULTISTATE_STATES];
 return {contractVersion:1,ok:true,homeId,category:category.toLowerCase(),dimension:policy.dimension,states:policy.states,level,timezone,
  from:new Date(from).toISOString(),to:window.to.toISOString(),generatedAt:now.toISOString(),unallocatedHistory:unallocated[0]?.present===true,
  aggregation:level==='hour'?'sum_device_seconds':'mean_contributing_device_day_seconds',
  buckets:aggregateStateDays(rows,category as keyof typeof MULTISTATE_STATES,level,timezone,from,window.to.getTime())};
}
