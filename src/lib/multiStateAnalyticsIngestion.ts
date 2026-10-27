import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { Stage1AuthError } from './stage1Auth';
import { canonicalSyncJson, type HubSyncEvent } from './hubSyncEnvelope';
import { validMultiStateDailyPayload, multiStateDailyAggregateId } from './multiStateAnalyticsContract';
import { allowedAnalyticsControls } from './analyticsIntervals';
import { historyYearCutoff, historyDayExpiry, historyWeek } from './analyticsHistoryCalendar';

function reject(code: string): never { throw new Stage1AuthError(409, code, 'State analytics does not match its authorized writer'); }

/** Absolute revisions, never increments. Historical authority comes from the
 * retained epoch, not today's category or today's descriptor. */
export async function ingestMultiStateAnalytics(tx: Prisma.TransactionClient, input: {
  event: HubSyncEvent; homeId: string; hubInstallationId: string; identityGeneration?: number;
  streamId?: string; now: Date;
}) {
  const {event, homeId, hubInstallationId, now} = input, p = event.payload;
  if (!validMultiStateDailyPayload(p) || event.aggregateId !== multiStateDailyAggregateId(p)) reject('hub_sync_state_contract_invalid');
  await tx.$queryRaw`SELECT "hubInstallationId" FROM "NativeAnalyticsRetention" WHERE "hubInstallationId"=${hubInstallationId}::uuid FOR UPDATE`;
  const retention = await tx.nativeAnalyticsRetention.findUnique({where:{hubInstallationId}});
  const hub = await tx.hubInstallation.findUnique({where:{id:hubInstallationId},select:{homeId:true,analyticsWriterEnabled:true}});
  if (!retention || retention.homeId!==homeId || hub?.homeId!==homeId || !retention.writerEnabled || !hub.analyticsWriterEnabled
    || retention.writerFrom.toISOString()!==p.writerFrom || retention.timezone!==p.timezone || retention.writerFrom>now)
    reject('hub_sync_state_writer_invalid');
  if (!retention.barrierStreamId || !input.streamId || retention.barrierStreamId===input.streamId
    && BigInt(event.sequence)<=retention.barrierSequence!) reject('hub_sync_state_barrier_missing');
  const start=new Date(String(p.coverageStartAt)),end=new Date(String(p.coverageEndAt)),day=new Date(String(p.dayStartAt));
  if (end>now || p.closedAt && new Date(String(p.closedAt))>now || day.getTime()<historyYearCutoff(now.getTime(),retention.timezone)
    || p.sourceGeneration!==input.identityGeneration) reject('hub_sync_state_coverage_invalid');
  const device=await tx.nativeDevice.findUnique({where:{hubInstallationId_osDeviceId:{hubInstallationId,osDeviceId:String(p.osDeviceId)}}});
  if (!device || device.homeId!==homeId || device.managementClass!=='PROPERTY_DEVICE' || device.ownerMembershipId
    || ['REMOVAL_PENDING','REMOVED'].includes(device.lifecycle)) reject('hub_sync_state_device_invalid');
  await tx.$queryRaw`SELECT id FROM "NativeDevice" WHERE id=${device.id}::uuid FOR UPDATE`;
  const area=await tx.area.findUnique({where:{homeId_osAreaId:{homeId,osAreaId:String(p.osAreaId)}}});
  if (!area || area.status!=='ACTIVE') reject('hub_sync_state_area_invalid');
  const assignment=await tx.deviceAreaAssignment.findFirst({where:{homeId,deviceId:device.id,areaId:area.id,
    validFrom:{lte:start},OR:[{validUntil:null},{validUntil:{gte:end}}]}});
  if (!assignment || Date.parse(String(p.assignmentEpochAt))!==Math.max(Math.floor(assignment.validFrom.getTime()/1000)*1000,retention.writerFrom.getTime()))
    reject('hub_sync_state_assignment_invalid');
  const interval=await tx.nativeAnalyticsInterval.findFirst({where:{id:String(p.analyticsIntervalId),homeId,hubInstallationId,deviceId:device.id,
    revision:Number(p.bindingRevision),sourceGeneration:Number(p.sourceGeneration),analyticsPolicyVersion:4,validFrom:{lte:start},
    OR:[{validUntil:null},{validUntil:{gte:end}}]}});
  const controls=Array.isArray(interval?.authorizedControls)?interval.authorizedControls as Array<Record<string,unknown>>:[];
  if (!interval || String(interval.analyticsCategory)!==p.analyticsCategory
    || !allowedAnalyticsControls(String(p.analyticsCategory),controls,interval.selectedControlId).includes(String(p.controlId)))
    reject('hub_sync_state_authority_invalid');
  const id=event.aggregateId,digest=createHash('sha256').update(canonicalSyncJson(p)).digest('hex');
  const previous=(await tx.$queryRaw<Array<{revision:number;payloadDigest:string;coverageStartAt:Date;coverageEndAt:Date}>>`
    SELECT revision,"payloadDigest","coverageStartAt","coverageEndAt" FROM "NativeAnalyticsStateDay" WHERE id=${id} FOR UPDATE`)[0];
  if (previous && previous.revision>Number(p.revision)) return;
  if (previous?.revision===Number(p.revision)) { if(previous.payloadDigest!==digest) reject('hub_sync_state_revision_conflict'); return; }
  if (previous && (previous.coverageStartAt.getTime()!==start.getTime() || end<previous.coverageEndAt)) reject('hub_sync_state_coverage_regression');
  // Never reintroduce compacted hourly detail through a delayed revision.
  const hourly=day.getTime()<historyWeek(now.getTime(),retention.timezone).start?[]:p.hourly || [];
  const purgeAt=new Date(historyDayExpiry(day.getTime(),retention.timezone));
  await tx.$executeRaw`INSERT INTO "NativeAnalyticsStateDay"
    (id,"homeId","hubInstallationId","deviceId","areaId","analyticsCategory",dimension,"controlId","sourceGeneration","bindingRevision",
     "analyticsIntervalId","analyticsPolicyVersion",timezone,"writerFrom","dayStartAt","dayEndAt","assignmentEpochAt",revision,
     "coverageStartAt","coverageEndAt","closedAt","durationsSeconds",hourly,"payloadDigest","purgeAt")
    VALUES (${id},${homeId}::uuid,${hubInstallationId}::uuid,${device.id}::uuid,${area.id}::uuid,${String(p.analyticsCategory)},${String(p.dimension)},
      ${String(p.controlId)},${Number(p.sourceGeneration)},${Number(p.bindingRevision)},${String(p.analyticsIntervalId)}::uuid,4,${retention.timezone},
      ${retention.writerFrom},${day},${new Date(String(p.dayEndAt))},${new Date(String(p.assignmentEpochAt))},${Number(p.revision)},${start},${end},
      ${p.closedAt?new Date(String(p.closedAt)):null},${JSON.stringify(p.durationsSeconds)}::jsonb,${JSON.stringify(hourly)}::jsonb,${digest},${purgeAt})
    ON CONFLICT (id) DO UPDATE SET revision=EXCLUDED.revision,"coverageEndAt"=EXCLUDED."coverageEndAt","closedAt"=EXCLUDED."closedAt",
      "durationsSeconds"=EXCLUDED."durationsSeconds",hourly=EXCLUDED.hourly,"payloadDigest"=EXCLUDED."payloadDigest","updatedAt"=CURRENT_TIMESTAMP`;
}
