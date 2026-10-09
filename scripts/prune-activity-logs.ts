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
 * (f2Ud5tju) Then, in the same schemas, a SHORTER window for personal data:
 * rows older than ACTIVITY_LOG_DEVICE_RETENTION_DAYS keep the row but lose the
 * `ip`, `user_agent`, `device_id`, `device_name` metadata keys (batched UPDATE,
 * other metadata keys untouched) — see libs/common/src/activity-log/retention.ts.
 *
 * Config (env):
 *   POSTGRES_URI                 required — the DB connection string.
 *   ACTIVITY_LOG_RETENTION_DAYS  retention window in days (default 365).
 *   ACTIVITY_LOG_PRUNE_BATCH     rows per DELETE / UPDATE batch (default 10000).
 *   ACTIVITY_LOG_DEVICE_RETENTION_DAYS  ip/device metadata window in days
 *                                (default 30; capped at the retention window).
 *
 * Flags:
 *   --dry-run   report how many rows WOULD be deleted / lose ip-device metadata
 *               per schema, change nothing.
 *
 * Scheduling (DB is server-local, so run ON the server): daily via crontab or
 * the `activity-log-prune` docker-compose sidecar, e.g.
 *   30 3 * * * cd /app && POSTGRES_URI=... npm run db:prune-activity-logs
 *
 * Exit codes: 0 ok, 2 misconfigured (no POSTGRES_URI / bad retention).
 */
import { DataSource } from 'typeorm';
import {
  ACTIVITY_LOG_DEVICE_RETENTION_DEFAULT_DAYS,
  ACTIVITY_LOG_DEVICE_RETENTION_ENV,
  buildDeviceMetadataCountSql,
  quoteActivityLogTable,
  resolveDeviceRetentionDays,
  stripDeviceMetadataBatched,
} from '../libs/common/src/activity-log/retention';

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
  // (f2Ud5tju) Noto'g'ri qiymat — exit 2 (jim sukutga tushib, IP'ni kutilgandan
  // erta o'chirmasin); umumiy muddatdan katta bo'lsa umumiy ustun.
  const deviceDays = resolveDeviceRetentionDays(
    retentionDays,
    intFromEnv(
      ACTIVITY_LOG_DEVICE_RETENTION_ENV,
      ACTIVITY_LOG_DEVICE_RETENTION_DEFAULT_DAYS,
    ),
  );
  const deviceCutoff = new Date(Date.now() - deviceDays * 86_400_000);

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
        `batch=${batchSize}; ip/device metadata older than ${deviceDays} days.\n`,
    );

    let grandTotal = 0;
    let deviceTotal = 0;
    for (const { table_schema } of schemas) {
      const table = quoteActivityLogTable(table_schema);

      if (dryRun) {
        const [{ count }]: Array<{ count: string }> = await ds.query(
          `SELECT COUNT(*)::text AS count FROM ${table} WHERE created_at < ${cutoffSql}`,
        );
        const n = Number(count);
        grandTotal += n;
        const [device]: Array<{ count: number }> = await ds.query(
          buildDeviceMetadataCountSql(table),
          [deviceCutoff],
        );
        deviceTotal += Number(device?.count ?? 0);
        console.log(
          `  ${table_schema}: ${n} row(s) would be deleted, ` +
            `<= ${Number(device?.count ?? 0)} row(s) would lose ip/device metadata`,
        );
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

      // (f2Ud5tju) DELETE dan keyin — o'chiriladigan qatorlar bekorga UPDATE
      // qilinmaydi. Partiyalab: har partiya alohida qisqa so'rov.
      const stripped = await stripDeviceMetadataBatched(
        (sql, params) => ds.query(sql, params),
        table,
        deviceCutoff,
        batchSize,
      );
      deviceTotal += stripped;
      console.log(
        `  ${table_schema}: deleted ${schemaTotal} row(s), ` +
          `stripped ip/device metadata from ${stripped} row(s)`,
      );
    }

    console.log(
      `\n${dryRun ? '[dry-run] ' : ''}Total: ${grandTotal} row(s)` +
        `${dryRun ? ' would be' : ''} pruned, ${deviceTotal} row(s)` +
        `${dryRun ? ' would lose' : ' lost'} ip/device metadata.`,
    );
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('Activity-log prune failed:', err);
  process.exit(1);
});
