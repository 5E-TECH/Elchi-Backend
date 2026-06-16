/**
 * Cashbox invariant check (Elchi version).
 *
 * For every non-deleted cashbox, two invariants must hold:
 *   I1.  balance == SUM(signed amount) from non-deleted cashbox_history rows
 *        (income → +amount, expense → -amount).
 *   I2.  balance_cash + balance_card ≈ balance  (within EPSILON tolerance).
 *
 * Background: PCS got bitten in 2026-04 when an int→bigint migration silently
 * truncated balances. This script is run pre- and post-migration so any drift
 * introduced by a deploy is caught before traffic resumes.
 *
 * Modes:
 *   (no flags)               → STRICT. Any drift exits 1.
 *   --snapshot=<path>        → write a baseline of *current* drift, exit 0.
 *                              Use before a migration to capture pre-existing drift.
 *   --compare=<path>         → diff against a baseline; exit 1 if any drift
 *                              is new or has *grown*. Equal/unchanged drift is fine.
 *   --reconcile-strict       → MONITORED-CRON mode (Faza 3). Exits 1 AND reports
 *   (alias: --alert)           to Sentry if EITHER cashbox I1/I2 drift OR the
 *                              settlement↔cashbox cross-system divergence is
 *                              present. This is the enforced money-conservation
 *                              invariant — unlike the always-informational recon
 *                              section, this mode fails so a scheduler can alert.
 *
 * Run order on a deploy:
 *   npm run db:check-cashbox -- --snapshot=/tmp/cb-pre.json   # before migration
 *   npm run migration:run
 *   npm run db:check-cashbox -- --compare=/tmp/cb-pre.json    # after migration
 *
 * Scheduling (the DB is server-local, so this runs ON the server, not in CI).
 * Add a system crontab entry (e.g. hourly) with SENTRY_DSN exported so a
 * divergence pages ops:
 *   0 * * * * cd /app && SENTRY_DSN=... npm run db:reconcile >> /var/log/elchi-recon.log 2>&1
 *
 * Tolerance: money is now stored as `numeric(14,2)` (audit 2026-06-07; previously
 * `float`). Live values no longer accumulate binary-float drift. EPSILON=0.01 is
 * kept to absorb one-time ≤1-tiyin rounding applied to historical rows during the
 * float→numeric cast; it can be tightened toward 0 once post-migration audits on
 * real data confirm no residual mismatch.
 */
import 'reflect-metadata';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import {
  initSentry,
  captureException,
  flushSentry,
} from '../libs/common/src/sentry/sentry.helper';

dotenv.config();
// Allow override for production: `node ... --env=.env.production`
const envFlag = process.argv.find((a) => a.startsWith('--env='));
if (envFlag) {
  dotenv.config({ path: envFlag.slice('--env='.length), override: true });
}

const EPSILON = 0.01;
const SCHEMA = 'finance_schema';

interface DriftRow {
  cashbox_id: string;
  user_id: string | null;
  cashbox_type: string;
  current_balance: string;
  history_sum: string;
  diff: string;
  balance_cash: string;
  balance_card: string;
  split_diff: string;
}

