/**
 * O'tgan sotuvlarga operator komissiyasi — DB qismi (bir martalik ops
 * skripti, `scripts/backfill-operator-earnings.ts`).
 *
 * Xavfsizlik:
 *  - FAQAT yangi qator qo'shiladi (`INSERT … ON CONFLICT DO NOTHING`); mavjud
 *    komissiya qatoriga (tirik yoki rollback qilingan) TEGILMAYDI, hech narsa
 *    o'chirilmaydi / yangilanmaydi;
 *  - komissiyasi UMUMAN yozilmagan buyurtmalar: `operator_earnings` da shu
 *    `order_id` uchun birorta qator yo'q (o'chirilgani ham hisobga olinadi);
 *  - qayta yurgizish xavfsiz: yozilganlar endi nomzod emas, parallel yozuv
 *    (jonli sotuv, market paneldagi tugma) `UQ_OPERATOR_EARNING_ORDER` da
 *    to'xtaydi — ikkinchi qator yo'q;
 *  - kassaga, daftarga, buyurtmaga ta'sir YO'Q — faqat `operator_earnings`
 *    va `activity_logs` (audit, `metadata.run_id` bilan);
 *  - har paket o'z tranzaksiyasida; `lock_timeout` 5s — jonli ishni
 *    kutib qolmaydi, xato bo'lsa paket qaytariladi va qayta yurgizish
 *    qolganidan davom etadi;
 *  - bir vaqtda ikki nusxa yo'q (`pg_try_advisory_lock`).
 *
 * Summa — jonli yo'l (`FinanceServiceService.computeCommission`) bilan bir
 * xil qoida, faqat aniq `numeric` hisobida: foiz → round(narx × qiymat / 100, 2),
 * belgilangan → qiymat. Stavka — operatorning HOZIRGI stavkasi (ega qarori).
 */
import { randomUUID } from 'node:crypto';
import type { QueryRunner } from 'typeorm';
import { ORDER_OPERATOR_EARNING_STATUSES } from '@app/common';
import {
  addCreated,
  addPlanned,
  sortGroups,
  toCents,
  type EarningBackfillArgs,
  type EarningBackfillGroup,
  type EarningBackfillReport,
  type EarningBackfillStats,
  type EarningCandidate,
  formatCents,
} from './operator-earning-backfill';

export interface EarningBackfillSchemas {
  order: string;
  identity: string;
  finance: string;
}

export const DEFAULT_EARNING_BACKFILL_SCHEMAS: EarningBackfillSchemas = {
  order: 'order_schema',
  identity: 'identity_schema',
  finance: 'finance_schema',
};

const ADVISORY_LOCK_KEY = 'elchi:backfill-operator-earnings';

type Queryable = Pick<
  QueryRunner,
  'query' | 'startTransaction' | 'commitTransaction' | 'rollbackTransaction'
>;

function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`noto'g'ri sxema nomi: ${name}`);
  }
  return `"${name}"`;
}

const SOLD_STATUSES = ORDER_OPERATOR_EARNING_STATUSES.map(String);

