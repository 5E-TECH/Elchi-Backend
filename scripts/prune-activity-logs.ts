/**
 * Activity-log retention prune (Elchi).
 *
 * The `activity_logs` table (one per service schema) grows with every mutating
 * operation across the platform. This script applies the retention POLICY
 * (libs/common/src/activity-log/retention-policy.ts, i6Nyedea) to EVERY schema
 * that has an activity_logs table (discovered from information_schema, so new
 * services are covered automatically), in bounded batches so it never holds a
 * long lock.
 *
 * ⚠️ i6Nyedea — ROW DELETION IS OFF BY DEFAULT. Unless
 * `ACTIVITY_LOG_PRUNE_ENABLED=true`, the delete step only COUNTS what would be
 * deleted (dry-run). Previously this sidecar deleted every row older than
 * ACTIVITY_LOG_RETENTION_DAYS (default 365) in every schema, financial rows
 * included.
 *
 * Policy (by action verb):
 *   • auth (login/logout/auth_failure + OTP) — ACTIVITY_LOG_RETENTION_AUTH_DAYS
 *     (default 90, min 7);
 *   • everything else (finance, orders, investor, settlement ...) —
 *     ACTIVITY_LOG_RETENTION_DEFAULT_DAYS (default 1095, min 365).
 *
 * (f2Ud5tju) Then, in the same schemas, a SHORTER window for personal data:
 * rows older than ACTIVITY_LOG_DEVICE_RETENTION_DAYS keep the row but lose the
 * `ip`, `user_agent`, `device_id`, `device_name` metadata keys (batched UPDATE,
 * other metadata keys untouched). This is NOT row deletion and keeps running
 * regardless of ACTIVITY_LOG_PRUNE_ENABLED (only `--dry-run` stops it).
 *
 * Config (env):
 *   POSTGRES_URI                         required — the DB connection string.
 *   ACTIVITY_LOG_PRUNE_ENABLED           `true` to actually delete (default off).
 *   ACTIVITY_LOG_RETENTION_AUTH_DAYS     auth verbs window (default 90).
 *   ACTIVITY_LOG_RETENTION_DEFAULT_DAYS  all other verbs window (default 1095).
 *   ACTIVITY_LOG_PRUNE_BATCH             rows per DELETE / UPDATE batch (default 10000).
 *   ACTIVITY_LOG_PRUNE_PAUSE_MS          pause between delete batches (default 200).
 *   ACTIVITY_LOG_DEVICE_RETENTION_DAYS   ip/device metadata window in days
 *                                        (default 30; capped at the shortest policy window).
 *   ACTIVITY_LOG_RETENTION_DAYS          DEPRECATED — ignored (warning printed).
 *
 * Flags:
 *   --dry-run   report counts only, change nothing (also skips the ip/device strip).
 *
 * Scheduling (DB is server-local, so run ON the server): daily via the
 * `activity-log-prune` docker-compose sidecar (scripts/prune-activity-logs-cron.sh).
 *
 * Exit codes: 0 ok, 2 misconfigured (no POSTGRES_URI / bad numeric env).
 */
