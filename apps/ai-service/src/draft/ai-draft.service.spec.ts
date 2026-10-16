import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Repository } from 'typeorm';
import type {
  AiOrderDraft,
  AiOrderDraftItem,
} from '../entities/ai-order-draft.entity';
import {
  AI_DRAFT_COST_SQL,
  AI_DRAFT_LINK_ITEM_SQL,
  AI_DRAFT_PURGE_SQL,
  AI_DRAFT_TEXT_RETENTION_DAYS,
  AiDraftService,
  aiSourceHash,
  sanitizeSnapshot,
} from './ai-draft.service';

/** vncdmXOy — AI buyurtma audit izi (unit; real PG — ai-draft.pg.spec.ts). */
const DRAFT = '0b9f7c3e-1d2a-4b5c-8d6e-7f8091a2b3c4';
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

function snapshot(over: Record<string, unknown> = {}) {
  return {
    index: 0,
    customer_name: 'Dilnoza',
    phone_masked: '+99890*****67',
    phone_sha256: sha('+998901234567'),
    extra_masked: null,
    extra_sha256: null,
    region_id: '2',
    district_id: '15',
    address: 'temiryol 12',
    total_price: 750000,
    where_deliver: 'address',
    comment: null,
    operator: null,
    is_replacement: false,
    items: [{ name: 'atir', product_id: '9', quantity: 3 }],
    ...over,
  };
}