function sql(schemas: EarningBackfillSchemas) {
  const orders = `${ident(schemas.order)}."orders"`;
  const admins = `${ident(schemas.identity)}."admins"`;
  const earnings = `${ident(schemas.finance)}."operator_earnings"`;
  const logs = `${ident(schemas.finance)}."activity_logs"`;

  const stats = `
    SELECT
      count(*) FILTER (WHERE o.operator_id IS NOT NULL)::int AS sold_with_operator,
      count(*) FILTER (WHERE o.operator_id IS NOT NULL AND live.ok)::int AS already_recorded,
      count(*) FILTER (
        WHERE o.operator_id IS NOT NULL AND NOT live.ok AND dead.ok
      )::int AS deleted_row_only,
      count(*) FILTER (
        WHERE o.operator_id IS NOT NULL AND NOT live.ok AND NOT dead.ok
          AND a.role::text = 'market_operator'
          AND (a.commission_type IS NULL OR COALESCE(a.commission_value, 0) <= 0)
      )::int AS operator_without_rate,
      count(*) FILTER (
        WHERE o.operator_id IS NOT NULL AND NOT live.ok AND NOT dead.ok
          AND (a.id IS NULL OR a.role::text <> 'market_operator')
      )::int AS operator_other_role,
      count(*) FILTER (
        WHERE o.operator_id IS NULL AND NULLIF(btrim(o.operator), '') IS NOT NULL
      )::int AS unlinked_text_only
    FROM ${orders} o
    LEFT JOIN ${admins} a ON a.id = o.operator_id
    CROSS JOIN LATERAL (
      SELECT EXISTS (
        SELECT 1 FROM ${earnings} e WHERE e.order_id = o.id AND e.is_deleted = false
      ) AS ok
    ) live
    CROSS JOIN LATERAL (
      SELECT EXISTS (
        SELECT 1 FROM ${earnings} e WHERE e.order_id = o.id AND e.is_deleted = true
      ) AS ok
    ) dead
    WHERE o.is_deleted = false AND o.status::text = ANY($1::text[])`;

  const candidates = `
    SELECT
      o.id::text AS order_id,
      o.market_id::text AS market_id,
      m.name AS market_name,
      o.operator_id::text AS operator_id,
      a.name AS operator_name,
      a.is_deleted AS operator_deleted,
      a.commission_type::text AS commission_type,
      a.commission_value::numeric(14, 2)::text AS commission_value,
      GREATEST(COALESCE(o.total_price, 0), 0)::numeric(14, 2)::text AS total_price,
      (CASE a.commission_type::text
         WHEN 'percent' THEN round(
           GREATEST(COALESCE(o.total_price, 0), 0) * a.commission_value / 100, 2)
         WHEN 'fixed' THEN round(a.commission_value, 2)
         ELSE 0
       END)::numeric(14, 2)::text AS amount
    FROM ${orders} o
    JOIN ${admins} a
      ON a.id = o.operator_id AND a.role::text = 'market_operator'
    LEFT JOIN ${admins} m
      ON m.id = o.market_id AND m.role::text = 'market'
    WHERE o.is_deleted = false
      AND o.status::text = ANY($1::text[])
      AND o.operator_id IS NOT NULL
      AND o.id > $2::bigint
      AND a.commission_type IS NOT NULL
      AND COALESCE(a.commission_value, 0) > 0
      AND NOT EXISTS (SELECT 1 FROM ${earnings} e WHERE e.order_id = o.id)
    ORDER BY o.id
    LIMIT $3`;

  // `WHERE NOT EXISTS` — qayta tekshiruv (nomzod tanlangandan keyin yozilgan
  // o'chirilgan qator ham tegilmasin); `ON CONFLICT` — jonli qator bilan poyga.
  const insert = `
    INSERT INTO ${earnings}
      (operator_id, order_id, market_id, amount, commission_type,
       commission_value, order_total_price)
    SELECT c.operator_id, c.order_id, c.market_id, c.amount, c.commission_type,
           c.commission_value, c.total_price
    FROM unnest(
      $1::bigint[], $2::bigint[], $3::bigint[], $4::numeric[], $5::varchar[],
      $6::numeric[], $7::numeric[]
    ) AS c(operator_id, order_id, market_id, amount, commission_type,
           commission_value, total_price)
    WHERE NOT EXISTS (SELECT 1 FROM ${earnings} e WHERE e.order_id = c.order_id)
    ON CONFLICT DO NOTHING
    RETURNING id::text AS id, order_id::text AS order_id,
              operator_id::text AS operator_id, market_id::text AS market_id,
              amount::text AS amount`;

  const log = `
    INSERT INTO ${logs}
      (entity_type, entity_id, action, old_value, new_value, user_id,
       user_name, user_role, service, metadata, description)
    VALUES ('OperatorEarning', $1, 'created', NULL, $2::jsonb, NULL,
            'ops: backfill-operator-earnings', 'system', 'finance-service',
            $3::jsonb, $4)`;

  return { stats, candidates, insert, log };
}

interface InsertedRow {
  id: string;
  order_id: string;
  operator_id: string;
  market_id: string | null;
  amount: string;
}

const rateText = (type: string, value: string) =>
  type === 'percent'
    ? `${Number(value)}%`
    : `${formatCents(toCents(value))} / buyurtma`;

