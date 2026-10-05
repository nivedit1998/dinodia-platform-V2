const volatileRuntimeTables = new Set(['ReplayNonce']);
const volatileRuntimeColumns = new Map([
  // Signed heartbeat freshness and endpoint-report timestamps may advance
  // while the value-free Production preservation inventory is running. Pin,
  // hostname, generation, pairing and endpoint values remain immutable here.
  ['HubInstallation', new Set(['lastSeenAt', 'onlineStateEvaluatedAt', 'updatedAt', 'lanEndpointReportedAt', 'lanTlsReportedAt'])],
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

export function compareExistingTablePreservation(before, after) {
  const beforeTables = Object.keys(before.rowCounts).sort();
  const missing = beforeTables.filter((table) => !(table in after.rowCounts));
  if (missing.length) {
    throw new Error(`existing base-table inventory changed (missing: ${missing.join(', ')})`);
  }

  const changedExistingCounts = [];
  const changedExistingRows = [];
  const volatileChanges = [];
  for (const table of beforeTables) {
    const countChanged = after.rowCounts[table] !== before.rowCounts[table];
    const contentChanged = after.rowContentDigests[table] !== before.rowContentDigests[table];
    if (volatileRuntimeTables.has(table)) {
      if (countChanged || contentChanged) volatileChanges.push({ table, rowCountChanged: countChanged, rowContentChanged: contentChanged });
    } else if (volatileRuntimeColumns.has(table)) {
      const columnsBefore = before.columnContentDigests?.[table] ?? {};
      const columnsAfter = after.columnContentDigests?.[table] ?? {};
      const changedColumns = Object.keys(columnsBefore).filter((column) => columnsBefore[column] !== columnsAfter[column]);
      const disallowedColumns = changedColumns.filter((column) => !volatileRuntimeColumns.get(table).has(column));
      if (countChanged) changedExistingCounts.push(table);
      if (disallowedColumns.length) changedExistingRows.push(`${table}.${disallowedColumns.join(',')}`);
      else if (contentChanged || changedColumns.length) volatileChanges.push({ table, rowCountChanged: false, rowContentChanged: contentChanged, changedColumns });
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
  return { changedExistingCounts, changedExistingRows, volatileChanges };
}