import { DataSource } from 'typeorm';
import {
  ACTIVITY_LOG_DEVICE_RETENTION_DEFAULT_DAYS,
  ACTIVITY_LOG_DEVICE_RETENTION_ENV,
  ACTIVITY_LOG_PRUNE_BATCH_DEFAULT,
  ActivityLogSqlRunner,
  buildDeviceMetadataCountSql,
  quoteActivityLogTable,
  resolveDeviceRetentionDays,
  stripDeviceMetadataBatched,
} from '../libs/common/src/activity-log/retention';
import {
  countByRule,
  isActivityLogPruneEnabled,
  pruneByRuleBatched,
  resolveActivityLogRetentionPolicy,
  resolvePrunePauseMs,
} from '../libs/common/src/activity-log/retention-policy';

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
  const explicitDryRun = process.argv.includes('--dry-run');
  const deleteEnabled = isActivityLogPruneEnabled() && !explicitDryRun;
  const postgresUri = process.env.POSTGRES_URI;
  if (!postgresUri) {
    console.error('POSTGRES_URI is required.');
    process.exit(2);
  }
  if (process.env.ACTIVITY_LOG_RETENTION_DAYS) {
    console.warn(
      'ACTIVITY_LOG_RETENTION_DAYS is deprecated and IGNORED (i6Nyedea): use ' +
        'ACTIVITY_LOG_RETENTION_AUTH_DAYS / ACTIVITY_LOG_RETENTION_DEFAULT_DAYS.',
    );
  }
  const policy = resolveActivityLogRetentionPolicy();
  for (const warning of policy.warnings) console.warn(warning);
  const batchSize = intFromEnv(
    'ACTIVITY_LOG_PRUNE_BATCH',
    ACTIVITY_LOG_PRUNE_BATCH_DEFAULT,
  );
  const pauseMs = resolvePrunePauseMs();
  // (f2Ud5tju) Noto'g'ri qiymat — exit 2 (jim sukutga tushib, IP'ni kutilgandan
  // erta o'chirmasin); eng qisqa siyosat muddatidan katta bo'lsa o'sha ustun.
  const deviceDays = resolveDeviceRetentionDays(
    Math.min(...policy.rules.map((r) => r.days)),
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
  const run: ActivityLogSqlRunner = (sql, params) => ds.query(sql, params);

  try {
    const schemas: Array<{ table_schema: string }> = await ds.query(
      `SELECT table_schema FROM information_schema.tables
       WHERE table_name = 'activity_logs' ORDER BY table_schema`,
    );
    if (!schemas.length) {
      console.log('No activity_logs tables found; nothing to prune.');
      return;
    }

    const rulesText = policy.rules
      .map((r) => `${r.name}>${r.days}d`)
      .join(', ');
    console.log(
      `${deleteEnabled ? '' : '[dry-run: ACTIVITY_LOG_PRUNE_ENABLED is off] '}` +
        `activity_logs retention policy (${rulesText}) across ${schemas.length} schema(s), ` +
        `batch=${batchSize}; ip/device metadata older than ${deviceDays} days` +
        `${explicitDryRun ? ' (count only)' : ''}.\n`,
    );

    let grandTotal = 0;
    let deviceTotal = 0;
    for (const { table_schema } of schemas) {
      const table = quoteActivityLogTable(table_schema);

      const perRule: string[] = [];
      for (const rule of policy.rules) {
        // i6Nyedea: o'chirish faqat bayroq yoqilganda; aks holda AYNI shart
        // bilan sanash.
        const n = deleteEnabled
          ? (
              await pruneByRuleBatched(run, table, rule, {
                batchSize,
                pauseMs,
              })
            ).deleted
          : await countByRule(run, table, rule);
        grandTotal += n;
        perRule.push(`${rule.name}=${n}`);
      }

      let stripped: number;
      if (explicitDryRun) {
        const [device]: Array<{ count: number }> = await ds.query(
          buildDeviceMetadataCountSql(table),
          [deviceCutoff],
        );
        stripped = Number(device?.count ?? 0);
      } else {
        // (f2Ud5tju) DELETE dan keyin — o'chiriladigan qatorlar bekorga
        // UPDATE qilinmaydi. Partiyalab: har partiya alohida qisqa so'rov.
        stripped = await stripDeviceMetadataBatched(
          run,
          table,
          deviceCutoff,
          batchSize,
        );
      }
      deviceTotal += stripped;
      console.log(
        `  ${table_schema}: ${deleteEnabled ? 'deleted' : 'would delete'} ` +
          `${perRule.join(', ')}; ` +
          `${explicitDryRun ? 'would strip' : 'stripped'} ip/device metadata from ${stripped} row(s)`,
      );
    }

    console.log(
      `\nTotal: ${grandTotal} row(s) ${deleteEnabled ? 'pruned' : 'would be pruned (dry-run)'}, ` +
        `${deviceTotal} row(s) ${explicitDryRun ? 'would lose' : 'lost'} ip/device metadata.`,
    );
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('Activity-log prune failed:', err);
  process.exit(1);
});