export async function runOperatorEarningBackfill(
  q: Queryable,
  args: EarningBackfillArgs,
  log: (line: string) => void = () => undefined,
  schemas: EarningBackfillSchemas = DEFAULT_EARNING_BACKFILL_SCHEMAS,
): Promise<EarningBackfillReport> {
  const s = sql(schemas);
  const runId = randomUUID();

  if (args.apply) {
    const [lock] = (await q.query(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS ok',
      [ADVISORY_LOCK_KEY],
    )) as Array<{ ok: boolean }>;
    if (!lock?.ok) {
      throw new Error(
        'boshqa nusxa ishlayapti (advisory lock band) — tugashini kuting',
      );
    }
    // Jonli ishni kutib qolmaslik: qulf 5s da olinmasa paket qaytariladi.
    await q.query(`SET lock_timeout = '5s'`);
  }

  try {
    const [statsRow] = (await q.query(s.stats, [SOLD_STATUSES])) as Array<
      Record<keyof EarningBackfillStats, number>
    >;
    const stats: EarningBackfillStats = {
      sold_with_operator: Number(statsRow?.sold_with_operator ?? 0),
      already_recorded: Number(statsRow?.already_recorded ?? 0),
      deleted_row_only: Number(statsRow?.deleted_row_only ?? 0),
      operator_without_rate: Number(statsRow?.operator_without_rate ?? 0),
      operator_other_role: Number(statsRow?.operator_other_role ?? 0),
      unlinked_text_only: Number(statsRow?.unlinked_text_only ?? 0),
    };
    log(
      `[backfill] ${args.apply ? 'YOZISH' : 'DRY-RUN'} boshlandi, run_id=${runId}; operatorli sotilgan buyurtmalar: ${stats.sold_with_operator}`,
    );

    const groups = new Map<string, EarningBackfillGroup>();
    let zeroAmount = 0;
    let planned = 0;
    let plannedCents = 0;
    let created = 0;
    let createdCents = 0;
    let cursor = '0';

    for (;;) {
      const batch = (await q.query(s.candidates, [
        SOLD_STATUSES,
        cursor,
        args.batchSize,
      ])) as EarningCandidate[];
      if (!batch.length) break;
      cursor = batch[batch.length - 1].order_id;

      const rows = batch.filter((c) => toCents(c.amount) > 0);
      zeroAmount += batch.length - rows.length;
      addPlanned(groups, rows);
      planned += rows.length;
      plannedCents += rows.reduce((sum, c) => sum + toCents(c.amount), 0);

      if (args.apply && rows.length) {
        await q.startTransaction();
        try {
          const inserted = (await q.query(s.insert, [
            rows.map((c) => c.operator_id),
            rows.map((c) => c.order_id),
            rows.map((c) => c.market_id),
            rows.map((c) => c.amount),
            rows.map((c) => c.commission_type),
            rows.map((c) => c.commission_value),
            rows.map((c) => c.total_price),
          ])) as InsertedRow[];
          await writeAuditLogs(q, s.log, runId, rows, inserted);
          await q.commitTransaction();
          addCreated(groups, inserted);
          created += inserted.length;
          createdCents += inserted.reduce(
            (sum, row) => sum + toCents(row.amount),
            0,
          );
        } catch (error) {
          await q.rollbackTransaction();
          throw error;
        }
      }
      log(
        `[backfill] paket: ${batch.length} ta ko'rildi (oxirgi #${cursor}); ${
          args.apply ? `yozildi jami ${created}` : `yoziladi jami ${planned}`
        }`,
      );
      if (batch.length < args.batchSize) break;
    }

    return {
      apply: args.apply,
      run_id: runId,
      stats,
      zero_amount: zeroAmount,
      planned,
      planned_cents: plannedCents,
      created,
      created_cents: createdCents,
      groups: sortGroups(groups.values()),
    };
  } finally {
    if (args.apply) {
      await q.query('SELECT pg_advisory_unlock(hashtext($1))', [
        ADVISORY_LOCK_KEY,
      ]);
    }
  }
}

/**
 * Har (market, operator) uchun BITTA audit qatori — `metadata.order_ids` va
 * `earning_ids` bilan: kerak bo'lsa aynan shu yurgizishni topish/qaytarish
 * mumkin (`metadata->>'run_id'`).
 */
async function writeAuditLogs(
  q: Queryable,
  logSql: string,
  runId: string,
  rows: readonly EarningCandidate[],
  inserted: readonly InsertedRow[],
): Promise<void> {
  const byOrder = new Map(rows.map((c) => [c.order_id, c]));
  const byGroup = new Map<string, InsertedRow[]>();
  for (const row of inserted) {
    const key = `${row.market_id ?? '-'}:${row.operator_id}`;
    const list = byGroup.get(key) ?? [];
    list.push(row);
    byGroup.set(key, list);
  }
  for (const list of byGroup.values()) {
    const first = byOrder.get(list[0].order_id);
    if (!first) continue;
    const cents = list.reduce((sum, row) => sum + toCents(row.amount), 0);
    const amount = formatCents(cents).replace(/ /g, '');
    const rate = rateText(first.commission_type, first.commission_value);
    await q.query(logSql, [
      first.operator_id,
      JSON.stringify({ created: list.length, amount: cents / 100 }),
      JSON.stringify({
        reason: 'backfill',
        source: 'ops-script',
        run_id: runId,
        operator_id: first.operator_id,
        market_id: first.market_id,
        commission_type: first.commission_type,
        commission_value: Number(first.commission_value),
        order_ids: list.map((row) => row.order_id),
        earning_ids: list.map((row) => row.id),
      }),
      `Operator #${first.operator_id}: o'tgan ${list.length} ta sotuvga joriy stavka (${rate}) bo'yicha komissiya yozildi — jami ${amount}`,
    ]);
  }
}