describe('AiDraftService (vncdmXOy)', () => {
  let execute: jest.Mock;
  let values: jest.Mock;
  let draftsRepo: {
    createQueryBuilder: jest.Mock;
    update: jest.Mock;
    query: jest.Mock;
    findOne: jest.Mock;
  };
  let itemsRepo: { query: jest.Mock; findOne: jest.Mock; count: jest.Mock };
  let service: AiDraftService;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    execute = jest.fn().mockResolvedValue({});
    values = jest.fn();
    const qb = {
      insert: () => qb,
      into: () => qb,
      values: (v: unknown) => {
        values(v);
        return qb;
      },
      orIgnore: () => qb,
      execute,
    };
    draftsRepo = {
      createQueryBuilder: jest.fn(() => qb),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      query: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
    };
    itemsRepo = {
      query: jest.fn().mockResolvedValue([{ id: '1' }]),
      findOne: jest.fn(),
      count: jest.fn().mockResolvedValue(1),
    };
    service = new AiDraftService(
      draftsRepo as unknown as Repository<AiOrderDraft>,
      itemsRepo as unknown as Repository<AiOrderDraftItem>,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  describe('TC3: source_hash', () => {
    it('bir xil matn → bir xil xesh; bitta belgi o‘zgarsa boshqa', () => {
      const a = aiSourceHash('Ali 901234567 Asaka atir', []);
      expect(aiSourceHash('Ali 901234567 Asaka atir', [])).toBe(a);
      expect(aiSourceHash('Ali 901234568 Asaka atir', [])).not.toBe(a);
      expect(aiSourceHash('Ali 901234567 Asaka atir ', [])).not.toBe(a);
      // Rasmsiz — aynan sha256(matn).
      expect(a).toBe(sha('Ali 901234567 Asaka atir'));
    });

    it('rasm qo‘shilsa xesh o‘zgaradi (rasmning o‘zi saqlanmaydi)', () => {
      expect(aiSourceHash('x', ['QUJD'])).not.toBe(aiSourceHash('x', []));
      expect(aiSourceHash('x', ['QUJD'])).not.toBe(aiSourceHash('x', ['REVG']));
    });
  });

  describe('recordExtraction', () => {
    const input = {
      draftId: DRAFT,
      marketId: '121',
      userId: '7',
      traceId: 't-1',
      maskedText: 'Ali [TEL_1] Asaka atir',
      originalText: 'Ali 901234567 Asaka atir',
      imagesBase64: ['QUJDREVG'],
      model: 'claude-sonnet-5',
      promptVersion: '2026-09-27.1',
      outcome: 'ok',
      rawExtraction: { orders: [{ phone_number: '[TEL_1]' }] },
    };

    it('maskalangan matn saqlanadi, asl telefon va rasm base64 YO‘Q', async () => {
      await service.recordExtraction(input);
      expect(values).toHaveBeenCalledTimes(1);
      const row = values.mock.calls[0][0] as Record<string, unknown>;
      expect(row).toMatchObject({
        id: DRAFT,
        market_id: '121',
        user_id: '7',
        source_kind: 'image',
        source_text: 'Ali [TEL_1] Asaka atir',
        source_hash: aiSourceHash(input.originalText, input.imagesBase64),
        image_count: 1,
        model: 'claude-sonnet-5',
        prompt_version: '2026-09-27.1',
        outcome: 'ok',
      });
      const json = JSON.stringify(row);
      expect(json).not.toContain('901234567');
      expect(json).not.toContain('QUJDREVG');
    });

    it('DB xatosi throw/reject bo‘lmaydi — faqat WARN', async () => {
      execute.mockRejectedValue(new Error('db down'));
      await expect(service.recordExtraction(input)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('ai_draft_persist_failed'),
      );
    });

    it('yaroqsiz draft_id / market_id → yozilmaydi', () => {
      void service.recordExtraction({ ...input, draftId: 'x' });
      void service.recordExtraction({ ...input, marketId: 'abc' });
      expect(values).not.toHaveBeenCalled();
    });
  });

  it('sanitizeSnapshot: oq ro‘yxat — begona kalit (to‘liq telefon) tushmaydi', () => {
    const s = sanitizeSnapshot({
      ...snapshot(),
      phone_number: '+998901234567',
      operator_id: '99',
    });
    expect(s).not.toHaveProperty('phone_number');
    expect(s).not.toHaveProperty('operator_id');
    expect(s?.phone_masked).toBe('+99890*****67');
    expect(sanitizeSnapshot({ index: 99 })).toBeNull();
  });

  it('attachPreview faqat o‘z marketining draft’ini yangilaydi', async () => {
    await service.attachPreview(DRAFT, '121', [snapshot(), { bad: true }]);
    expect(draftsRepo.update).toHaveBeenCalledWith(
      { id: DRAFT, market_id: '121' },
      expect.objectContaining({ preview_count: 1 }),
    );
  });

  it('confirmContext: market sharti SQL’da, xarajat ai_usage_log JOIN’idan (TC10)', async () => {
    draftsRepo.query
      .mockResolvedValueOnce([
        {
          id: DRAFT,
          model: 'claude-sonnet-5',
          prompt_version: 'v1',
          preview_count: 2,
          resolved_preview: [snapshot()],
        },
      ])
      .mockResolvedValueOnce([
        { draft_id: DRAFT, calls: 2, cost_usd: 0.0123, cost_uzs: 157.44 },
      ]);
    const res = await service.confirmContext('121', [DRAFT, 'bad', DRAFT]);
    expect(draftsRepo.query.mock.calls[0][1]).toEqual([[DRAFT], '121']);
    expect(draftsRepo.query.mock.calls[1][0]).toBe(AI_DRAFT_COST_SQL);
    expect(res.drafts[0]).toMatchObject({
      draft_id: DRAFT,
      model: 'claude-sonnet-5',
      preview_count: 2,
      cost_uzs: 157.44,
    });
    expect(res.drafts[0].previews).toHaveLength(1);
  });

  it('linkItems: har buyurtma alohida, edited_fields oq ro‘yxat bo‘yicha', async () => {
    const res = await service.linkItems(
      DRAFT,
      '121',
      [
        {
          item_index: 0,
          order_id: '10',
          edited_fields: ['total_price', 'hacker', 'district_id'],
        },
        { item_index: 1, order_id: 'x' },
      ],
      '7',
      450,
    );
    // NFiXfmq6: amal qilgan narx YANGI qatorga muzlatiladi.
    expect(res).toEqual({ linked: 1, charged_uzs: 450 });
    expect(itemsRepo.query).toHaveBeenCalledTimes(1);
    const [sql, params] = itemsRepo.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toBe(AI_DRAFT_LINK_ITEM_SQL);
    // Market sharti va dublikatsiz yozish SQL'da.
    expect(sql).toContain('d.market_id = $4::bigint');
    expect(sql).toContain('ON CONFLICT (order_id) DO NOTHING');
    expect(sql).toContain('applied_price_uzs');
    expect(params).toEqual([
      DRAFT,
      0,
      '10',
      '121',
      '7',
      JSON.stringify(['district_id', 'total_price']),
      450,
    ]);
  });

  it('NFiXfmq6: narx berilmasa (eski chaqiruvchi) applied_price_uzs NULL, charged 0; takroriy (ON CONFLICT) — 0', async () => {
    itemsRepo.query.mockResolvedValueOnce([{ id: '1' }]);
    await expect(
      service.linkItems(DRAFT, '121', [{ item_index: 0, order_id: '10' }]),
    ).resolves.toEqual({ linked: 1, charged_uzs: 0 });
    expect((itemsRepo.query.mock.calls[0] as [string, unknown[]])[1][6]).toBe(
      null,
    );
    // ON CONFLICT DO NOTHING → RETURNING bo'sh: pul qayta qayd qilinmaydi.
    itemsRepo.query.mockResolvedValueOnce([]);
    await expect(
      service.linkItems(
        DRAFT,
        '121',
        [{ item_index: 0, order_id: '10' }],
        '7',
        300,
      ),
    ).resolves.toEqual({ linked: 0, charged_uzs: 0 });
  });

  describe('traceByOrder (TC8, TC10)', () => {
    it('AI’dan yaratilmagan buyurtma → null', async () => {
      itemsRepo.findOne.mockResolvedValue(null);
      await expect(service.traceByOrder('5')).resolves.toBeNull();
    });

    it('maskalangan matn va telefon, edited_fields, buyurtma ulushi', async () => {
      itemsRepo.findOne.mockResolvedValue({
        draft_id: DRAFT,
        item_index: 0,
        order_id: '10',
        confirmed_by: '7',
        edited_fields: ['district_id'],
        created_at: new Date('2026-10-14T10:00:00Z'),
      });
      draftsRepo.findOne.mockResolvedValue({
        id: DRAFT,
        market_id: '121',
        user_id: '7',
        source_kind: 'text',
        source_text: 'Dilnoza [TEL_1] Asaka',
        source_hash: 'a'.repeat(64),
        image_count: 0,
        model: 'claude-sonnet-5',
        prompt_version: 'v1',
        outcome: 'ok',
        resolved_preview: [snapshot()],
        text_purged_at: null,
        created_at: new Date('2026-10-14T09:59:00Z'),
      });
      itemsRepo.count.mockResolvedValue(2);
      draftsRepo.query.mockResolvedValue([
        { draft_id: DRAFT, calls: 1, cost_usd: 0.02, cost_uzs: 256 },
      ]);
      const t = await service.traceByOrder('10');
      expect(t).toMatchObject({
        order_id: '10',
        draft_id: DRAFT,
        source_text: 'Dilnoza [TEL_1] Asaka',
        edited_fields: ['district_id'],
        cost: {
          draft_cost_uzs: 256,
          linked_orders: 2,
          order_cost_uzs: 128,
        },
      });
      expect(t?.ai_suggestion?.phone_masked).toBe('+99890*****67');
      expect(JSON.stringify(t)).not.toMatch(/998901234567/);
    });
  });

  it('TC12: retention SQL source_text/raw/preview ni NULL qiladi, source_hash’ga TEGMAYDI', async () => {
    draftsRepo.query.mockResolvedValue([[], 3]);
    await expect(service.purgeExpiredText()).resolves.toBe(3);
    expect(draftsRepo.query).toHaveBeenCalledWith(AI_DRAFT_PURGE_SQL, [
      AI_DRAFT_TEXT_RETENTION_DAYS,
    ]);
    expect(AI_DRAFT_PURGE_SQL).toContain('source_text = NULL');
    expect(AI_DRAFT_PURGE_SQL).not.toContain('source_hash');
  });

  it('retention xatosi throw bo‘lmaydi', async () => {
    draftsRepo.query.mockRejectedValue(new Error('db'));
    await expect(service.purgeExpiredText()).resolves.toBe(0);
  });
});
