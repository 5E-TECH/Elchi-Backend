import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Logger } from '@nestjs/common';
import { of, timer } from 'rxjs';
import { map } from 'rxjs/operators';
import { DataSource, Logger as TypeOrmLogger } from 'typeorm';
import { ActivityLog, ActivityLogService } from '@app/common';
import { CreateActivityLogsTables1714800000000 } from '../../../migrations/1714800000000-CreateActivityLogsTables';
import { ExtendActivityLogsCoverage1716000000009 } from '../../../migrations/1716000000009-ExtendActivityLogsCoverage';
import { CreateNotifications1716000000008 } from '../../../migrations/1716000000008-CreateNotifications';
import { Notification } from './entities/notification.entity';
import { NotificationInboxService } from './notification-inbox.service';

const mockRmqSend = jest.fn();

jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return {
    ...actual,
    rmqSend: (...args: unknown[]) => mockRmqSend(...args),
  };
});

/**
 * UNUMDORLIK O'LCHOVI — HAQIQIY POSTGRES (QFoRULeu TC1 / TC9 va 4-qadam).
 *
 *   "1000 qabul qiluvchili dispatch lokal testda < 2 s da tugaydi"
 *   "5000 qabul qiluvchili dispatch gateway 8000 ms timeoutiga tushmaydi"
 *
 * FAQAT `NOTIFICATION_PG_TEST_URI` berilganda ishlaydi (oddiy `jest` va CI'da
 * skip):
 *
 *   NOTIFICATION_PG_TEST_URI=postgres://user:pass@127.0.0.1:5432/test_db \
 *     npx jest apps/notification-service/src/notification-inbox.dispatch.bench.pg.spec.ts --runInBand
 *
 * Ixtiyoriy: `PG_BENCH_OUT=<papka>` — natijalar JSON fayl bo'lib yoziladi.
 *
 * NIMA HAQIQIY: `NotificationInboxService.dispatch` to'liq (tranzaksiya,
 * `persistRows` bulk INSERT, qayta o'qish, `recordDelivery` UPDATE, audit
 * qatori `ActivityLogService` orqali `notification_schema.activity_logs` ga).
 * NIMA MOCK: realtime emit (`GATEWAY` ClientProxy), Telegram relay, SMS
 * navbati, push outbox, identity RPC (`rmqSend`). Mock kechikishi ATAYLAB
 * parametr: 0 ms — sof servis+DB vaqti; >0 — RMQ publish/RPC ni taqlid.
 *
 * ⚠️ FAQAT TEST BAZASIDA. Jadvallar bo'lmasa migratsiya `up()` qilinadi.
 * Yozilgan qatorlar tasodifiy `type` (`x.bench.*`) bilan belgilanadi va
 * oxirida o'chiriladi.
 */
const PG_URI = process.env.NOTIFICATION_PG_TEST_URI;
const describePg = PG_URI ? describe : describe.skip;

