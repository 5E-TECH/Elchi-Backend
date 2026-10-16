import type { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AiOrderAppliedPrice1716000000119 } from '../../../../migrations/1716000000119-AiOrderAppliedPrice';
import {
  AiOrderDraft,
  AiOrderDraftItem,
} from '../entities/ai-order-draft.entity';
import { AiUsageLog } from '../entities/ai-usage-log.entity';
import { AiMarginService } from './ai-margin.service';

/**
 * NFiXfmq6 — `ai.usage.margin` SQL'i HAQIQIY Postgres'da: per-market charged
 * (muzlatilgan `applied_price_uzs`) va cost (`ai_usage_log.cost_uzs`) bir xil
 * Toshkent-kun oynasida, numeric → Number, 23:30 dagi yozuv o'sha kunga,
 * order_extract_image alohida, internal alohida, kesh tejovi, bo'sh davr 0.
 *
 * Faqat lokal test bazasida — jadvallar `synchronize` bilan yaratiladi va
 * oxirida sxema o'chiriladi:
 *   AI_MARGIN_PG_TEST_URI=postgres://postgres@127.0.0.1:<port>/elchi_ai_margin
 */
const uri = process.env.AI_MARGIN_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_ai_margin'
  );
})();

const DRAFT_A = '7a1b8c1e-0000-4000-8000-00000000000a';
const DRAFT_B = '7a1b8c1e-0000-4000-8000-00000000000b';

