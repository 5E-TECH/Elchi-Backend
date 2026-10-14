import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { CreateAiSchema1716000000047 } from '../../../../migrations/1716000000047-CreateAiSchema';
import { CreateAiOrderDraft1716000000077 } from '../../../../migrations/1716000000077-CreateAiOrderDraft';
import {
  AiOrderDraft,
  AiOrderDraftItem,
} from '../entities/ai-order-draft.entity';
import { AiUsageLog } from '../entities/ai-usage-log.entity';
import { AiDraftService, aiSourceHash } from './ai-draft.service';

/**
 * HAQIQIY POSTGRES — faqat `AI_PG_TEST_URI` berilganda:
 *
 *   AI_PG_TEST_URI=postgres://user@localhost:5432/db \
 *     npx jest apps/ai-service/src/draft/ai-draft.pg.spec.ts --runInBand
 *
 * vncdmXOy: TC3 (source_hash), TC9 (bitta draft — ko'p buyurtma), TC10
 * (ai_usage_log.draft_id JOIN xarajati), TC12 (retention: source_text NULL,
 * source_hash qoladi), migratsiya 1716000000077 up/down.
 * ⚠️ Faqat o'zi yaratgan tasodifiy draft_id'larga tegadi va o'chiradi.
 */
const PG_URI = process.env.AI_PG_TEST_URI;
const describePg = PG_URI ? describe : describe.skip;

