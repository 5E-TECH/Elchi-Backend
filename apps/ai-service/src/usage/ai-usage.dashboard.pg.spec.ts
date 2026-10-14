import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AiUsageLog } from '../entities/ai-usage-log.entity';
import {
  AiOrderDraft,
  AiOrderDraftItem,
} from '../entities/ai-order-draft.entity';
import { AiUsageService } from './ai-usage.service';

/**
 * Celz3rKJ — `ai.usage.dashboard` / `ai.usage.ai_orders` HAQIQIY Postgres'da:
 * Toshkent kun bucketi (23:30 va 00:30 — turli kunlar), feature/model
 * kesimi, AI buyurtmalar (ai_order_draft_item) soni va draft xarajati.
 *
 * Faqat lokal test bazasida (prod/umumiy baza emas) — jadvallar shu bazada
 * `synchronize` bilan yaratiladi va oxirida sxema o'chiriladi:
 *   AI_DASHBOARD_PG_TEST_URI=postgres://postgres@127.0.0.1:<port>/elchi_h_ai
 */
const uri = process.env.AI_DASHBOARD_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_h_ai'
  );
})();

const DRAFT_A = '5f2b8c1e-0000-4000-8000-00000000000a';
const DRAFT_B = '5f2b8c1e-0000-4000-8000-00000000000b';