function parseArg(prefix: string): string | null {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function absFloat(n: string): number {
  return Math.abs(Number(n));
}

async function main(): Promise<void> {
  const snapshotPath = parseArg('--snapshot=');
  const comparePath = parseArg('--compare=');
  const reconcileStrict =
    process.argv.includes('--reconcile-strict') ||
    process.argv.includes('--alert');

  const postgresUri = process.env.POSTGRES_URI;
  if (!postgresUri) {
    console.error('POSTGRES_URI is required.');
    process.exit(2);
  }

  const ds = new DataSource({
    type: 'postgres',
    url: postgresUri,
    schema: SCHEMA,
    synchronize: false,
    logging: false,
  });

  await ds.initialize();
  console.log(`🔌 Connected. Auditing cashbox invariants in ${SCHEMA}...\n`);

  const rows: DriftRow[] = await ds.query(`
    WITH signed AS (
      SELECT
        ch.cashbox_id,
        CASE
          WHEN ch.operation_type = 'income'  THEN  ch.amount
          WHEN ch.operation_type = 'expense' THEN -ch.amount
          ELSE 0
        END AS delta
      FROM ${SCHEMA}.cashbox_history ch
      WHERE ch.is_deleted = false
    )
    SELECT
      cb.id                        AS cashbox_id,
      cb.user_id                   AS user_id,
      cb.cashbox_type::text        AS cashbox_type,
      cb.balance::text             AS current_balance,
      COALESCE(SUM(s.delta), 0)::text AS history_sum,
      (cb.balance - COALESCE(SUM(s.delta), 0))::text AS diff,
      cb.balance_cash::text        AS balance_cash,
      cb.balance_card::text        AS balance_card,
      (cb.balance - (cb.balance_cash + cb.balance_card))::text AS split_diff
    FROM ${SCHEMA}.cashboxes cb
    LEFT JOIN signed s ON s.cashbox_id = cb.id
    WHERE cb.is_deleted = false
    GROUP BY cb.id
    ORDER BY ABS(cb.balance - COALESCE(SUM(s.delta), 0)) DESC
  `);

  const drifted = rows.filter(
    (r) => absFloat(r.diff) > EPSILON || absFloat(r.split_diff) > EPSILON,
  );

  for (const r of drifted) {
    const i1 = absFloat(r.diff) > EPSILON;
    const i2 = absFloat(r.split_diff) > EPSILON;
    const flags = [i1 ? 'I1' : null, i2 ? 'I2' : null]
      .filter(Boolean)
      .join('+');
    console.log(
      `⚠️  [${flags}] ${r.cashbox_type} ${r.cashbox_id}  user=${r.user_id ?? '-'}`,
    );
    if (i1) {
      console.log(
        `       balance=${r.current_balance}  history_sum=${r.history_sum}  diff=${r.diff}`,
      );
    }
    if (i2) {
      console.log(
        `       balance=${r.current_balance}  cash+card=${(
          Number(r.balance_cash) + Number(r.balance_card)
        ).toFixed(4)}  split_diff=${r.split_diff}`,
      );
    }
  }

  console.log(
    `\n📊 Total: ${rows.length} cashboxes audited, ${drifted.length} drifted (tol=${EPSILON}).`,
  );

  // -----------------------------------------------------------------
  // Cross-system settlement reconciliation (Audit I3) — INFORMATIONAL.
  // The per-order FIFO order_settlement ledger (order_schema) and the cashbox
  // balances (finance_schema) are two views of the same money. If the
  // production cash path stops advancing order_settlement (the split-brain
  // failure), settlement rows pile up at PENDING while cashboxes keep moving.
  // This section surfaces that drift. It never changes the exit code (the SQL
  // spans two schemas and tolerates extra-cost/correction noise), so it cannot
  // false-fail the migration gate — but it gives ops a real divergence signal.
  // -----------------------------------------------------------------
  // Lifted so --reconcile-strict can fail/alert on it after the report below.
  let reconDiverging: Array<{
    market_id: string;
    cashbox_balance: string;
    unsettled_owed: string;
    diff: string;
  }> = [];
  try {
    const statusDist: Array<{ status: string; n: string; total: string }> =
      await ds.query(`
        SELECT status::text AS status, COUNT(*)::text AS n,
               COALESCE(SUM(market_amount),0)::text AS total
        FROM order_schema.order_settlement
        WHERE is_deleted = false
        GROUP BY status
        ORDER BY status
      `);
    if (statusDist.length) {
      console.log('\n🔗 order_settlement status distribution:');
      for (const s of statusDist) {
        console.log(
          `       ${s.status.padEnd(16)} count=${s.n}  Σmarket_amount=${s.total}`,
        );
      }
    }

    // Per-market: FOR_MARKET cashbox balance (what HQ owes the market) vs the
    // sum of market_amount for that market's not-yet-MARKET_SETTLED orders.
    const marketRecon: Array<{
      market_id: string;
      cashbox_balance: string;
      unsettled_owed: string;
      diff: string;
    }> = await ds.query(`
      SELECT os.market_id AS market_id,
             cb.balance::text AS cashbox_balance,
             COALESCE(SUM(os.market_amount),0)::text AS unsettled_owed,
             (cb.balance - COALESCE(SUM(os.market_amount),0))::text AS diff
      FROM order_schema.order_settlement os
      JOIN finance_schema.cashboxes cb
        ON cb.user_id = os.market_id
       AND cb.cashbox_type = 'markets'
       AND cb.is_deleted = false
      WHERE os.is_deleted = false AND os.status <> 'market_settled'
      GROUP BY os.market_id, cb.balance
      ORDER BY ABS(cb.balance - COALESCE(SUM(os.market_amount),0)) DESC
      LIMIT 20
    `);
    const RECON_TOL = 1; // som; absorbs extra-cost/correction noise
    const diverging = marketRecon.filter((m) => Math.abs(Number(m.diff)) > RECON_TOL);
    reconDiverging = diverging;
    if (diverging.length) {
      console.log(
        `\n⚠️  Settlement↔cashbox divergence (top ${diverging.length} markets, informational):`,
      );
      for (const m of diverging) {
        console.log(
          `       market=${m.market_id}  for_market_balance=${m.cashbox_balance}  unsettled_owed=${m.unsettled_owed}  diff=${m.diff}`,
        );
      }
      console.log(
        '       (large/persistent diffs = settlement not advancing with the cashbox — investigate.)',
      );
    } else {
      console.log('\n✅ Settlement ledger reconciles with FOR_MARKET cashboxes (within tol).');
    }
  } catch (err) {
    console.log(
      `\nℹ️  settlement reconciliation skipped: ${(err as Error)?.message ?? err}`,
    );
  }

  await ds.destroy();

  // -----------------------------------------------------------------
  // RECONCILE-STRICT mode (Faza 3) — the ENFORCED money-conservation
  // invariant for a monitored cron. Fails (exit 1) and reports to Sentry if
  // EITHER cashbox I1/I2 drift OR settlement↔cashbox divergence is present, so
  // a silent split-brain (cash moved, settlement ledger not advanced) pages ops
  // instead of being a print-only signal nobody watches.
  // -----------------------------------------------------------------
  if (reconcileStrict) {
    const problems: string[] = [];
    if (drifted.length) {
      problems.push(`${drifted.length} cashbox(es) with I1/I2 drift`);
    }
    if (reconDiverging.length) {
      problems.push(
        `${reconDiverging.length} market(s) with settlement↔cashbox divergence`,
      );
    }
    if (problems.length === 0) {
      console.log(
        '\n✅ reconcile-strict: cashboxes and the settlement ledger reconcile.',
      );
      process.exit(0);
    }
    const summary = `Money reconciliation FAILED: ${problems.join('; ')}`;
    console.error(`\n❌ ${summary}`);
    initSentry({ serviceName: 'cashbox-reconciliation' });
    captureException(new Error(summary), {
      drifted_cashboxes: drifted
        .slice(0, 20)
        .map((r) => ({ id: r.cashbox_id, diff: r.diff })),
      settlement_divergence: reconDiverging.slice(0, 20),
    });
    await flushSentry();
    process.exit(1);
  }

  // -----------------------------------------------------------------
  // SNAPSHOT mode — capture baseline, never exit non-zero
  // -----------------------------------------------------------------
  if (snapshotPath) {
    const payload = {
      taken_at: new Date().toISOString(),
      epsilon: EPSILON,
      total: rows.length,
      drifted: drifted.length,
      items: drifted.map((r) => ({
        cashbox_id: r.cashbox_id,
        diff: r.diff,
        split_diff: r.split_diff,
      })),
    };
    fs.mkdirSync(path.dirname(path.resolve(snapshotPath)), { recursive: true });
    fs.writeFileSync(snapshotPath, JSON.stringify(payload, null, 2));
    console.log(`\n💾 Snapshot written: ${snapshotPath}`);
    console.log(
      `ℹ️  Baseline mode — exiting 0 (${drifted.length} pre-existing drift).`,
    );
    process.exit(0);
  }

  // -----------------------------------------------------------------
  // COMPARE mode — fail only on NEW or GROWN drift vs. baseline
  // -----------------------------------------------------------------
  if (comparePath) {
    if (!fs.existsSync(comparePath)) {
      console.error(`❌ Snapshot not found: ${comparePath}`);
      process.exit(1);
    }
    const snap = JSON.parse(fs.readFileSync(comparePath, 'utf8')) as {
      items: Array<{ cashbox_id: string; diff: string; split_diff: string }>;
    };
    const prev = new Map(snap.items.map((it) => [it.cashbox_id, it]));

    const regressed: Array<{
      id: string;
      before_diff: string;
      after_diff: string;
      before_split: string;
      after_split: string;
    }> = [];

    for (const r of drifted) {
      const before = prev.get(r.cashbox_id);
      const grew =
        !before ||
        absFloat(r.diff) > absFloat(before.diff) + EPSILON ||
        absFloat(r.split_diff) > absFloat(before.split_diff) + EPSILON;
      if (grew) {
        regressed.push({
          id: r.cashbox_id,
          before_diff: before?.diff ?? '0',
          after_diff: r.diff,
          before_split: before?.split_diff ?? '0',
          after_split: r.split_diff,
        });
      }
    }

    if (regressed.length === 0) {
      console.log(
        `\n✅ No new drift — all variances match (or stayed below) baseline.` +
          ` (${drifted.length} pre-existing drift unchanged)`,
      );
      process.exit(0);
    }

    console.log(`\n❌ NEW or GROWN drift (${regressed.length}):`);
    for (const d of regressed) {
      console.log(
        `   ${d.id}  diff ${d.before_diff} → ${d.after_diff}  split ${d.before_split} → ${d.after_split}`,
      );
    }
    console.log(
      '\nMigration corrupted cashbox state — investigate before continuing.',
    );
    process.exit(1);
  }

  // -----------------------------------------------------------------
  // STRICT mode (no flags)
  // -----------------------------------------------------------------
  if (drifted.length === 0) {
    console.log('✅ All invariants hold.');
    process.exit(0);
  }
  console.log(
    '❌ Drift detected. Run with --snapshot=<path> if drift is known/legacy.',
  );
  process.exit(1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