describePg('ai_order_draft — real Postgres (vncdmXOy)', () => {
  let ds: DataSource;
  let service: AiDraftService;
  const draftA = randomUUID();
  const draftB = randomUUID();
  const market = '987654321';

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    ds = new DataSource({
      type: 'postgres',
      url: PG_URI,
      entities: [AiOrderDraft, AiOrderDraftItem, AiUsageLog],
      synchronize: false,
    });
    await ds.initialize();
    const qr = ds.createQueryRunner();
    try {
      const probe = await ds.query<Array<{ t: string | null }>>(
        `SELECT to_regclass('ai_schema.ai_usage_log') AS t`,
      );
      if (!probe[0]?.t) await new CreateAiSchema1716000000047().up(qr);
      // up() ikki marta — IF NOT EXISTS (idempotent).
      await new CreateAiOrderDraft1716000000077().up(qr);
      await new CreateAiOrderDraft1716000000077().up(qr);
    } finally {
      await qr.release();
    }
    service = new AiDraftService(
      ds.getRepository(AiOrderDraft),
      ds.getRepository(AiOrderDraftItem),
    );
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await ds.query(
      `DELETE FROM ai_schema.ai_order_draft WHERE id = ANY($1::uuid[])`,
      [[draftA, draftB]],
    );
    await ds.query(
      `DELETE FROM ai_schema.ai_usage_log WHERE draft_id = ANY($1::uuid[])`,
      [[draftA, draftB]],
    );
    await ds.destroy();
    jest.restoreAllMocks();
  });

  const record = (id: string, text: string): Promise<void> =>
    service.recordExtraction({
      draftId: id,
      marketId: market,
      userId: '7',
      traceId: 'pg',
      maskedText: text.replace(/\d{9}/, '[TEL_1]'),
      originalText: text,
      imagesBase64: [],
      model: 'claude-sonnet-5',
      promptVersion: 'v-test',
      outcome: 'ok',
      rawExtraction: { orders: [] },
    });

  it('TC3: yozuv — maskalangan matn, xesh asl matndan; qayta yetkazish ikkinchi qator yozmaydi', async () => {
    await record(draftA, 'Ali 901234567 Asaka atir');
    await record(draftA, 'BOSHQA MATN'); // ON CONFLICT DO NOTHING
    await record(draftB, 'Ali 901234568 Asaka atir');
    const rows = await ds.query<
      Array<{ id: string; source_text: string; source_hash: string }>
    >(
      `SELECT id::text, source_text, source_hash FROM ai_schema.ai_order_draft
       WHERE id = ANY($1::uuid[]) ORDER BY source_text`,
      [[draftA, draftB]],
    );
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.id === draftA)!;
    const b = rows.find((r) => r.id === draftB)!;
    expect(a.source_text).toBe('Ali [TEL_1] Asaka atir');
    expect(a.source_hash).toBe(aiSourceHash('Ali 901234567 Asaka atir', []));
    expect(b.source_hash).not.toBe(a.source_hash);
  });

  it('TC9/TC10: 10 ta buyurtma bitta draft’ga, xarajat ai_usage_log JOIN’idan', async () => {
    await ds.query(
      `INSERT INTO ai_schema.ai_usage_log
         (feature, model, input_tokens, cost_usd, cost_uzs, usd_uzs_rate, market_id, draft_id)
       VALUES ('order_extract_multi','claude-sonnet-5',100,0.01,128,12800,$1,$2),
              ('product_disambiguate','claude-haiku-4-5',50,0.002,25.6,12800,$1,$2)`,
      [market, draftA],
    );
    const items = Array.from({ length: 10 }, (_, i) => ({
      item_index: i,
      order_id: String(880000000 + i),
      edited_fields: i === 0 ? ['district_id'] : [],
    }));
    await expect(
      service.linkItems(draftA, market, items, '7'),
    ).resolves.toEqual({ linked: 10 });
    // Qayta yetkazish — dublikat yo'q.
    await expect(
      service.linkItems(draftA, market, items, '7'),
    ).resolves.toEqual({ linked: 0 });
    // Boshqa market draft'iga bog'lab bo'lmaydi.
    await expect(
      service.linkItems(draftB, '1', [{ item_index: 0, order_id: '1' }]),
    ).resolves.toEqual({ linked: 0 });

    const ctx = await service.confirmContext(market, [draftA]);
    expect(ctx.drafts[0].cost_uzs).toBeCloseTo(153.6, 2);
    const trace = await service.traceByOrder(String(880000000));
    expect(trace).toMatchObject({
      draft_id: draftA,
      item_index: 0,
      edited_fields: ['district_id'],
      cost: { linked_orders: 10, calls: 2 },
    });
    expect(trace!.cost.order_cost_uzs).toBeCloseTo(15.36, 2);
    await expect(service.confirmContext('1', [draftA])).resolves.toEqual({
      drafts: [],
    });
  });

  it('TC12: retention — source_text NULL, source_hash qoladi, bog‘lanish qoladi', async () => {
    await ds.query(
      `UPDATE ai_schema.ai_order_draft SET created_at = now() - interval '31 days'
       WHERE id = $1`,
      [draftA],
    );
    const before = await ds.query<Array<{ source_hash: string }>>(
      `SELECT source_hash FROM ai_schema.ai_order_draft WHERE id = $1`,
      [draftA],
    );
    await expect(service.purgeExpiredText()).resolves.toBeGreaterThanOrEqual(1);
    const after = await ds.query<
      Array<{
        source_text: string | null;
        raw_extraction: unknown;
        source_hash: string;
        text_purged_at: Date | null;
      }>
    >(
      `SELECT source_text, raw_extraction, source_hash, text_purged_at
       FROM ai_schema.ai_order_draft WHERE id = $1`,
      [draftA],
    );
    expect(after[0].source_text).toBeNull();
    expect(after[0].raw_extraction).toBeNull();
    expect(after[0].text_purged_at).not.toBeNull();
    expect(after[0].source_hash).toBe(before[0].source_hash);
    // Yangi draft (B) tegilmaydi.
    const b = await ds.query<Array<{ source_text: string | null }>>(
      `SELECT source_text FROM ai_schema.ai_order_draft WHERE id = $1`,
      [draftB],
    );
    expect(b[0].source_text).not.toBeNull();
    const trace = await service.traceByOrder(String(880000001));
    expect(trace).toMatchObject({ source_text: null, source_purged: true });
  });

  it('migratsiya down() → up() qayta ishlaydi', async () => {
    const qr = ds.createQueryRunner();
    try {
      await new CreateAiOrderDraft1716000000077().down(qr);
      const gone = await ds.query<Array<{ t: string | null }>>(
        `SELECT to_regclass('ai_schema.ai_order_draft') AS t`,
      );
      expect(gone[0].t).toBeNull();
      await new CreateAiOrderDraft1716000000077().up(qr);
    } finally {
      await qr.release();
    }
  });
});
