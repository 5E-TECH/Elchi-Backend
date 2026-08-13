/**
 * Activity-log retention prune (Elchi).
 *
 * The `activity_logs` table (one per service schema) grows with every mutating
 * operation across the platform and had no retention policy — an unbounded,
 * ever-growing table (audit: devops/observability). This script deletes rows
 * older than the retention window from EVERY schema that has an activity_logs
 * table (discovered from information_schema, so new services are covered
 * automatically), in bounded batches so it never holds a long lock.
 *
 * Config (env):
 *   POSTGRES_URI                 required — the DB connection string.
 *   ACTIVITY_LOG_RETENTION_DAYS  retention window in days (default 365).
 *   ACTIVITY_LOG_PRUNE_BATCH     rows per DELETE batch (default 10000).
 *
 * Flags:
 *   --dry-run   report how many rows WOULD be deleted per schema, delete nothing.
 *
 * Scheduling (DB is server-local, so run ON the server): daily via crontab or
 * the `activity-log-prune` docker-compose sidecar, e.g.
 *   30 3 * * * cd /app && POSTGRES_URI=... npm run db:prune-activity-logs
 *
 * Exit codes: 0 ok, 2 misconfigured (no POSTGRES_URI / bad retention).
 */
import { DataSource } from 'typeorm';

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    console.error(`${name} must be a positive integer (got "${raw}").`);
    process.exit(2);
  }
  return n;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const postgresUri = process.env.POSTGRES_URI;
  if (!postgresUri) {
    console.error('POSTGRES_URI is required.');
    process.exit(2);
  }
  const retentionDays = intFromEnv('ACTIVITY_LOG_RETENTION_DAYS', 365);
  const batchSize = intFromEnv('ACTIVITY_LOG_PRUNE_BATCH', 10_000);
  const cutoffSql = `now() - interval '${retentionDays} days'`;

  const ds = new DataSource({
    type: 'postgres',
    url: postgresUri,
    synchronize: false,
    logging: false,
  });
  await ds.initialize();

  try {
    const schemas: Array<{ table_schema: string }> = await ds.query(
      `SELECT table_schema FROM information_schema.tables
       WHERE table_name = 'activity_logs' ORDER BY table_schema`,
    );
    if (!schemas.length) {
      console.log('No activity_logs tables found; nothing to prune.');
      return;
    }

    console.log(
      `${dryRun ? '[dry-run] ' : ''}Pruning activity_logs older than ` +
        `${retentionDays} days across ${schemas.length} schema(s), ` +
        `batch=${batchSize}.\n`,
    );

    let grandTotal = 0;
    for (const { table_schema } of schemas) {
      const table = `"${table_schema}"."activity_logs"`;

      if (dryRun) {
        const [{ count }]: Array<{ count: string }> = await ds.query(
          `SELECT COUNT(*)::text AS count FROM ${table} WHERE created_at < ${cutoffSql}`,
        );
        const n = Number(count);
        grandTotal += n;
        console.log(`  ${table_schema}: ${n} row(s) would be deleted`);
        continue;
      }

      // Batched delete: cap each statement so a big backlog can't hold a long
      // lock / bloat WAL. Loop until a batch deletes fewer than batchSize rows.
      let schemaTotal = 0;
      for (;;) {
        // RETURNING 1 gives one row per deleted row, so the array length is the
        // exact batch count (driver-agnostic, unlike a positional rowCount).
        const deletedRows: unknown[] = await ds.query(
          `DELETE FROM ${table}
           WHERE id IN (
             SELECT id FROM ${table}
             WHERE created_at < ${cutoffSql}
             ORDER BY id
             LIMIT ${batchSize}
           )
           RETURNING 1`,
        );
        const deleted = Array.isArray(deletedRows) ? deletedRows.length : 0;
        schemaTotal += deleted;
        if (deleted < batchSize) break;
      }
      grandTotal += schemaTotal;
      console.log(`  ${table_schema}: deleted ${schemaTotal} row(s)`);
    }

    console.log(
      `\n${dryRun ? '[dry-run] ' : ''}Total: ${grandTotal} row(s)` +
        `${dryRun ? ' would be' : ''} pruned.`,
    );
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('Activity-log prune failed:', err);
  process.exit(1);
});
