import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Logger } from '@nestjs/common';
import { DataSource, In, Logger as TypeOrmLogger } from 'typeorm';
import {
  ActivityLog,
  ActivityLogService,
  Order_status,
  OutboxEvent,
  OutboxService,
} from '@app/common';
import { OrderCustodyService } from './custody/order-custody.service';
import { Branch } from './entities/branch.entity';
import { OrderCustodyEvent } from './entities/order-custody-event.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderTracking } from './entities/order-tracking.entity';
import { Order, Order_source } from './entities/order.entity';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { OrderNotificationService } from './notification/order-notification.service';

const mockRmqSend = jest.fn();

jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return {
    ...actual,
    rmqSend: (...args: unknown[]) => mockRmqSend(...args),
  };
});

/**
 * UNUMDORLIK O'LCHOVI — HAQIQIY POSTGRES (D148eHMA TC1 / TC3).
 *
 *   "100 ta token bilan POST /orders/external/receive-by-scan ning umumiy
 *    vaqti (bitta-bitta yuborishga nisbatan)"
 *   "EXPLAIN ANALYZE bilan qr_code_token bo'yicha qidiruvda index scan
 *    ishlatilayotganini tasdiqlash"
 *
 * FAQAT `ORDER_PG_TEST_URI` berilganda ishlaydi (oddiy `jest` va CI'da skip).
 * Baza migratsiya qilingan bo'lishi SHART (`order_schema.orders`,
 * `order_tracking`, `order_custody_events`, `outbox_events`, `activity_logs`,
 * 058 dagi `IDX_ORDER_QR_CODE_TOKEN`):
 *
 *   POSTGRES_URI=… DB_SCHEMA=order_schema node -r ts-node/register \
 *     -r tsconfig-paths/register node_modules/typeorm/cli.js \
 *     migration:run -d typeorm.config.ts -t each
 *   ORDER_PG_TEST_URI=postgres://user:pass@127.0.0.1:5432/test_db \
 *     npx jest apps/order-service/src/order-service.receive-by-scan.bench.pg.spec.ts --runInBand
 *
 * Ixtiyoriy: `ORDER_BENCH_ROWS` (fon buyurtmalari, sukut 200000),
 * `PG_BENCH_OUT=<papka>`.
 *
 * NIMA HAQIQIY: `OrderLifecycleService.receiveExternalByScan` →
 * `receiveNewOrders` to'liq (token qidiruvlari, tranzaksiya, UPDATE,
 * `order_tracking`, custody, `OrderNotificationService` outbox'i, search
 * outbox'i, `activity_logs`). NIMA MOCK: boshqa servislar RPC'lari
 * (`rmqSend`: branch / identity / logistics) — kechikishi parametr
 * (0 ms — sof servis+DB; 10 ms — har RMQ hop taqlidi). Gateway HTTP/RMQ
 * hop'i va mijoz tarmog'i (prod: GET /scan median 0.40 s) KIRMAYDI.
 *
 * ⚠️ FAQAT TEST BAZASIDA. Barcha yozuvlar `market_id = BENCH_MARKET` bilan
 * belgilanadi va oxirida o'chiriladi.
 */
const PG_URI = process.env.ORDER_PG_TEST_URI;
const describePg = PG_URI ? describe : describe.skip;

const BACKGROUND_ROWS = Number(process.env.ORDER_BENCH_ROWS ?? 200_000);
const BENCH_MARKET = '990000001';
const HQ_ID = '1';
const TOKENS_PER_SCAN = 100;
const REGISTRATOR = { id: '301', roles: ['registrator'] };

interface Stats {
  runs: number;
  min: number;
  median: number;
  p95: number;
  max: number;
}

function stats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  const round = (v: number) => Math.round(v * 10) / 10;
  return {
    runs: sorted.length,
    min: round(sorted[0]),
    median: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted[sorted.length - 1]),
  };
}

