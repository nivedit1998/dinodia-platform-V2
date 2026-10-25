# Automatic temporary-record retention

The existing authenticated daily maintenance job runs at 03:00 UTC. It now removes:

| Table | Delete only | Preserve |
| --- | --- | --- |
| ReplayNonce | expiresAt <= job cutoff | All unexpired replay protection; current ten-minute TTL and five-minute signature timestamp checks |
| cron.job_run_details | succeeded/failed runs with end_time older than seven days | Recent runs, in-progress and unfinished runs |
| HubSyncReceipt | Existing expiresAt rule (seven-day TTL) | Unexpired sync retry responses |

Replay and cron cleanup use batches of 1,000 with SKIP LOCKED, at most100,000
rows per table and a shared15second soft budget checked between queries. Backlogs
are recorded in the existing retentionCleanup task cursor and resumed at the next
daily run. A single in-flight query can exceed the soft budget. No new scheduler,
table, migration, radio activity or Vercel polling loop is added. Missing pg_cron is
reported as unavailable; other database failures fail retentionCleanup visibly.

Household analytics keep their existing purgeAt rules. Audit history, session
families, idempotency records, credential records and deletion/security tombstones
are not given new automatic deletion rules here: they have separate recovery,
authority or investigation requirements. Do not broadly truncate these tables.

Postgres may reuse deleted-row space without reducing the database file size.
Autovacuum remains responsible for ordinary space reuse; this job does not run
VACUUM FULL, rebuild indexes or acquire those exclusive maintenance locks.

## Verification

`node --test test/ephemeral_retention.test.mjs` checks deadlines, row limits,
parameterized cutoffs, optional pg_cron and error propagation. Run
`node scripts/test_ephemeral_retention_db.mjs` for actual SQL boundary, retry and
preservation checks against a disposable Postgres using the existing local image.
It binds only localhost, caps memory/CPU, and removes its own container afterward.
It never reads Production credentials. Maintenance integration is also exercised
by test/stage1_security.test.mjs; set DINODIA_OS_ROOT to the absolute Hub worktree
when running the existing full suite from a worktree.
