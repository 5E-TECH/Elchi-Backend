import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import type { ClaudeUsageRecord } from '@app/common';
import { AiUsageLog } from '../entities/ai-usage-log.entity';
import {
  AI_USAGE_LINK_ORDERS_SQL,
  AI_USAGE_SUMMARY_BY_DAY_SQL,
  AI_USAGE_SUMMARY_BY_FEATURE_SQL,
  AI_USAGE_SUMMARY_TOTALS_SQL,
  AiUsageService,
} from './ai-usage.service';
import { TASHKENT_DAY_SQL } from './tashkent-day';

const DRAFT = '5f2b8c1e-0000-4000-8000-000000000001';
const SHA = 'a'.repeat(64);

function makeRecord(over: Partial<ClaudeUsageRecord> = {}): ClaudeUsageRecord {
  return {
    feature: 'order_extract_multi',
    requestArea: 'order',
    marketId: '12',
    userId: '34',
    traceId: 'trace-1',
    draftId: DRAFT,
    model: 'claude-sonnet-5',
    inputTokens: 1234,
    outputTokens: 567,
    cacheCreationTokens: 4072,
    cacheReadTokens: 89,
    steps: 1,
    stopReason: 'end_turn',
    outcome: 'ok',
    inputChars: 42,
    inputSha256: SHA,
    imageCount: 0,
    ...over,
  };
}

function makeConfig(values: Record<string, unknown> = {}): ConfigService {
  return {
    get: (key: string): unknown => values[key],
  } as unknown as ConfigService;
}

function setup(config: Record<string, unknown> = {}) {
  const create = jest.fn((row: Partial<AiUsageLog>) => row);
  const save = jest
    .fn<Promise<unknown>, [Partial<AiUsageLog>]>()
    .mockResolvedValue({});
  const query = jest.fn<Promise<unknown>, [string, unknown[]?]>();
  const repo = { create, save, query } as unknown as Repository<AiUsageLog>;
  const service = new AiUsageService(
    repo,
    makeConfig({ AI_USD_UZS_RATE: 12800, AI_ORDER_PRICE_UZS: 300, ...config }),
  );
  const savedRow = (i = 0): Partial<AiUsageLog> => save.mock.calls[i][0];
  return { service, create, save, query, savedRow };
}

