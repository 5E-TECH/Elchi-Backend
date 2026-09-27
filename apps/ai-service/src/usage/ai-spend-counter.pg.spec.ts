import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { CreateAiSchema1716000000047 } from '../../../../migrations/1716000000047-CreateAiSchema';
import { AiSpendCounter } from '../entities/ai-spend-counter.entity';
import { AiUsageLog } from '../entities/ai-usage-log.entity';
import {
  AI_SPEND_READ_SQL,
  AiSpendCounterService,
} from './ai-spend-counter.service';
import { AiUsageService } from './ai-usage.service';
import { tashkentDay, TASHKENT_DAY_SQL } from './tashkent-day';

/**
 * HAQIQIY POSTGRES testi — FAQAT `AI_PG_TEST_URI` berilganda ishlaydi
 * (CI va oddiy `jest` da o'tkazib yuboriladi):
 *
 *   AI_PG_TEST_URI=postgres://user:pass@localhost:5432/db \
 *     NODE_ENV=test npx jest apps/ai-service/src/usage/ai-spend-counter.pg.spec.ts --runInBand
 *
 * ⚠️ Mavjud ma'lumotga TEGMAYDI: faqat 1999-yil period_key'lari va
 * tasodifiy trace_id bilan yozadi, oxirida o'zinikini o'chiradi. ai_schema
 * jadvallari bo'lmasa migratsiya `up()` qilinadi va oxirida `down()`.
 *
 * Qamrov: lYVuADRE #1/#9/#12/#13/#14, wFSMEIIy #3/#5/#20.
 */
const PG_URI = process.env.AI_PG_TEST_URI;
const describePg = PG_URI ? describe : describe.skip;

const DAY_PARALLEL = '1999-01-01';
const DAY_MARK = '1999-01-02';
const DAY_EXPLAIN = '1999-01-03';
const TEST_DAYS = [DAY_PARALLEL, DAY_MARK, DAY_EXPLAIN];