/**
 * Servis yuborgan SQL'ni (parametrlari bilan) ushlab qoladi — EXPLAIN uchun;
 * so'rovlarni sanaydi va qabul tranzaksiyasining boshi/oxirini belgilaydi
 * (birinchi `START TRANSACTION` / `COMMIT` — `receiveNewOrders` TX'i; undan
 * keyingilari — har buyurtma uchun `activity_logs` `save()` tranzaksiyalari).
 */
class CapturingLogger implements TypeOrmLogger {
  enabled = false;
  captured: Array<{ query: string; parameters?: unknown[] }> = [];
  count = 0;
  marks: { tx_start?: number; tx_commit?: number } = {};
  reset() {
    this.count = 0;
    this.marks = {};
  }
  logQuery(query: string, parameters?: unknown[]) {
    this.count += 1;
    const now = performance.now();
    if (/^\s*START TRANSACTION/i.test(query)) this.marks.tx_start ??= now;
    else if (/^\s*COMMIT/i.test(query)) this.marks.tx_commit ??= now;
    if (this.enabled) this.captured.push({ query, parameters });
  }
  logQueryError() {}
  logQuerySlow() {}
  logSchemaBuild() {}
  logMigration() {}
  log() {}
}

describePg(
  'receive-by-scan — PG unumdorlik va qr_code_token indeksi (D148eHMA)',
  () => {
    let ds: DataSource;
    let service: OrderLifecycleService;
    const sqlLog = new CapturingLogger();
    const marker = randomUUID().replace(/-/g, '').slice(0, 10);
    const results: Record<string, unknown> = {};
    const plans: Record<string, string> = {};
    /** Har RPC hop kechikishi (ms). */
    let rpcLatencyMs = 0;
    let rpcCalls = 0;
    /** Navbatdagi bo'sh (NEW) skan partiyasi raqami. */
    let nextBatch = 0;

    const tokenOf = (batch: number, i: number) =>
      // 24 belgili hex — prod `generateCustomToken` bilan bir xil shakl.
      `${marker}${String(batch).padStart(4, '0')}${String(i).padStart(10, '0')}`
        .slice(0, 24)
        .replace(/[^0-9a-f]/g, 'a');

    const freshTokens = async (count: number) => {
      const batch = nextBatch++;
      const tokens = Array.from({ length: count }, (_, i) => tokenOf(batch, i));
      await ds.query(
        `INSERT INTO order_schema.orders
         (market_id, customer_id, status, source, qr_code_token, external_id,
          district_id, region_id, total_price, branch_id, holder_type, address)
       SELECT $1::bigint, 700000 + g, 'new', 'external', t, 'bench-' || t,
              12, 5, 150000, $2::bigint, 'HQ', 'Andijon, Asaka'
         FROM unnest($3::varchar[]) WITH ORDINALITY AS u(t, g)`,
        [BENCH_MARKET, HQ_ID, tokens],
      );
      return tokens;
    };

    const explain = async (
      name: string,
      sql: string,
      params: unknown[] = [],
    ) => {
      const rows = await ds.query<Array<{ 'QUERY PLAN': string }>>(
        `EXPLAIN (ANALYZE, BUFFERS) ${sql}`,
        params,
      );
      const text = rows.map((r) => r['QUERY PLAN']).join('\n');
      plans[name] = text;
      // eslint-disable-next-line no-console
      console.log(`[explain] ${name}\n${text}`);
      return text;
    };

    beforeAll(async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      mockRmqSend.mockImplementation(
        async (_client: unknown, pattern: { cmd: string }, payload: any) => {
          rpcCalls += 1;
          if (rpcLatencyMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, rpcLatencyMs));
          }
          switch (pattern.cmd) {
            case 'branch.user.find_by_user':
              return { data: { branch_id: HQ_ID } };
            case 'branch.find_hq':
              return { data: { id: HQ_ID } };
            case 'identity.customer.find_by_ids':
              return {
                data: (payload?.ids ?? []).map((id: string) => ({ id })),
              };
            case 'logistics.district.find_by_ids':
              return {
                data: (payload?.ids ?? []).map((id: string) => ({
                  id,
                  assigned_region: '5',
                })),
              };
            case 'logistics.post.receive_orders':
              return {
                data: (payload?.orders ?? []).map(
                  (o: { order_id: string }) => ({
                    order_id: o.order_id,
                    post_id: '9001',
                  }),
                ),
              };
            case 'logistics.region.find_all':
              return {
                data: [
                  {
                    id: '5',
                    name: 'Andijon',
                    logist_id: '77',
                    districts: [{ id: '12', name: 'Asaka' }],
                  },
                ],
              };
            default:
              return null;
          }
        },
      );

      ds = new DataSource({
        type: 'postgres',
        url: PG_URI,
        schema: 'order_schema',
        entities: [
          Order,
          OrderItem,
          OrderTracking,
          OrderCustodyEvent,
          Branch,
          OutboxEvent,
          ActivityLog,
        ],
        synchronize: false,
        logging: ['query'],
        logger: sqlLog,
      });
      await ds.initialize();
      const probe = await ds.query<Array<{ idx: string | null }>>(
        `SELECT to_regclass('order_schema."IDX_ORDER_QR_CODE_TOKEN"') AS idx`,
      );
      if (!probe[0]?.idx) {
        throw new Error(
          'order_schema migratsiya qilinmagan (IDX_ORDER_QR_CODE_TOKEN yo`q) — spec boshidagi buyruqni ishga tushiring',
        );
      }

      // Fon buyurtmalari — real hajmdagi jadval va indekslar (har birida token).
      await ds.query(
        `INSERT INTO order_schema.orders
         (market_id, customer_id, status, source, qr_code_token, district_id,
          region_id, total_price, branch_id, holder_type, "createdAt")
       SELECT $1::bigint, 500000 + (g % 40000),
              (ARRAY['sold','paid','cancelled','received','on the road','new'])[1 + g % 6]::order_schema.orders_status_enum,
              (CASE WHEN g % 10 < 7 THEN 'internal' ELSE 'external' END)::order_schema.orders_source_enum,
              substr(md5($2 || g::text), 1, 24), 12, 5, 150000, $3::bigint, 'HQ',
              now() - (g || ' minutes')::interval
         FROM generate_series(1, $4::int) AS g`,
        [BENCH_MARKET, marker, HQ_ID, BACKGROUND_ROWS],
      );
      await ds.query('ANALYZE order_schema.orders');

      const outbox = new OutboxService(ds.getRepository(OutboxEvent));
      const logisticsClient = {};
      const identityClient = {};
      const notifications = new OrderNotificationService(
        outbox,
        ds.getRepository(Order),
        logisticsClient as never,
        identityClient as never,
        {} as never,
      );
      const custody = new OrderCustodyService(
        ds.getRepository(OrderTracking),
        ds.getRepository(OrderCustodyEvent),
        notifications,
      );
      service = new OrderLifecycleService(
        ds,
        ds.getRepository(Order),
        ds.getRepository(OrderItem),
        ds.getRepository(OrderTracking),
        ds.getRepository(OrderCustodyEvent),
        {} as never, // OrderSettlement — bu yo'lda ishlatilmaydi
        {} as never, // OrderExtraCostApproval
        {} as never, // BranchTransferBatchItem
        identityClient as never,
        logisticsClient as never,
        {} as never, // FINANCE
        {} as never, // INTEGRATION
        {} as never, // BRANCH (rmqSend mock orqali)
        {} as never, // FILE
        outbox,
        new ActivityLogService(ds.getRepository(ActivityLog), 'order-service'),
        { getHqBranchId: () => Promise.resolve(HQ_ID) } as never,
        custody,
        notifications,
      );

      // Isitish: region kesh, rejalar, ulanish puli.
      for (let i = 0; i < 3; i += 1) {
        await service.receiveExternalByScan({
          tokens: await freshTokens(10),
          requester: REGISTRATOR,
        });
      }
    }, 600_000);

    afterAll(async () => {
      if (ds?.isInitialized) {
        // Iz faqat skanerlangan (`freshTokens`, external_id = 'bench-…')
        // buyurtmalarda qoladi; fon qatorlarida tracking/outbox/audit yo'q.
        const touched = await ds.query<Array<{ ids: string[] | null }>>(
          `SELECT array_agg(id::text) AS ids FROM order_schema.orders
            WHERE market_id = $1 AND external_id LIKE 'bench-%'`,
          [BENCH_MARKET],
        );
        const ids = touched[0]?.ids ?? [];
        if (ids.length) {
          await ds.query(
            `DELETE FROM order_schema.order_tracking WHERE order_id = ANY($1::bigint[])`,
            [ids],
          );
          await ds.query(
            `DELETE FROM order_schema.order_custody_events WHERE order_id = ANY($1::bigint[])`,
            [ids],
          );
          await ds.query(
            `DELETE FROM order_schema.activity_logs
              WHERE entity_type = 'Order' AND entity_id = ANY($1::text[])`,
            [ids],
          );
          await ds.query(
            `DELETE FROM order_schema.outbox_events
              WHERE payload->>'sourceId' = ANY($1::text[])
                 OR payload->'data'->>'order_id' = ANY($1::text[])`,
            [ids],
          );
        }
        await ds.query(`DELETE FROM order_schema.orders WHERE market_id = $1`, [
          BENCH_MARKET,
        ]);
        await ds.destroy();
      }
      const out = process.env.PG_BENCH_OUT;
      if (out) {
        mkdirSync(out, { recursive: true });
        writeFileSync(
          join(out, 'receive-by-scan.json'),
          JSON.stringify(
            { background_rows: BACKGROUND_ROWS, scenarios: results, plans },
            null,
            2,
          ),
        );
      }
      jest.restoreAllMocks();
    }, 300_000);

    const receive = (tokens: string[]) =>
      service.receiveExternalByScan({
        tokens,
        requester: REGISTRATOR,
      }) as Promise<{
        data: { ok: boolean; received: number; unmatched: unknown[] };
      }>;

    const benchBatch = async (name: string, runs: number) => {
      const samples: number[] = [];
      const phases: Record<'lookup' | 'tx' | 'audit', number[]> = {
        lookup: [],
        tx: [],
        audit: [],
      };
      let queries = 0;
      let rpcs = 0;
      for (let run = 0; run < runs; run += 1) {
        const tokens = await freshTokens(TOKENS_PER_SCAN);
        sqlLog.reset();
        rpcCalls = 0;
        const started = performance.now();
        const res = await receive(tokens);
        const ended = performance.now();
        samples.push(ended - started);
        queries = sqlLog.count;
        rpcs = rpcCalls;
        expect(res.data).toMatchObject({ ok: true, received: TOKENS_PER_SCAN });
        const { tx_start: txStart, tx_commit: txCommit } = sqlLog.marks;
        if (txStart !== undefined && txCommit !== undefined) {
          // lookup — token qidiruvlari + RPC'lar; tx — UPDATE/tracking/outbox
          // sikli; audit — TX'dan keyin har buyurtmaga alohida log().
          phases.lookup.push(txStart - started);
          phases.tx.push(txCommit - txStart);
          phases.audit.push(ended - txCommit);
        }
      }
      const result = {
        mode: `1 so'rov × ${TOKENS_PER_SCAN} token`,
        rpc_latency_ms: rpcLatencyMs,
        ...stats(samples),
        phase_median_ms: {
          lookup_and_rpc: stats(phases.lookup).median,
          receive_tx: stats(phases.tx).median,
          audit_after_tx: stats(phases.audit).median,
        },
        samples_ms: samples.map((v) => Math.round(v)),
        sql_queries_per_request: queries,
        rpc_calls_per_request: rpcs,
      };
      results[name] = result;
      // eslint-disable-next-line no-console
      console.log(`[bench] ${name}: ${JSON.stringify(result)}`);
      return result;
    };

    const benchSingles = async (name: string, runs: number) => {
      const totals: number[] = [];
      const perCall: number[] = [];
      let queries = 0;
      let rpcs = 0;
      for (let run = 0; run < runs; run += 1) {
        const tokens = await freshTokens(TOKENS_PER_SCAN);
        sqlLog.reset();
        rpcCalls = 0;
        const started = performance.now();
        for (const token of tokens) {
          const t0 = performance.now();
          const res = await receive([token]);
          perCall.push(performance.now() - t0);
          expect(res.data).toMatchObject({ ok: true, received: 1 });
        }
        totals.push(performance.now() - started);
        queries = sqlLog.count;
        rpcs = rpcCalls;
      }
      const result = {
        mode: `${TOKENS_PER_SCAN} so'rov × 1 token (ketma-ket)`,
        rpc_latency_ms: rpcLatencyMs,
        total: stats(totals),
        per_call: stats(perCall),
        total_samples_ms: totals.map((v) => Math.round(v)),
        sql_queries_per_100: queries,
        rpc_calls_per_100: rpcs,
      };
      results[name] = result;
      // eslint-disable-next-line no-console
      console.log(`[bench] ${name}: ${JSON.stringify(result)}`);
      return result;
    };

    it('TC1 100 token: bitta batch vs 100 ta alohida chaqiruv (RPC 0 ms)', async () => {
      rpcLatencyMs = 0;
      const batch = await benchBatch('batch100_rpc0', 7);
      const singles = await benchSingles('single100_rpc0', 3);
      results.speedup_rpc0 =
        Math.round((singles.total.median / batch.median) * 10) / 10;
      expect(batch.median).toBeLessThan(singles.total.median);
    }, 600_000);

    it('TC1 100 token: bitta batch vs 100 ta alohida chaqiruv (RPC 10 ms taqlidi)', async () => {
      rpcLatencyMs = 10;
      const batch = await benchBatch('batch100_rpc10', 5);
      const singles = await benchSingles('single100_rpc10', 2);
      rpcLatencyMs = 0;
      results.speedup_rpc10 =
        Math.round((singles.total.median / batch.median) * 10) / 10;
      expect(batch.median).toBeLessThan(singles.total.median);
      // Gateway `receive-by-scan` RMQ timeouti 15 000 ms — 100 token undan uzoq.
      expect(batch.max).toBeLessThan(15_000);
    }, 600_000);

    it('TC3 EXPLAIN ANALYZE: qr_code_token qidiruvlari IDX_ORDER_QR_CODE_TOKEN ishlatadi', async () => {
      const tokens = await freshTokens(TOKENS_PER_SCAN);
      // Bitta noma'lum token — "topilmadi" sababi uchun findOne yo'li ham yursin.
      const unknown = 'ffffffffffffffffffff0000';
      sqlLog.captured = [];
      sqlLog.enabled = true;
      const res = await receive([...tokens, unknown]);
      sqlLog.enabled = false;
      expect(res.data.received).toBe(TOKENS_PER_SCAN);

      const selects = sqlLog.captured.filter((c) =>
        /^\s*SELECT .* FROM "order_schema"\."orders"/is.test(c.query),
      );
      const byQrIn = selects.find((c) =>
        /"qr_code_token" IN \(/i.test(c.query),
      );
      const byBatchIn = selects.find((c) =>
        /"external_batch_token" IN \(/i.test(c.query),
      );
      const byQrEq = selects.find((c) =>
        /"qr_code_token" = \$1/i.test(c.query),
      );
      expect(byQrIn && byBatchIn && byQrEq).toBeTruthy();
      results.captured_sql = {
        qr_in: byQrIn!.query,
        batch_in: byBatchIn!.query,
        qr_eq: byQrEq!.query,
      };

      const qrInPlan = await explain(
        'receive_qr_code_token_in_100',
        byQrIn!.query,
        byQrIn!.parameters ?? [],
      );
      // 100 ta token qabul qilingan — endi ular RECEIVED: shart NEW bo'lgani
      // uchun 0 qator qaytaradi, lekin reja (indeks) baribir ko'rinadi. Qabuldan
      // OLDINGI holatni ham o'lchash uchun yangi partiya bilan qayta EXPLAIN:
      const fresh = await freshTokens(TOKENS_PER_SCAN);
      const swap = new Map(tokens.map((token, i) => [token, fresh[i]]));
      const params = (byQrIn!.parameters ?? []).map(
        (value) => swap.get(value as string) ?? value,
      );
      const qrInFreshPlan = await explain(
        'receive_qr_code_token_in_100_before_receive',
        byQrIn!.query,
        params,
      );
      const batchInPlan = await explain(
        'receive_external_batch_token_in',
        byBatchIn!.query,
        byBatchIn!.parameters ?? [],
      );
      const qrEqPlan = await explain(
        'receive_unmatched_qr_code_token_eq',
        byQrEq!.query,
        byQrEq!.parameters ?? [],
      );

      // GET /scan/{token} (`findByQrCodeLight` / `findByQrCode`) — xuddi shu
      // WHERE (`qr_code_token = $1 AND is_deleted = false`).
      sqlLog.captured = [];
      sqlLog.enabled = true;
      await ds.getRepository(Order).findOne({
        where: { qr_code_token: fresh[0], isDeleted: false },
        relations: { items: true },
      });
      sqlLog.enabled = false;
      const scanSql = sqlLog.captured.find((c) =>
        /qr_code_token/.test(c.query),
      );
      const scanPlan = await explain(
        'scan_find_by_qr_code',
        scanSql!.query,
        scanSql!.parameters ?? [],
      );

      const qrIndex =
        /(Index Scan|Bitmap Index Scan) (using|on) "IDX_ORDER_QR_CODE_TOKEN"/;
      expect(qrInPlan).toMatch(qrIndex);
      expect(qrInFreshPlan).toMatch(qrIndex);
      expect(qrEqPlan).toMatch(qrIndex);
      expect(scanPlan).toMatch(qrIndex);
      expect(batchInPlan).toMatch(/IDX_ORDERS_EXTERNAL_BATCH_TOKEN/);
      for (const plan of [qrInPlan, qrInFreshPlan, qrEqPlan, scanPlan]) {
        expect(plan).not.toMatch(/Seq Scan on orders/);
      }

      const table = await ds.query<
        Array<{ rows: string; size: string; idx: string }>
      >(
        `SELECT (SELECT count(*) FROM order_schema.orders)::text AS rows,
              pg_size_pretty(pg_total_relation_size('order_schema.orders')) AS size,
              pg_size_pretty(pg_relation_size('order_schema."IDX_ORDER_QR_CODE_TOKEN"')) AS idx`,
      );
      results.table = table[0];
      // eslint-disable-next-line no-console
      console.log(`[bench] table: ${JSON.stringify(table[0])}`);

      // Qabul qilingan holatni tekshirish (to'g'rilik — tezlik emas).
      const received = await ds.getRepository(Order).count({
        where: {
          qr_code_token: In(tokens),
          source: Order_source.EXTERNAL,
          status: Order_status.RECEIVED,
          post_id: '9001',
        },
      });
      expect(received).toBe(TOKENS_PER_SCAN);
    }, 300_000);
  },
);