/** Fire-and-forget zanjiri (persist → catch) tugashini kutadi. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('AiUsageService (lYVuADRE)', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe('record()', () => {
    it('#3: bitta javob → bitta ai_usage_log qatori', async () => {
      const { service, save } = setup();
      service.record(makeRecord());
      await flush();
      expect(save).toHaveBeenCalledTimes(1);
    });

    it('#22: token yig`indisi 0 → qator YOZILMAYDI', async () => {
      const { service, save, create } = setup();
      service.record(
        makeRecord({
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        }),
      );
      await flush();
      expect(create).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    });

    it('#24: tokenlar Anthropic usage qiymatlariga AYNAN teng', async () => {
      const { service, savedRow } = setup();
      service.record(makeRecord());
      await flush();
      expect(savedRow()).toMatchObject({
        input_tokens: 1234,
        output_tokens: 567,
        cache_creation_tokens: 4072,
        cache_read_tokens: 89,
        steps: 1,
        stop_reason: 'end_turn',
        outcome: 'ok',
        model: 'claude-sonnet-5',
        feature: 'order_extract_multi',
        request_area: 'order',
      });
    });

    it('xarajat: cost_usd, cache_saved_usd, cost_uzs (kurs qatorda), applied_price_uzs', async () => {
      const { service, savedRow } = setup();
      service.record(makeRecord());
      await flush();
      const row = savedRow();
      const usd = (1234 * 3 + 567 * 15 + 4072 * 3 * 1.25 + 89 * 3 * 0.1) / 1e6;
      expect(row.cost_usd).toBeCloseTo(usd, 6);
      expect(typeof row.cost_usd).toBe('number');
      expect(row.cache_saved_usd).toBeCloseTo((89 * 3 * 0.9) / 1e6, 6);
      expect(row.usd_uzs_rate).toBe(12800);
      expect(row.cost_uzs).toBeCloseTo((row.cost_usd ?? 0) * 12800, 2);
      expect(row.applied_price_uzs).toBe(300);
    });

    it('applied_price_uzs faqat order_extract_* uchun (order_item_match → null)', async () => {
      const { service, savedRow } = setup();
      service.record(makeRecord({ feature: 'order_item_match' }));
      service.record(makeRecord({ feature: 'order_extract_image' }));
      await flush();
      expect(savedRow(0).applied_price_uzs).toBeNull();
      expect(savedRow(1).applied_price_uzs).toBe(300);
    });

    it('#7/#19: cache_read to`ldirilgan qator keshsiz variantdan sezilarli arzon', async () => {
      const { service, savedRow } = setup();
      const base = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      };
      service.record(makeRecord({ ...base, inputTokens: 100_000 }));
      service.record(makeRecord({ ...base, cacheReadTokens: 100_000 }));
      await flush();
      const uncached = savedRow(0).cost_usd ?? 0;
      const cached = savedRow(1).cost_usd ?? 0;
      expect(cached).toBeCloseTo(uncached * 0.1, 6);
    });

    it('meta to`liq → meta_incomplete=false, market/user/trace/draft yoziladi', async () => {
      const { service, savedRow } = setup();
      service.record(makeRecord());
      await flush();
      expect(savedRow()).toMatchObject({
        market_id: '12',
        user_id: '34',
        trace_id: 'trace-1',
        draft_id: DRAFT,
        meta_incomplete: false,
      });
    });

    it.each([
      ['marketId', { marketId: null }],
      ['userId', { userId: null }],
      ['traceId', { traceId: '  ' }],
      ['draftId', { draftId: null }],
      ['yaroqsiz marketId (bigint emas)', { marketId: 'abc' }],
      ['yaroqsiz draftId (uuid emas)', { draftId: 'draft-1' }],
    ])(
      'meta to`liq emas (%s) → qator baribir yoziladi, meta_incomplete=true',
      async (_label, over) => {
        const { service, save, savedRow } = setup();
        service.record(makeRecord(over as Partial<ClaudeUsageRecord>));
        await flush();
        expect(save).toHaveBeenCalledTimes(1);
        expect(savedRow().meta_incomplete).toBe(true);
      },
    );

    it('HD5zOyBp #17: xom matn YO`Q — faqat input_chars, input_sha256, image_count', async () => {
      const { service, savedRow } = setup();
      const withText = {
        ...makeRecord({ imageCount: 2 }),
        userText: 'Ali +998901234567 Chilonzor',
      };
      service.record(withText as ClaudeUsageRecord);
      await flush();
      const row = savedRow();
      expect(row).toMatchObject({
        input_chars: 42,
        input_sha256: SHA,
        image_count: 2,
      });
      expect(JSON.stringify(row)).not.toContain('998901234567');
      expect(JSON.stringify(row)).not.toContain('Chilonzor');
    });

    it('#8/#21: repo.save reject → record() qaytadi (throw yo`q), faqat WARN', async () => {
      const { service, save } = setup();
      save.mockRejectedValue(new Error('connection terminated'));
      expect(() => service.record(makeRecord())).not.toThrow();
      await flush();
      expect(service.persistFailures()).toBe(1);
      const messages = (warn.mock.calls as unknown[][]).map((c) =>
        String(c[0]),
      );
      expect(
        messages.some((m) => m.startsWith('ai_usage_persist_failed')),
      ).toBe(true);
    });

    it('#8: repo.create sinxron throw qilsa ham record() throw qilmaydi', async () => {
      const { service, create } = setup();
      create.mockImplementation(() => {
        throw new Error('metadata broken');
      });
      expect(() => service.record(makeRecord())).not.toThrow();
      await flush();
      expect(service.persistFailures()).toBe(1);
    });

    it('record() sinxron void qaytaradi (ClaudeService kutmaydi)', () => {
      const { service } = setup();
      expect(service.record(makeRecord())).toBeUndefined();
    });
  });

  describe('linkOrders()', () => {
    it('#18: draft_id + market_id bo`yicha order_ids bog`lanadi, {updated}', async () => {
      const { service, query } = setup();
      query.mockResolvedValue([[], 2]);
      const res = await service.linkOrders(DRAFT, ['101', '102', '101'], '12');
      expect(res).toEqual({ updated: 2 });
      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toBe(AI_USAGE_LINK_ORDERS_SQL);
      expect(sql).toContain('UPDATE ai_schema.ai_usage_log');
      expect(sql).toContain('$2::bigint[]');
      expect(sql).toContain('WHERE draft_id = $1 AND market_id = $3');
      expect(params).toEqual([DRAFT, ['101', '102'], '12']);
    });

    it.each([
      ['yaroqsiz draft', 'not-a-uuid', ['1'], '12'],
      ['bo`sh order_ids', DRAFT, [], '12'],
      ['yaroqsiz market', DRAFT, ['1'], 'x'],
    ])('%s → {updated:0}, SQL ketmaydi', async (_l, draft, ids, market) => {
      const { service, query } = setup();
      await expect(service.linkOrders(draft, ids, market)).resolves.toEqual({
        updated: 0,
      });
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('summary()', () => {
    function mockSummary(
      query: jest.Mock<Promise<unknown>, [string, unknown[]?]>,
    ) {
      query.mockImplementation((sql: string) => {
        if (sql === AI_USAGE_SUMMARY_TOTALS_SQL) {
          // pg numeric/bigint SATR bo'lib kelishi mumkin — Number() ga keltiriladi.
          return Promise.resolve([
            {
              calls: '2',
              total_usd: '0.3',
              total_uzs: '3840.00',
              cache_saved_usd: '0.0027',
              cache_saved_uzs: '34.56',
              meta_incomplete_calls: '0',
              linked_calls: '1',
            },
          ]);
        }
        if (sql === AI_USAGE_SUMMARY_BY_FEATURE_SQL) {
          return Promise.resolve([
            {
              feature: 'order_extract_multi',
              calls: 2,
              usd: '0.3',
              input_tokens: '2468',
              output_tokens: '1134',
              cache_creation_tokens: '4072',
              cache_read_tokens: '4072',
            },
          ]);
        }
        if (sql === AI_USAGE_SUMMARY_BY_DAY_SQL) {
          return Promise.resolve([
            { day: '2026-09-26', calls: 1, usd: '0.1', uzs: '1280.00' },
            { day: '2026-09-27', calls: 1, usd: '0.2', uzs: '2560.00' },
          ]);
        }
        return Promise.reject(new Error('kutilmagan SQL'));
      });
    }

    it('#15: SUM qiymatlari son (satr emas); 0.1 + 0.2 kunlar = 0.3 jami', async () => {
      const { service, query } = setup();
      mockSummary(query);
      const res = await service.summary('2026-09-26', '2026-09-27');

      expect(res.total_usd).toBe(0.3);
      expect(typeof res.total_usd).toBe('number');
      expect(res.calls).toBe(2);
      expect(res.linked_calls).toBe(1);
      expect(res.meta_incomplete_calls).toBe(0);
      expect(res.cache_saved_usd).toBe(0.0027);
      expect(res.cache_saved_uzs).toBe(34.56);
      const daySum = res.by_day.reduce((acc, d) => acc + d.usd, 0);
      expect(daySum).toBeCloseTo(0.3, 10);
      expect(res.by_day.every((d) => typeof d.usd === 'number')).toBe(true);
      expect(res.by_feature[0]).toEqual({
        feature: 'order_extract_multi',
        calls: 2,
        usd: 0.3,
        input_tokens: 2468,
        output_tokens: 1134,
        cache_creation_tokens: 4072,
        cache_read_tokens: 4072,
      });
    });

    it('#23: kun agregati Asia/Tashkent bo`yicha guruhlanadi; SUM ::float8', () => {
      expect(AI_USAGE_SUMMARY_BY_DAY_SQL).toContain(TASHKENT_DAY_SQL);
      expect(AI_USAGE_SUMMARY_BY_DAY_SQL).toContain(
        `GROUP BY ${TASHKENT_DAY_SQL}`,
      );
      for (const sql of [
        AI_USAGE_SUMMARY_TOTALS_SQL,
        AI_USAGE_SUMMARY_BY_FEATURE_SQL,
        AI_USAGE_SUMMARY_BY_DAY_SQL,
      ]) {
        expect(sql).toContain('::float8');
        expect(sql).toContain('ai_schema.ai_usage_log');
        expect(sql).toContain('is_deleted = false');
      }
      expect(AI_USAGE_SUMMARY_TOTALS_SQL).toContain(
        'cardinality(order_ids) > 0',
      );
      expect(AI_USAGE_SUMMARY_TOTALS_SQL).toContain(
        'FILTER (WHERE meta_incomplete)',
      );
      expect(AI_USAGE_SUMMARY_BY_FEATURE_SQL).toContain('cache_read_tokens');
    });

    it('davr chegaralari Toshkent yarim tunlari (to — shu kun OXIRIGACHA)', async () => {
      const { service, query } = setup();
      mockSummary(query);
      await service.summary('2026-09-01', '2026-09-27');
      expect(query).toHaveBeenCalledTimes(3);
      for (const call of query.mock.calls) {
        expect(call[1]).toEqual([
          '2026-09-01T00:00:00+05:00',
          '2026-09-28T00:00:00+05:00',
        ]);
      }
    });

    it('sana berilmasa (yoki yaroqsiz) — oxirgi 30 kun', async () => {
      jest.useFakeTimers({
        now: new Date('2026-09-27T06:00:00Z'),
        doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
      });
      try {
        const { service, query } = setup();
        mockSummary(query);
        await service.summary(undefined, '2026-02-31');
        const params = query.mock.calls[0][1];
        expect(params).toEqual([
          '2026-08-29T00:00:00+05:00',
          '2026-09-28T00:00:00+05:00',
        ]);
      } finally {
        jest.useRealTimers();
      }
    });

    it('bo`sh jadval → nollar va bo`sh ro`yxatlar', async () => {
      const { service, query } = setup();
      query.mockImplementation((sql: string) =>
        Promise.resolve(
          sql === AI_USAGE_SUMMARY_TOTALS_SQL
            ? [
                {
                  calls: 0,
                  total_usd: 0,
                  total_uzs: 0,
                  cache_saved_usd: 0,
                  cache_saved_uzs: 0,
                  meta_incomplete_calls: 0,
                  linked_calls: 0,
                },
              ]
            : [],
        ),
      );
      await expect(service.summary()).resolves.toEqual({
        total_usd: 0,
        total_uzs: 0,
        calls: 0,
        cache_saved_usd: 0,
        cache_saved_uzs: 0,
        meta_incomplete_calls: 0,
        linked_calls: 0,
        by_feature: [],
        by_day: [],
      });
    });
  });
});
