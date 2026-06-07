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
 *
 * Run order on a deploy:
 *   npm run db:check-cashbox -- --snapshot=/tmp/cb-pre.json   # before migration
 *   npm run migration:run
 *   npm run db:check-cashbox -- --compare=/tmp/cb-pre.json    # after migration
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

  await ds.destroy();

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