(localTestDatabase ? describe : describe.skip)(
  'NFiXfmq6 — AI marja hisoboti SQL (haqiqiy Postgres)',
  () => {
    let db: DataSource;
    let service: AiMarginService;

    beforeAll(async () => {
      db = new DataSource({
        type: 'postgres',
        url: uri,
        entities: [AiUsageLog, AiOrderDraft, AiOrderDraftItem],
        synchronize: false,
      });
      await db.initialize();
      await db.query('CREATE SCHEMA IF NOT EXISTS ai_schema');
      await db.synchronize();
      // Migratsiya sinxronlangan jadvalda ham xatosiz (IF NOT EXISTS).
      const qr = db.createQueryRunner();
      try {
        await new AiOrderAppliedPrice1716000000119().up(qr);
      } finally {
        await qr.release();
      }
      service = new AiMarginService(db.getRepository(AiUsageLog), {
        get: (key: string): unknown =>
          ({ AI_USD_UZS_RATE: 12800, AI_PRICE_PER_ORDER: 300 })[key],
      } as unknown as ConfigService);
    }, 60_000);

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS ai_schema CASCADE');
        await db.destroy();
      }
    });

    beforeEach(async () => {
      await db.query(
        'TRUNCATE ai_schema.ai_usage_log, ai_schema.ai_order_draft_item, ai_schema.ai_order_draft',
      );
      for (const [id, market] of [
        [DRAFT_A, '12'],
        [DRAFT_B, '34'],
      ]) {
        await db.query(
          `INSERT INTO ai_schema.ai_order_draft
             (id, market_id, source_kind, source_hash, model, prompt_version)
           VALUES ($1, $2, 'text', repeat('a', 64), 'claude-sonnet-5', 'v')`,
          [id, market],
        );
      }
    });

    async function usage(row: {
      at: string;
      market?: string | null;
      feature?: string;
      area?: string;
      uzs: number;
      usd?: number;
      images?: number;
      cacheRead?: number;
      cacheCreation?: number;
      savedUsd?: number;
      deleted?: boolean;
    }) {
      await db.query(
        `INSERT INTO ai_schema.ai_usage_log
           (feature, request_area, model, input_tokens, output_tokens, steps,
            cost_usd, cost_uzs, usd_uzs_rate, market_id, "createdAt",
            is_deleted, image_count, cache_read_tokens, cache_creation_tokens,
            cache_saved_usd)
         VALUES ($1, $2, 'claude-sonnet-5', 100, 50, 1, $3, $4, 12800, $5, $6,
                 $7, $8, $9, $10, $11)`,
        [
          row.feature ?? 'order_extract_multi',
          row.area ?? 'order',
          row.usd ?? row.uzs / 12800,
          row.uzs,
          row.market === undefined ? '12' : row.market,
          row.at,
          row.deleted ?? false,
          row.images ?? 0,
          row.cacheRead ?? 1000,
          row.cacheCreation ?? 0,
          row.savedUsd ?? 0,
        ],
      );
    }

    async function aiOrder(
      orderId: string,
      at: string,
      price: number | null,
      draft = DRAFT_A,
      market = '12',
    ) {
      await db.query(
        `INSERT INTO ai_schema.ai_order_draft_item
           (draft_id, item_index, order_id, market_id, confirmed_by, created_at,
            applied_price_uzs)
         VALUES ($1, 0, $2, $3, 7, $4, $5)`,
        [draft, orderId, market, at, price],
      );
    }

    it('TC1/TC2/TC3/TC8: per-market cost (ai_usage_log) va charged (applied_price_uzs) bir oynada; margin; Number', async () => {
      // 2026-10-01 (Toshkent) oynasi: [2026-09-30T19:00Z, 2026-10-01T19:00Z).
      await usage({ at: '2026-10-01T05:00:00Z', uzs: 1280.5 });
      await usage({ at: '2026-10-01T06:00:00Z', uzs: 256.25 });
      await usage({ at: '2026-10-01T07:00:00Z', uzs: 100, market: '34' });
      // Oynadan tashqari (oldingi Toshkent kuni 23:59) va o'chirilgan.
      await usage({ at: '2026-09-30T18:59:00Z', uzs: 99999 });
      await usage({ at: '2026-10-01T08:00:00Z', uzs: 5000, deleted: true });

      await aiOrder('501', '2026-10-01T05:10:00Z', 300);
      await aiOrder('502', '2026-10-01T06:10:00Z', 450);
      await aiOrder('503', '2026-10-01T06:20:00Z', 0, DRAFT_B, '34');
      await aiOrder('504', '2026-10-01T06:30:00Z', null, DRAFT_B, '34');
      // Oynadan tashqari charj.
      await aiOrder('505', '2026-09-30T18:50:00Z', 300);

      const r = await service.margin('2026-10-01', '2026-10-01');

      const m12 = r.byMarket.find((m) => m.marketId === '12')!;
      expect(m12).toMatchObject({
        costUzs: 1536.75,
        chargedUzs: 750,
        marginUzs: -786.75,
        marginNegative: true,
        calls: 2,
        aiOrders: 2,
      });
      expect(typeof m12.costUzs).toBe('number');
      expect(r.byMarket.find((m) => m.marketId === '34')).toMatchObject({
        costUzs: 100,
        chargedUzs: 0,
        aiOrders: 2,
        freeAiOrders: 1,
        unpricedAiOrders: 1,
      });
      expect(r.totals).toMatchObject({
        costUzs: 1636.75,
        chargedUzs: 750,
        marginUzs: -886.75,
        calls: 3,
        aiOrders: 4,
      });
    });

    it('TC9: Toshkent kuni — 30.09 23:30 (18:30Z) 30.09 ga, 01.10 00:30 (19:30Z) 01.10 ga', async () => {
      await usage({ at: '2026-09-30T18:30:00Z', uzs: 1000 });
      await usage({ at: '2026-09-30T19:30:00Z', uzs: 200 });
      await aiOrder('601', '2026-09-30T18:40:00Z', 300);
      await aiOrder('602', '2026-09-30T19:40:00Z', 300);

      const r = await service.margin('2026-09-30', '2026-10-01');
      expect(r.dailySeries).toEqual([
        {
          day: '2026-09-30',
          costUzs: 1000,
          chargedUzs: 300,
          marginUzs: -700,
          calls: 1,
          aiOrders: 1,
        },
        {
          day: '2026-10-01',
          costUzs: 200,
          chargedUzs: 300,
          marginUzs: 100,
          calls: 1,
          aiOrders: 1,
        },
      ]);
    });

    it('TC6/TC7: order_extract_image alohida va qimmat; internal — charj qilinmagan, market kesimiga kirmaydi', async () => {
      await usage({
        at: '2026-10-01T05:00:00Z',
        feature: 'order_extract_image',
        images: 2,
        uzs: 2560,
      });
      await usage({ at: '2026-10-01T05:00:00Z', uzs: 256 });
      await usage({ at: '2026-10-01T05:00:00Z', uzs: 256 });
      await usage({
        at: '2026-10-01T05:00:00Z',
        feature: 'finance_report',
        area: 'internal',
        market: null,
        uzs: 3840,
      });

      const r = await service.margin('2026-10-01', '2026-10-01');
      const image = r.byFeature.find(
        (f) => f.feature === 'order_extract_image',
      )!;
      const text = r.byFeature.find(
        (f) => f.feature === 'order_extract_multi',
      )!;
      expect(image).toMatchObject({ calls: 1, images: 2, costUzs: 2560 });
      expect(text).toMatchObject({ calls: 2, avgCostPerCallUzs: 256 });
      expect(image.avgCostPerCallUzs).toBeGreaterThan(text.avgCostPerCallUzs);

      expect(r.internal).toEqual({
        calls: 1,
        costUsd: 0.3,
        costUzs: 3840,
        charged: false,
      });
      expect(r.byMarket.map((m) => m.marketId)).toEqual(['12']);
      expect(r.byFeature.find((f) => f.area === 'internal')?.charged).toBe(
        false,
      );
      expect(r.totals.chargeableCostUzs).toBe(3072);
      expect(r.totals.costUzs).toBe(6912);
    });

    it('TC4/TC5: kesh tejovi cache_read ga proporsional; cache_read = 0 → 0 va alert', async () => {
      // cache_saved_usd = read × 3 × 0.9 / 1M (sonnet-5).
      await usage({
        at: '2026-10-01T05:00:00Z',
        uzs: 50,
        cacheRead: 10_000,
        cacheCreation: 1000,
        savedUsd: 0.027,
      });
      const one = await service.margin('2026-10-01', '2026-10-01');
      await usage({
        at: '2026-10-01T06:00:00Z',
        uzs: 50,
        cacheRead: 10_000,
        cacheCreation: 0,
        savedUsd: 0.027,
      });
      const two = await service.margin('2026-10-01', '2026-10-01');
      expect(one.cache.cacheSavedUzs).toBeCloseTo(345.6, 2);
      expect(two.cache.cacheSavedUzs).toBeCloseTo(691.2, 2);
      expect(one.cache.cacheWriteCostUzs).toBeCloseTo(9.6, 2);
      expect(one.alerts.some((a) => a.type.startsWith('cache_'))).toBe(false);

      await db.query('TRUNCATE ai_schema.ai_usage_log');
      await usage({
        at: '2026-10-01T05:00:00Z',
        uzs: 50,
        cacheRead: 0,
        cacheCreation: 4072,
      });
      const broken = await service.margin('2026-10-01', '2026-10-01');
      expect(broken.cache.cacheSavedUzs).toBe(0);
      expect(broken.alerts).toContainEqual(
        expect.objectContaining({ type: 'cache_broken' }),
      );
    });

    it('TC10: bo‘sh davr — xatosiz 0', async () => {
      const r = await service.margin('2026-10-01', '2026-10-02');
      expect(r.totals).toMatchObject({
        chargedUzs: 0,
        costUzs: 0,
        marginUzs: 0,
        calls: 0,
        aiOrders: 0,
      });
      expect(r.byMarket).toEqual([]);
      expect(r.dailySeries).toHaveLength(2);
      expect(r.alerts).toEqual([]);
    });

    it('TC11 (backend qismi): market filtri — faqat o‘z kesimi', async () => {
      await usage({ at: '2026-10-01T05:00:00Z', uzs: 100 });
      await usage({ at: '2026-10-01T05:00:00Z', uzs: 70, market: '34' });
      await aiOrder('701', '2026-10-01T05:10:00Z', 300);
      await aiOrder('702', '2026-10-01T05:10:00Z', 500, DRAFT_B, '34');

      const r = await service.margin('2026-10-01', '2026-10-01', '34');
      expect(r.marketId).toBe('34');
      expect(r.byMarket.map((m) => m.marketId)).toEqual(['34']);
      expect(r.totals).toMatchObject({ costUzs: 70, chargedUzs: 500 });
    });
  },
);