describePg('ai_spend_counter / ai_usage_log — real Postgres', () => {
  let ds: DataSource;
  let createdSchema = false;
  const marker = `pg-spec-${randomUUID()}`;
  const config = {
    get: (key: string): unknown =>
      ({ AI_USD_UZS_RATE: 12800, AI_ORDER_PRICE_UZS: 300 })[key],
  } as unknown as ConfigService;

  const cleanup = async (): Promise<void> => {
    await ds.query(
      `DELETE FROM ai_schema.ai_spend_counter WHERE scope = 'global' AND period_key = ANY($1::date[])`,
      [TEST_DAYS],
    );
    await ds.query(`DELETE FROM ai_schema.ai_usage_log WHERE trace_id = $1`, [
      marker,
    ]);
  };

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      url: PG_URI,
      entities: [AiSpendCounter, AiUsageLog],
      synchronize: false,
      extra: { max: 12 },
    });
    await ds.initialize();
    const probe = await ds.query<
      Array<{ counter: string | null; usage_log: string | null }>
    >(
      `SELECT to_regclass('ai_schema.ai_spend_counter') AS counter,
              to_regclass('ai_schema.ai_usage_log') AS usage_log`,
    );
    if (!probe[0]?.counter || !probe[0]?.usage_log) {
      const qr = ds.createQueryRunner();
      try {
        await new CreateAiSchema1716000000047().up(qr);
      } finally {
        await qr.release();
      }
      createdSchema = true;
    }
    await cleanup();
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await cleanup();
    if (createdSchema) {
      const qr = ds.createQueryRunner();
      try {
        // lYVuADRE #1: migratsiya orqaga qaytariladi (sxema ham o'chadi).
        await new CreateAiSchema1716000000047().down(qr);
        const left = (await qr.query(
          `SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = 'ai_schema'`,
        )) as Array<{ n: number }>;
        expect(left[0].n).toBe(0);
      } finally {
        await qr.release();
      }
    }
    await ds.destroy();
  });

  it('lYVuADRE #13: ai_schema da jadvallar va C12 indekslari mavjud', async () => {
    const rows = await ds.query<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'ai_schema'`,
    );
    const names = rows.map((r) => r.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        'PK_ai_usage_log',
        'PK_ai_spend_counter',
        'IDX_AIUSAGE_MARKET_CREATED',
        'IDX_AIUSAGE_FEATURE_CREATED',
        'IDX_AIUSAGE_AREA_CREATED',
        'IDX_AIUSAGE_DRAFT',
        'IDX_ACTIVITY_ENTITY_ai_schema',
      ]),
    );
  });

  it('lYVuADRE #9 / wFSMEIIy #3: parallel 10 ta add() — yig`indi aniq, calls = 10', async () => {
    const service = new AiSpendCounterService(ds.getRepository(AiSpendCounter));
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        service.add(DAY_PARALLEL, 0.123456, 1580.23),
      ),
    );
    // Har RETURNING o'zidan oldingilarni ko'radi — 10 xil jami.
    const seen = new Set(results.map((r) => r.cost_usd.toFixed(6)));
    expect(seen.size).toBe(10);

    const row = await service.read(DAY_PARALLEL);
    expect(row).not.toBeNull();
    expect(row?.calls).toBe(10);
    expect(row?.cost_usd).toBeCloseTo(1.23456, 6);
    expect(row?.cost_uzs).toBeCloseTo(15802.3, 2);
    expect(typeof row?.cost_usd).toBe('number');
    expect(row?.period_key).toBe(DAY_PARALLEL);
  });

  it('markWarned/markExceeded: parallel 5 ta — faqat BITTA g`olib', async () => {
    const service = new AiSpendCounterService(ds.getRepository(AiSpendCounter));
    await service.add(DAY_MARK, 1, 12800);
    const warned = await Promise.all(
      Array.from({ length: 5 }, () => service.markWarned(DAY_MARK)),
    );
    const exceeded = await Promise.all(
      Array.from({ length: 5 }, () => service.markExceeded(DAY_MARK)),
    );
    expect(warned.filter(Boolean)).toHaveLength(1);
    expect(exceeded.filter(Boolean)).toHaveLength(1);

    const override = await service.addOverride(DAY_MARK, 12.5);
    const override2 = await service.addOverride(DAY_MARK, 2.5);
    expect(override.override_usd).toBe(12.5);
    expect(override2.override_usd).toBe(15);
    expect(override2.warned_at).toBeInstanceOf(Date);
  });

  it('wFSMEIIy #20: read() PK indeksi bilan (Index Scan), jadval skanerlanmaydi', async () => {
    const service = new AiSpendCounterService(ds.getRepository(AiSpendCounter));
    await service.add(DAY_EXPLAIN, 0.5, 6400);
    const qr = ds.createQueryRunner();
    try {
      await qr.startTransaction();
      // Kichik jadvalda planner seq scan'ni afzal ko'rishi mumkin — so'rov
      // indeks bilan BAJARILA OLISHINI tekshirish uchun seq scan o'chiriladi.
      await qr.query('SET LOCAL enable_seqscan = off');
      const plan = (await qr.query(
        `EXPLAIN ${AI_SPEND_READ_SQL.replace('$1::date', `'${DAY_EXPLAIN}'::date`)}`,
      )) as Array<{ 'QUERY PLAN': string }>;
      const text = plan.map((p) => p['QUERY PLAN']).join('\n');
      expect(text).toMatch(/Index (Only )?Scan using "?PK_ai_spend_counter"?/);
      expect(text).not.toMatch(/Seq Scan/);
      await qr.rollbackTransaction();
    } finally {
      await qr.release();
    }
  });

  it('lYVuADRE #12/#23: SQL bucket Toshkent bo`yicha va JS tashkentDay bilan bir xil', async () => {
    const instants = [
      '2026-09-26T18:30:00Z', // Toshkent 23:30 → 26-kun
      '2026-09-26T19:30:00Z', // Toshkent 00:30 → 27-kun
      '2026-09-26T23:59:59Z', // UTC yarim tuni oldidan
      '2026-09-27T00:00:00Z', // UTC yarim tuni
    ];
    for (const iso of instants) {
      const rows = await ds.query<Array<{ day: string }>>(
        `SELECT ${TASHKENT_DAY_SQL}::text AS day FROM (VALUES ($1::timestamptz)) AS t("createdAt")`,
        [iso],
      );
      expect({ iso, day: rows[0].day }).toEqual({
        iso,
        day: tashkentDay(new Date(iso)),
      });
    }
  });

  it('record() → haqiqiy qator (entity ↔ migratsiya mos), numeric son bo`lib o`qiladi; summary + linkOrders SQL ishlaydi', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    try {
      const repo = ds.getRepository(AiUsageLog);
      const usage = new AiUsageService(repo, config);
      const draftId = randomUUID();
      usage.record({
        feature: 'order_extract_multi',
        requestArea: 'order',
        marketId: '12',
        userId: '34',
        traceId: marker,
        draftId,
        model: 'claude-sonnet-5',
        inputTokens: 1234,
        outputTokens: 567,
        cacheCreationTokens: 4072,
        cacheReadTokens: 89,
        steps: 1,
        stopReason: 'end_turn',
        outcome: 'ok',
        inputChars: 42,
        inputSha256: 'b'.repeat(64),
        imageCount: 0,
      });

      let row: AiUsageLog | null = null;
      for (let i = 0; i < 50 && !row; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        row = await repo.findOneBy({ trace_id: marker });
      }
      expect(usage.persistFailures()).toBe(0);
      expect(row).not.toBeNull();
      expect(typeof row?.cost_usd).toBe('number');
      expect(typeof row?.usd_uzs_rate).toBe('number');
      expect(row?.usd_uzs_rate).toBe(12800);
      expect(row?.applied_price_uzs).toBe(300);
      expect(row?.meta_incomplete).toBe(false);
      expect(row?.order_ids).toEqual([]);
      expect(row?.isDeleted).toBe(false);

      const linked = await usage.linkOrders(draftId, ['501', '502'], '12');
      expect(linked).toEqual({ updated: 1 });
      const again = await usage.linkOrders(draftId, ['502', '503'], '12');
      expect(again).toEqual({ updated: 1 });
      const foreign = await usage.linkOrders(draftId, ['999'], '13');
      expect(foreign).toEqual({ updated: 0 });
      const after = await repo.findOneBy({ trace_id: marker });
      expect(after?.order_ids.map(String)).toEqual(['501', '502', '503']);

      const today = tashkentDay(new Date());
      const summary = await usage.summary(today, today);
      expect(summary.calls).toBeGreaterThanOrEqual(1);
      expect(summary.linked_calls).toBeGreaterThanOrEqual(1);
      expect(typeof summary.total_usd).toBe('number');
      expect(summary.by_day.map((d) => d.day)).toContain(today);
      expect(
        summary.by_feature.find((f) => f.feature === 'order_extract_multi')
          ?.cache_read_tokens,
      ).toBeGreaterThanOrEqual(89);
    } finally {
      warn.mockRestore();
    }
  });
});
