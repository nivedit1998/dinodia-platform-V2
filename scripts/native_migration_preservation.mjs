const volatileRuntimeTables = new Set(['ReplayNonce']);
const volatileRuntimeColumns = new Map([
  // Signed heartbeat freshness and endpoint-report timestamps may advance
  // while the value-free Production preservation inventory is running. Pin,
  // hostname, generation, pairing and endpoint values remain immutable here.
  ['HubInstallation', new Set(['lastSeenAt', 'onlineStateEvaluatedAt', 'updatedAt', 'lanEndpointReportedAt', 'lanTlsReportedAt', 'lastSuccessfulSyncAt'])],
  // The fixed scheduler legitimately advances leases/cursors while a
  // production migration is being applied. Preserve row cardinality and the
  // immutable taskId/dispatcher ownership; only its runtime state may move.
  ['NativeBackgroundTaskState', new Set([
    'nextDueAt', 'cursor', 'leaseOwner', 'leaseExpiresAt', 'lastStartedAt',
    'lastCompletedAt', 'lastOutcome', 'consecutiveFailures', 'updatedAt',
  ])],
]);

export function assertMigrationDoesNotReferenceVolatileRuntimeTables(sql) {
  if (/\bReplayNonce\b/i.test(sql)) {
    throw new Error('reviewed migration references the volatile Stage 1 ReplayNonce table');
  }
}

export function compareExistingTablePreservation(before, after, { expectedAddedTaskRows } = {}) {
  const beforeTables = Object.keys(before.rowCounts).sort();
  const missing = beforeTables.filter((table) => !(table in after.rowCounts));
  if (missing.length) {
    throw new Error(`existing base-table inventory changed (missing: ${missing.join(', ')})`);
  }

  const changedExistingCounts = [];
  const changedExistingRows = [];
  const volatileChanges = [];
  let expectedTaskRowsAdded = 0;
  if (expectedAddedTaskRows !== undefined) {
    const table = 'NativeBackgroundTaskState';
    if (!beforeTables.includes(table) || !(table in after.rowCounts)) {
      throw new Error('expected scheduler-task additions require the existing NativeBackgroundTaskState table');
    }
    const beforeRows = before.taskRegistryRows;
    const afterRows = after.taskRegistryRows;
    if (!Array.isArray(beforeRows) || !Array.isArray(afterRows)) {
      throw new Error('scheduler task identity inventory is missing');
    }
    const asMap = (rows, label) => {
      const result = new Map();
      for (const row of rows) {
        if (typeof row?.taskId !== 'string' || typeof row?.dispatcher !== 'string' || result.has(row.taskId)) {
          throw new Error(`${label} scheduler task identity inventory is invalid`);
        }
        result.set(row.taskId, row.dispatcher);
      }
      return result;
    };
    const prior = asMap(beforeRows, 'prior');
    const current = asMap(afterRows, 'post-migration');
    const expected = asMap(expectedAddedTaskRows, 'approved');
    if (expected.size !== expectedAddedTaskRows.length) {
      throw new Error('approved scheduler task additions contain duplicate identities');
    }
    for (const [taskId, dispatcher] of prior) {
      if (current.get(taskId) !== dispatcher) {
        throw new Error(`existing scheduler task identity or owner changed (${taskId})`);
      }
    }
    const additions = [...current].filter(([taskId]) => !prior.has(taskId));
    for (const [taskId, dispatcher] of additions) {
      if (expected.get(taskId) !== dispatcher) {
        throw new Error(`unexpected scheduler task addition or owner (${taskId})`);
      }
    }
    for (const [taskId, dispatcher] of expected) {
      if (current.get(taskId) !== dispatcher) {
        throw new Error(`approved scheduler task is missing or has the wrong owner (${taskId})`);
      }
    }
    const countDelta = Number(after.rowCounts[table]) - Number(before.rowCounts[table]);
    if (!Number.isSafeInteger(countDelta) || countDelta !== additions.length) {
      throw new Error('scheduler task row count does not match its identity-preserving inventory');
    }
    expectedTaskRowsAdded = additions.length;
  }
  for (const table of beforeTables) {
    const countChanged = after.rowCounts[table] !== before.rowCounts[table];
    const contentChanged = after.rowContentDigests[table] !== before.rowContentDigests[table];
    if (volatileRuntimeTables.has(table)) {
      if (countChanged || contentChanged) volatileChanges.push({ table, rowCountChanged: countChanged, rowContentChanged: contentChanged });
    } else if (volatileRuntimeColumns.has(table)) {
      const columnsBefore = before.columnContentDigests?.[table] ?? {};
      const columnsAfter = after.columnContentDigests?.[table] ?? {};
      const changedColumns = Object.keys(columnsBefore).filter((column) => columnsBefore[column] !== columnsAfter[column]);
      const approvedTaskIdentityChange = table === 'NativeBackgroundTaskState' && expectedAddedTaskRows !== undefined;
      const disallowedColumns = changedColumns.filter((column) =>
        !volatileRuntimeColumns.get(table).has(column)
        && !(approvedTaskIdentityChange && ['taskId', 'dispatcher'].includes(column)));
      if (countChanged && !approvedTaskIdentityChange) changedExistingCounts.push(table);
      if (disallowedColumns.length) changedExistingRows.push(`${table}.${disallowedColumns.join(',')}`);
      else if (contentChanged || changedColumns.length) volatileChanges.push({ table, rowCountChanged: countChanged, rowContentChanged: contentChanged, changedColumns });
    } else {
      if (countChanged) changedExistingCounts.push(table);
      if (contentChanged) changedExistingRows.push(table);
    }
  }
  if (changedExistingCounts.length) {
    throw new Error(`nonvolatile existing Production table row counts changed: ${changedExistingCounts.join(', ')}`);
  }
  if (changedExistingRows.length) {
    throw new Error(`nonvolatile existing Production row content changed outside reviewed lifecycle-pointer columns: ${changedExistingRows.join(', ')}`);
  }
  const result = { changedExistingCounts, changedExistingRows, volatileChanges };
  if (expectedAddedTaskRows !== undefined) result.expectedTaskRowsAdded = expectedTaskRowsAdded;
  return result;
}