(localTestDatabase ? describe : describe.skip)(
  'Celz3rKJ — AI xarajat paneli SQL (haqiqiy Postgres)',
  () => {
    let db: DataSource;
    let service: AiUsageService;

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
      service = new AiUsageService(db.getRepository(AiUsageLog), {
        get: (key: string): unknown =>
          ({ AI_USD_UZS_RATE: 12800, AI_ORDER_PRICE_UZS: 300 })[key],
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
    });

    async function usage(row: {
      at: string;
      feature: string;
      area?: string;
      model?: string;
      usd: number;
      uzs: number;
      draft?: string | null;
      deleted?: boolean;
    }) {
      await db.query(
        `INSERT INTO ai_schema.ai_usage_log
           (feature, request_area, model, input_tokens, output_tokens, steps,
            cost_usd, cost_uzs, usd_uzs_rate, draft_id, "createdAt", is_deleted)
         VALUES ($1, $2, $3, 100, 50, 1, $4, $5, 12800, $6, $7, $8)`,
        [
          row.feature,
          row.area ?? 'order',
          row.model ?? 'claude-sonnet-5',
          row.usd,
          row.uzs,
          row.draft ?? null,
          row.at,
          row.deleted ?? false,
        ],
      );
    }

    async function aiOrder(orderId: string, draft: string, at: string) {
      await db.query(
        `INSERT INTO ai_schema.ai_order_draft_item
           (draft_id, item_index, order_id, market_id, confirmed_by, created_at)
         VALUES ($1, 0, $2, 12, 34, $3)`,
        [draft, orderId, at],
      );
    }

    it('⭐ TC5: kun Toshkent bo`yicha — 30.09 23:30 (18:30Z) 30.09 ga, 01.10 00:30 (19:30Z) 01.10 ga', async () => {
      await usage({
        at: '2026-09-30T18:30:00Z',
        feature: 'order_extract_multi',
        usd: 0.1,
        uzs: 1280,
      });
      await usage({
        at: '2026-09-30T19:30:00Z',
        feature: 'order_district',
        model: 'claude-haiku-4-5',
        usd: 0.02,
        uzs: 256,
      });
      await aiOrder('501', DRAFT_A, '2026-09-30T18:40:00Z');
      await aiOrder('502', DRAFT_A, '2026-09-30T19:40:00Z');
      // Davrdan tashqarida / o'chirilgan — hisobga tushmaydi.
      await usage({
        at: '2026-10-01T19:00:00Z', // 02.10 00:00 Toshkent
        feature: 'order_extract_multi',
        usd: 5,
        uzs: 64000,
      });
      await usage({
        at: '2026-09-30T20:00:00Z',
        feature: 'order_extract_multi',
        usd: 7,
        uzs: 89600,
        deleted: true,
      });

      const res = await service.dashboard('2026-09-30', '2026-10-01');

      expect(res.dailySeries).toEqual([
        {
          day: '2026-09-30',
          costUsd: 0.1,
          costUzs: 1280,
          calls: 1,
          aiOrders: 1,
        },
        {
          day: '2026-10-01',
          costUsd: 0.02,
          costUzs: 256,
          calls: 1,
          aiOrders: 1,
        },
      ]);
      expect(res.summary.totalCostUsd).toBe(0.12);
      expect(res.summary.totalCostUzs).toBe(1536);
      expect(res.summary.totalCalls).toBe(2);
      expect(res.summary.aiOrderCount).toBe(2);
      expect(res.summary.avgCostPerAiOrderUzs).toBe(768);
    }, 60_000);

    it('⭐ TC2/TC4: jami USD/so`m, feature va model kesimi — satr emas, son', async () => {
      for (let i = 0; i < 3; i += 1) {
        await usage({
          at: '2026-10-05T07:00:00Z',
          feature: 'order_extract_multi',
          usd: 0.1,
          uzs: 1280,
        });
      }
      await usage({
        at: '2026-10-05T08:00:00Z',
        feature: 'order_district',
        model: 'claude-haiku-4-5',
        usd: 0.2,
        uzs: 2560,
      });
      const res = await service.dashboard('2026-10-05', '2026-10-05');

      expect(res.summary.totalCostUsd).toBeCloseTo(0.5, 10);
      expect(res.summary.totalCostUzs).toBe(6400);
      expect(typeof res.summary.totalCostUzs).toBe('number');
      expect(res.byFeature.map((f) => [f.feature, f.calls, f.costUzs])).toEqual(
        [
          ['order_extract_multi', 3, 3840],
          ['order_district', 1, 2560],
        ],
      );
      expect(res.byModel.map((m) => [m.model, m.calls])).toEqual([
        ['claude-sonnet-5', 3],
        ['claude-haiku-4-5', 1],
      ]);
      expect(res.byArea).toEqual([
        {
          area: 'order',
          calls: 4,
          inputTokens: 400,
          outputTokens: 200,
          costUsd: 0.5,
          costUzs: 6400,
        },
      ]);
    }, 60_000);

    it('ai_orders: eng yangisi birinchi, draft xarajati va draftdagi buyurtmalar soni', async () => {
      await db.query(
        `INSERT INTO ai_schema.ai_order_draft
           (id, market_id, user_id, source_kind, source_hash, model, prompt_version)
         VALUES ($1, 12, 34, 'text', $2, 'claude-sonnet-5', 'v3')`,
        [DRAFT_A, 'a'.repeat(64)],
      );
      await usage({
        at: '2026-10-05T07:00:00Z',
        feature: 'order_extract_multi',
        usd: 0.012,
        uzs: 153.6,
        draft: DRAFT_A,
      });
      await usage({
        at: '2026-10-05T07:00:01Z',
        feature: 'order_district',
        usd: 0.003,
        uzs: 38.4,
        draft: DRAFT_A,
      });
      await aiOrder('501', DRAFT_A, '2026-10-05T07:01:00Z');
      await aiOrder('502', DRAFT_A, '2026-10-05T07:02:00Z');
      await aiOrder('600', DRAFT_B, '2026-10-05T09:00:00Z');

      const res = await service.aiOrders('2026-10-05', '2026-10-05', 2);
      expect(res.total).toBe(3);
      expect(res.limit).toBe(2);
      expect(res.items.map((i) => i.orderId)).toEqual(['600', '502']);
      const a = res.items[1];
      expect(a).toMatchObject({
        draftId: DRAFT_A,
        marketId: '12',
        confirmedBy: '34',
        model: 'claude-sonnet-5',
        sourceKind: 'text',
        draftCostUsd: 0.015,
        draftCostUzs: 192,
        draftOrders: 2,
      });
      // Draft'siz (xarajat qatori yo'q) — 0, null emas.
      expect(res.items[0]).toMatchObject({
        draftCostUsd: 0,
        draftCostUzs: 0,
        draftOrders: 1,
        model: null,
      });
    }, 60_000);
  },
);
