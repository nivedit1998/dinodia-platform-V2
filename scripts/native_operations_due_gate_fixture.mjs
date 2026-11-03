// Predicate-only fixture: real Prisma scalar/enum types, precision and nullability.
// Omits unrelated columns, foreign keys, domain triggers and handler execution.
export const dueGateFixtureColumns = {
  NativeBackgroundTaskState: ['taskId', 'dispatcher', 'nextDueAt', 'leaseOwner', 'leaseExpiresAt', 'lastStartedAt', 'lastCompletedAt', 'lastOutcome', 'consecutiveFailures'],
  HubCredentialVersion: ['id', 'hubInstallationId', 'purpose', 'state', 'issuedAt', 'graceUntil'],
  SupportSession: ['id', 'status', 'expiresAt'],
  SupportAccessRequest: ['id', 'status', 'codeExpiresAt'],
  HomeClaimReservation: ['id', 'state', 'expiresAt'],
  AlexaNativeLink: ['id', 'status', 'revokedAt', 'autoScope'],
  NativeDomainOutbox: ['id', 'aggregateType', 'eventType', 'state', 'nextAttemptAt', 'expiresAt', 'attempts', 'updatedAt'],
  NativeNotificationDeliveryReceipt: ['id', 'family', 'channel', 'status', 'deliverAfter', 'expiresAt', 'attemptCount', 'idempotencyKey'],
};
export function nativeOperationsDueGateFixture(schema) {
  const enums = new Map([...schema.matchAll(/^enum (\w+) \{([^}]+)\}/gm)].map((m) => [m[1], m[2].trim().split(/\s+/)]));
  const usedEnums = new Set();
  const defaults = {
    id: 'gen_random_uuid()', hubInstallationId: "'11111111-1111-4111-8111-111111111111'::uuid",
    purpose: "'operator-credential'", issuedAt: "'2026-11-03T12:00:00'::timestamp", autoScope: 'false',
    nextAttemptAt: "'2026-11-03T12:00:00'::timestamp", deliverAfter: "'2026-11-03T12:00:00'::timestamp",
    expiresAt: "'2026-11-04T12:00:00'::timestamp", updatedAt: "'2026-11-03T12:00:00'::timestamp",
    attempts: '0', attemptCount: '0', consecutiveFailures: '0',
    idempotencyKey: "'installation-request:' || gen_random_uuid()::text",
  };
  const tables = Object.entries(dueGateFixtureColumns).map(([model, columns]) => {
    const body = new RegExp(`^model ${model} \\{([^}]+)\\}`, 'm').exec(schema)?.[1];
    if (!body) throw new Error(`Missing fixture model ${model}`);
    return `CREATE TABLE public."${model}" (${columns.map((field) => {
      const match = new RegExp(`^\\s*${field}\\s+(\\w+)(\\?)?([^\\n]*)`, 'm').exec(body);
      if (!match) throw new Error(`Missing fixture column ${model}.${field}`);
      const [, kind, optional, annotations] = match;
      let type;
      if (kind === 'String') type = /@db\.Uuid/.test(annotations) ? 'uuid'
        : /@db\.VarChar\((\d+)\)/.test(annotations) ? `varchar(${/@db\.VarChar\((\d+)\)/.exec(annotations)[1]})` : 'text';
      else if (kind === 'DateTime') type = 'timestamp(3) without time zone';
      else if (kind === 'Int') type = 'integer';
      else if (kind === 'Json') type = 'jsonb';
      else if (kind === 'Boolean') type = 'boolean';
      else if (enums.has(kind)) { type = `public."${kind}"`; usedEnums.add(kind); }
      else throw new Error(`Unhandled fixture type ${kind}`);
      const defaultValue = defaults[field];
      return `"${field}" ${type}${optional ? '' : ' NOT NULL'}${defaultValue ? ` DEFAULT (${defaultValue})` : ''}${['id', 'taskId'].includes(field) ? ' PRIMARY KEY' : ''}`;
    }).join(',\n')});`;
  });
  return [...usedEnums].map((name) => `CREATE TYPE public."${name}" AS ENUM (${enums.get(name).map((value) => `'${value}'`).join(',')});`).join('\n')
    + '\n' + tables.join('\n') + `
CREATE INDEX "NativeDomainOutbox_state_nextAttemptAt_idx" ON public."NativeDomainOutbox" ("state", "nextAttemptAt");
CREATE INDEX "HubCredentialVersion_hub_purpose_state_idx" ON public."HubCredentialVersion" ("hubInstallationId", "purpose", "state");
CREATE INDEX "NativeBackgroundTaskState_dispatcher_nextDueAt_idx" ON public."NativeBackgroundTaskState" ("dispatcher", "nextDueAt");
`;
}