/** Kartadagi chegaralar. */
const LIMIT_1000_MS = 2_000;
const GATEWAY_TIMEOUT_MS = 8_000;
/** Qabul qiluvchi id'lari — haqiqiy foydalanuvchilar bilan to'qnashmasin. */
const RECIPIENT_BASE = 9_100_000_000;
/** Jadvalda "fon" qatorlari — indekslar bo'sh jadvaldagidek arzon bo'lmasin. */
const BASELINE_ROWS = Number(process.env.NOTIF_BENCH_BASE_ROWS ?? 50_000);

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
 * SQL'ni sanaydi (INSERT/UPDATE/SELECT soni — "N ta emas, chunk soni") va
 * bosqich chegaralarini belgilaydi: tranzaksiya boshi/oxiri, `delivery`
 * UPDATE'i, audit INSERT'i (so'rov YUBORILGAN payt).
 */
class CountingLogger implements TypeOrmLogger {
  counts = { insert: 0, update: 0, select: 0, other: 0 };
  marks: Record<string, number> = {};
  reset() {
    this.counts = { insert: 0, update: 0, select: 0, other: 0 };
    this.marks = {};
  }
  logQuery(query: string) {
    const now = performance.now();
    const text = query.trimStart();
    const head = text.slice(0, 6).toUpperCase();
    if (head === 'INSERT') this.counts.insert += 1;
    else if (head === 'UPDATE') this.counts.update += 1;
    else if (head === 'SELECT') this.counts.select += 1;
    else this.counts.other += 1;
    if (/^START TRANSACTION/i.test(text)) this.marks.tx_start ??= now;
    else if (/^COMMIT/i.test(text)) this.marks.tx_commit ??= now;
    // group_key yo'lida TX ichida ham `delivery` UPDATE bor — faqat COMMIT'dan keyingisi.
    else if (
      this.marks.tx_commit !== undefined &&
      /^UPDATE .*"delivery"/is.test(text)
    )
      this.marks.delivery ??= now;
    else if (/^INSERT INTO .*activity_logs/is.test(text))
      this.marks.audit ??= now;
  }
  logQueryError() {}
  logQuerySlow() {}
  logSchemaBuild() {}
  logMigration() {}
  log() {}
}

describePg(
  'NotificationInboxService.dispatch — PG unumdorlik (QFoRULeu)',
  () => {
    let ds: DataSource;
    let service: NotificationInboxService;
    const sqlLog = new CountingLogger();
    const markerType = `x.bench.${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const results: Record<string, unknown> = {};

    /** Realtime emit kechikishi (ms) — har senariy o'zi o'rnatadi. */
    let emitLatencyMs = 0;
    /** identity.user.find_all sahifasi kechikishi (ms). */
    let identityLatencyMs = 0;
    let emitCount = 0;

    const gatewayClient = {
      emit: jest.fn(() => {
        emitCount += 1;
        return emitLatencyMs > 0
          ? timer(emitLatencyMs).pipe(map(() => null))
          : of(null);
      }),
    };
    const telegramService = {
      sendNotification: jest.fn(() =>
        Promise.resolve({
          data: { success: 1, failed: 0, results: [{ ok: true }] },
        }),
      ),
    };
    const pushDelivery = { enqueue: jest.fn(() => Promise.resolve()) };
    const smsDispatch = {
      assertFanout: jest.fn(),
      queueForNotifications: jest.fn((rows: unknown[]) =>
        Promise.resolve({ sms: rows.length, sms_status: 'queued' }),
      ),
    };

    const recipientIds = (n: number) =>
      Array.from({ length: n }, (_, i) => String(RECIPIENT_BASE + i));

    const runScenario = async (
      name: string,
      runs: number,
      buildDto: (run: number) => Record<string, unknown>,
      expectDispatched: number,
    ) => {
      const samples: number[] = [];
      const phaseSamples: Record<string, number[]> = {};
      let queries = sqlLog.counts;
      let emits = 0;
      for (let run = 0; run < runs; run += 1) {
        sqlLog.reset();
        emitCount = 0;
        const dto = buildDto(run);
        const started = performance.now();
        const response = (await service.dispatch(dto as never)) as
          | { data?: { dispatched?: number } }
          | undefined;
        const ended = performance.now();
        samples.push(ended - started);
        expect(response?.data?.dispatched).toBe(expectDispatched);
        queries = { ...sqlLog.counts };
        emits = emitCount;
        // Bosqichlar: resolve (identity) → persist (TX) → realtime+telegram →
        // delivery UPDATE + audit.
        const m = sqlLog.marks;
        const after = m.delivery ?? m.audit ?? ended;
        const phases: Record<string, number | undefined> = {
          resolve: m.tx_start !== undefined ? m.tx_start - started : undefined,
          persist_tx:
            m.tx_start !== undefined && m.tx_commit !== undefined
              ? m.tx_commit - m.tx_start
              : undefined,
          channels: m.tx_commit !== undefined ? after - m.tx_commit : undefined,
          delivery_and_audit: ended - after,
        };
        for (const [key, value] of Object.entries(phases)) {
          if (value === undefined) continue;
          (phaseSamples[key] ??= []).push(value);
        }
      }
      const phaseMedians = Object.fromEntries(
        Object.entries(phaseSamples).map(([key, values]) => [
          key,
          stats(values).median,
        ]),
      );
      const result = {
        ...stats(samples),
        phase_median_ms: phaseMedians,
        samples_ms: samples.map((v) => Math.round(v)),
        emit_latency_ms: emitLatencyMs,
        identity_latency_ms: identityLatencyMs,
        queries_last_run: queries,
        realtime_emits_last_run: emits,
      };
      results[name] = result;
      // eslint-disable-next-line no-console
      console.log(`[bench] ${name}: ${JSON.stringify(result)}`);
      return result;
    };

    beforeAll(async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      ds = new DataSource({
        type: 'postgres',
        url: PG_URI,
        schema: 'notification_schema',
        entities: [Notification, ActivityLog],
        synchronize: false,
        logging: ['query'],
        logger: sqlLog,
      });
      await ds.initialize();
      const probe = await ds.query<
        Array<{ notif: string | null; audit: string | null }>
      >(
        `SELECT to_regclass('notification_schema.notifications') AS notif,
              to_regclass('notification_schema.activity_logs') AS audit`,
      );
      const qr = ds.createQueryRunner();
      try {
        if (!probe[0]?.notif)
          await new CreateNotifications1716000000008().up(qr);
        if (!probe[0]?.audit) {
          await new CreateActivityLogsTables1714800000000().up(qr);
          await new ExtendActivityLogsCoverage1716000000009().up(qr);
        }
        // Audit entity'da `description` bor (1716000000062) — ustun bo'lmasa
        // log() INSERT'i jimgina yiqilardi va o'lchov arzon chiqardi.
        await qr.query(
          `ALTER TABLE notification_schema.activity_logs
           ADD COLUMN IF NOT EXISTS "description" TEXT NULL`,
        );
      } finally {
        await qr.release();
      }

      // Fon qatorlari (shu marker bilan) — 4 ta btree indeks real hajmda.
      await ds.query(
        `INSERT INTO notification_schema.notifications
         (recipient_id, recipient_role, type, title, channels, delivery)
       SELECT $2::bigint + (g % 5000), 'logist', $1, 'fon', '["in_app"]'::jsonb,
              '{"in_app":"sent"}'::jsonb
         FROM generate_series(1, $3::int) AS g`,
        [markerType, RECIPIENT_BASE, BASELINE_ROWS],
      );
      await ds.query('ANALYZE notification_schema.notifications');

      service = new NotificationInboxService(
        ds.getRepository(Notification),
        { send: jest.fn() } as never,
        gatewayClient as never,
        telegramService as never,
        new ActivityLogService(
          ds.getRepository(ActivityLog),
          'notification-service',
        ),
        pushDelivery as never,
        smsDispatch as never,
      );

      // Isitish: ulanish puli, katalog keshlari, birinchi rejalar.
      for (let i = 0; i < 3; i += 1) {
        await service.dispatch({
          type: markerType,
          title: 'isitish',
          recipient_ids: recipientIds(50),
        } as never);
      }
    }, 300_000);

    afterAll(async () => {
      if (ds?.isInitialized) {
        await ds.query(
          `DELETE FROM notification_schema.notifications WHERE type = $1`,
          [markerType],
        );
        await ds.query(
          `DELETE FROM notification_schema.activity_logs
          WHERE action = 'notification.dispatched' AND metadata->>'type' = $1`,
          [markerType],
        );
        await ds.destroy();
      }
      const out = process.env.PG_BENCH_OUT;
      if (out) {
        mkdirSync(out, { recursive: true });
        writeFileSync(
          join(out, 'notification-dispatch.json'),
          JSON.stringify(
            { baseline_rows: BASELINE_ROWS, scenarios: results },
            null,
            2,
          ),
        );
      }
      jest.restoreAllMocks();
    }, 120_000);

    const explicitDto = (n: number) => () => ({
      type: markerType,
      title: 'Benchmark xabari',
      body: 'Unumdorlik o`lchovi',
      recipient_ids: recipientIds(n),
    });

    it('aniq recipient_ids: 1 / 100 / 1000 / 5000 (emit 0 ms) — TC1 < 2 s, TC9 < 8 s', async () => {
      emitLatencyMs = 0;
      await runScenario('explicit_n1_emit0', 9, explicitDto(1), 1);
      await runScenario('explicit_n100_emit0', 9, explicitDto(100), 100);
      const n1000 = await runScenario(
        'explicit_n1000_emit0',
        9,
        explicitDto(1000),
        1000,
      );
      const n5000 = await runScenario(
        'explicit_n5000_emit0',
        5,
        explicitDto(5000),
        5000,
      );
      // "1 ta (yoki chunk soni) INSERT": 1000 → 2 chunk + 1 audit = 3.
      expect(n1000.queries_last_run.insert).toBe(3);
      expect(n5000.queries_last_run.insert).toBe(11);
      expect(n1000.p95).toBeLessThan(LIMIT_1000_MS);
      expect(n5000.max).toBeLessThan(GATEWAY_TIMEOUT_MS);
    }, 300_000);

    it('aniq recipient_ids: 1000 / 5000 — realtime emit 2 ms (RMQ publish taqlidi)', async () => {
      emitLatencyMs = 2;
      const n1000 = await runScenario(
        'explicit_n1000_emit2',
        5,
        explicitDto(1000),
        1000,
      );
      const n5000 = await runScenario(
        'explicit_n5000_emit2',
        3,
        explicitDto(5000),
        5000,
      );
      emitLatencyMs = 0;
      expect(n1000.realtime_emits_last_run).toBe(1000);
      expect(n1000.p95).toBeLessThan(LIMIT_1000_MS);
      expect(n5000.max).toBeLessThan(GATEWAY_TIMEOUT_MS);
    }, 300_000);

    it('roles:[logist] 5000 (identity 50 sahifa) — BITTA guruh emit', async () => {
      const page = (pageNo: number) => ({
        data: {
          items: Array.from({ length: 100 }, (_, i) => ({
            id: String(RECIPIENT_BASE + (pageNo - 1) * 100 + i),
            role: 'logist',
          })),
          meta: { total: 5000 },
        },
      });
      mockRmqSend.mockImplementation(
        async (_client: unknown, _pattern: unknown, payload: any) => {
          if (identityLatencyMs > 0) {
            await new Promise((resolve) =>
              setTimeout(resolve, identityLatencyMs),
            );
          }
          return page(Number(payload?.query?.page ?? 1));
        },
      );
      const rolesDto = () => ({
        type: markerType,
        title: 'Rol xabari',
        roles: ['logist'],
      });
      identityLatencyMs = 0;
      const fast = await runScenario(
        'roles_n5000_identity0',
        5,
        rolesDto,
        5000,
      );
      identityLatencyMs = 10;
      const slow = await runScenario(
        'roles_n5000_identity10',
        3,
        rolesDto,
        5000,
      );
      identityLatencyMs = 0;
      expect(fast.realtime_emits_last_run).toBe(1);
      expect(fast.max).toBeLessThan(GATEWAY_TIMEOUT_MS);
      expect(slow.max).toBeLessThan(GATEWAY_TIMEOUT_MS);
    }, 300_000);

    it('group_key qayta dispatch (UPDATE yo`li) 1000 — qator soni oshmaydi', async () => {
      const groupKey = `bench:${randomUUID()}`;
      const dto = () => ({ ...explicitDto(1000)(), group_key: groupKey });
      await service.dispatch(dto() as never); // birinchi — INSERT
      const before = await ds.query<Array<{ c: string }>>(
        `SELECT count(*)::text AS c FROM notification_schema.notifications WHERE group_key = $1`,
        [groupKey],
      );
      const res = await runScenario('group_key_update_n1000', 5, dto, 1000);
      const after = await ds.query<Array<{ c: string }>>(
        `SELECT count(*)::text AS c FROM notification_schema.notifications WHERE group_key = $1`,
        [groupKey],
      );
      expect(after[0].c).toBe(before[0].c);
      expect(res.queries_last_run.insert).toBe(1); // faqat audit qatori
      expect(res.p95).toBeLessThan(LIMIT_1000_MS);
    }, 300_000);

    it('barcha kanallar (in_app+realtime+telegram+sms, mock) 1000', async () => {
      const dto = () => ({
        ...explicitDto(1000)(),
        channels: ['in_app', 'realtime', 'telegram', 'sms'],
        telegram: { market_id: '1' },
      });
      const res = await runScenario('all_channels_n1000', 5, dto, 1000);
      expect(telegramService.sendNotification).toHaveBeenCalled();
      expect(res.p95).toBeLessThan(LIMIT_1000_MS);
    }, 300_000);
  },
);
