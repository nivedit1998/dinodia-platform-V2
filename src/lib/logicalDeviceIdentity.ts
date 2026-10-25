import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { Stage1AuthError } from './stage1Auth';

type Tx = Prisma.TransactionClient;
export type LogicalBinding = {
  physicalDeviceId: string;
  channelKey: string;
  channelGeneration: number;
  mappingRevision: number;
  manifestDigest: string;
  sourceDigest: string;
  sourceEntityIds: string[];
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function logicalOsId(physicalId: string, channelKey: string, generation = 1) {
  return `logical:v1:${hash([physicalId, channelKey, generation])}`;
}

export function validateLogicalBindings(physicalId: string, bindings: LogicalBinding[]) {
  const seenChannels = new Set<string>(), seenSources = new Set<string>();
  if (typeof physicalId !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(physicalId)
    || !Array.isArray(bindings) || bindings.length < 1 || bindings.length > 32) return false;
  return bindings.every(binding => {
    if (!binding || Object.keys(binding).sort().join('|') !== ['physicalDeviceId', 'channelKey', 'channelGeneration', 'mappingRevision', 'manifestDigest', 'sourceDigest', 'sourceEntityIds'].sort().join('|')
      || binding.physicalDeviceId !== physicalId
      || typeof binding.channelKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(binding.channelKey)
      || seenChannels.has(binding.channelKey) || !Number.isSafeInteger(binding.channelGeneration) || binding.channelGeneration < 1
      || !Number.isSafeInteger(binding.mappingRevision) || binding.mappingRevision < 1
      || !/^[a-f0-9]{64}$/.test(binding.manifestDigest) || !/^[a-f0-9]{64}$/.test(binding.sourceDigest)
      || !Array.isArray(binding.sourceEntityIds) || binding.sourceEntityIds.length < 1 || binding.sourceEntityIds.length > 256
      || bindings[0].manifestDigest !== binding.manifestDigest) return false;
    seenChannels.add(binding.channelKey);
    return binding.sourceEntityIds.every(id => {
      if (typeof id !== 'string' || id.length > 160 || !id.startsWith(`${physicalId}:`) || seenSources.has(id)) return false;
      seenSources.add(id); return seenSources.size <= 256;
    });
  });
}

/** Call inside an already authorized serializable commissioning/conversion transaction. */
export async function bindLogicalChildren(tx: Tx, input: {
  homeId: string; hubInstallationId: string; physicalId: string; protocol: string;
  protocolIdentityHash: string; managementClass: 'PROPERTY_DEVICE' | 'TENANT_DEVICE';
  ownerMembershipId: string | null; children: Array<{ deviceId: string; osDeviceId: string; binding: LogicalBinding }>;
}) {
  if (!validateLogicalBindings(input.physicalId, input.children.map(child => child.binding))
    || !/^[a-f0-9]{64}$/.test(input.protocolIdentityHash)
    || input.children.some(child => child.osDeviceId !== logicalOsId(input.physicalId, child.binding.channelKey, child.binding.channelGeneration))) {
    throw new Stage1AuthError(409, 'logical_binding_invalid', 'The channel identity is invalid');
  }
  const manifestDigest = input.children[0].binding.manifestDigest;
  const parents = await tx.$queryRaw<Array<{ id: string; managementClass: string; ownerMembershipId: string | null; homeId: string;
    protocol: string; protocolIdentityHash: string; manifestDigest: string; lifecycle: string }>>`
    INSERT INTO "NativePhysicalDevice" ("id", "homeId", "hubInstallationId", "osPhysicalDeviceId",
      "managementClass", "ownerMembershipId", "protocol", "protocolIdentityHash", "manifestDigest", "updatedAt")
    VALUES (gen_random_uuid(), ${input.homeId}::uuid, ${input.hubInstallationId}::uuid, ${input.physicalId},
      ${input.managementClass}::"DeviceManagementClass", ${input.ownerMembershipId}::uuid,
      ${input.protocol}, ${input.protocolIdentityHash}, ${manifestDigest}, CURRENT_TIMESTAMP)
    ON CONFLICT ("hubInstallationId", "osPhysicalDeviceId", "pairingGeneration") DO UPDATE
      SET "updatedAt" = "NativePhysicalDevice"."updatedAt"
    RETURNING "id", "managementClass", "ownerMembershipId", "homeId", "protocol", "protocolIdentityHash", "manifestDigest", "lifecycle"`;
  const parent = parents[0];
  if (!parent || parent.homeId !== input.homeId || parent.managementClass !== input.managementClass
    || parent.ownerMembershipId !== input.ownerMembershipId || parent.lifecycle !== 'ACTIVE'
    || parent.protocol !== input.protocol || parent.protocolIdentityHash !== input.protocolIdentityHash
    || parent.manifestDigest !== manifestDigest) throw new Stage1AuthError(409, 'logical_parent_owner_conflict', 'The physical device identity, mapping or ownership changed');
  for (const child of input.children) {
    const binding = child.binding;
    const changed = await tx.$executeRaw`UPDATE "NativeDevice" SET "physicalParentId" = ${parent.id}::uuid,
      "channelKey" = ${binding.channelKey}, "channelGeneration" = ${binding.channelGeneration},
      "mappingRevision" = ${binding.mappingRevision}, "sourceBinding" = ${JSON.stringify(binding)}::jsonb
      WHERE "id" = ${child.deviceId}::uuid AND "homeId" = ${input.homeId}::uuid
      AND "hubInstallationId" = ${input.hubInstallationId}::uuid AND "osDeviceId" = ${child.osDeviceId}
      AND "managementClass" = ${input.managementClass}::"DeviceManagementClass"
      AND "ownerMembershipId" IS NOT DISTINCT FROM ${input.ownerMembershipId}::uuid`;
    if (changed !== 1) throw new Stage1AuthError(409, 'logical_child_scope_conflict', 'The logical device ownership changed');
  }
  return parent.id;
}
