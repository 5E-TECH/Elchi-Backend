import { BadRequestException, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import type { AiBudgetService } from '../budget/ai-budget.service';
import type { AiUsageLog } from '../entities/ai-usage-log.entity';
import {
  AI_MARGIN_CHARGED_BY_MARKET_SQL,
  AI_MARGIN_COST_BY_MARKET_SQL,
  AI_MARGIN_DEFAULT_THRESHOLDS,
  AiMarginService,
  buildAiMarginReport,
  readAiMarginThresholds,
  type AiMarginRawInput,
} from './ai-margin.service';

/**
 * NFiXfmq6 — "AI xarajat va marja" hisoboti: sof yig'uvchi
 * (`buildAiMarginReport`), alert chegaralari (config) va servis o'rami.
 * SQL'ning o'zi — `ai-margin.pg.spec.ts` (haqiqiy Postgres).
 */
const cfg = (values: Record<string, unknown>) =>
  ({ get: (key: string): unknown => values[key] }) as unknown as ConfigService;

function input(over: Partial<AiMarginRawInput> = {}): AiMarginRawInput {
  return {
    fromDay: '2026-10-01',
    toDay: '2026-10-03',
    marketId: null,
    defaultPricePerOrderUzs: 300,
    thresholds: { ...AI_MARGIN_DEFAULT_THRESHOLDS },
    capStatus: null,
    costByMarket: [],
    chargedByMarket: [],
    internal: [],
    byFeature: [],
    cacheByModel: [],
    costByDay: [],
    chargedByDay: [],
    marketDayCost: [],
    ...over,
  };
}

/** Kesh ishlayotgan holat (alert yo'q bo'lishi uchun). */
const HEALTHY_CACHE = [
  {
    model: 'claude-sonnet-5',
    calls: 10,
    cache_read_tokens: '40720',
    cache_creation_tokens: '4072',
    saved_usd: '0.109944',
    saved_uzs: '1407.28',
    creation_rate_tokens: '52121600',
  },
];

describe('NFiXfmq6 — AI marja hisoboti (buildAiMarginReport)', () => {
  it('TC1/TC3: market kesimida charged, cost (ai_usage_log), margin = charged − cost; manfiy → marginNegative', () => {
    const r = buildAiMarginReport(
      input({
        costByMarket: [
          { market_id: '12', calls: 4, usd: '0.2', uzs: '2560' },
          { market_id: '34', calls: 1, usd: '0.01', uzs: '128' },
          { market_id: null, calls: 2, usd: '0.02', uzs: '256' },
        ],
        chargedByMarket: [
          {
            market_id: '12',
            ai_orders: 5,
            unpriced_orders: 0,
            free_orders: 0,
            charged_uzs: '1500',
          },
          {
            market_id: '34',
            ai_orders: 2,
            unpriced_orders: 0,
            free_orders: 0,
            charged_uzs: '900',
          },
        ],
        cacheByModel: HEALTHY_CACHE,
      }),
    );
    const m12 = r.byMarket.find((m) => m.marketId === '12')!;
    expect(m12).toMatchObject({
      chargedUzs: 1500,
      costUzs: 2560,
      marginUzs: -1060,
      marginNegative: true,
      calls: 4,
      aiOrders: 5,
      avgCostPerAiOrderUzs: 512,
      avgChargedPerAiOrderUzs: 300,
    });
    expect(r.byMarket.find((m) => m.marketId === '34')).toMatchObject({
      chargedUzs: 900,
      costUzs: 128,
      marginUzs: 772,
      marginNegative: false,
    });
    // Bog'lanmagan xarajat (market_id NULL) alohida qator.
    expect(r.byMarket.find((m) => m.marketId === null)).toMatchObject({
      costUzs: 256,
      chargedUzs: 0,
    });
    expect(r.totals).toMatchObject({
      chargedUzs: 2400,
      costUzs: 2944,
      chargeableCostUzs: 2944,
      marginUzs: -544,
      marginNegative: true,
      aiOrders: 7,
      calls: 7,
    });
    expect(r.alerts.filter((a) => a.type === 'negative_margin')).toEqual([
      expect.objectContaining({ marketId: '12', value: -1060, threshold: 0 }),
    ]);
  });

  it('TC8: numeric satrlar Number() ga o‘giriladi — jami konkatenatsiya emas', () => {
    const r = buildAiMarginReport(
      input({
        costByMarket: [
          { market_id: '12', calls: '2', usd: '0.1', uzs: '1280.50' },
          { market_id: '13', calls: '1', usd: '0.02', uzs: '256.25' },
        ],
        cacheByModel: HEALTHY_CACHE,
      }),
    );
    expect(r.totals.costUzs).toBe(1536.75);
    expect(typeof r.totals.costUzs).toBe('number');
    expect(r.totals.calls).toBe(3);
    expect(typeof r.byMarket[0].calls).toBe('number');
  });

  it('TC10: bo‘sh davr — xatosiz 0, kunlik seriya 0 bilan to‘ldirilgan', () => {
    const r = buildAiMarginReport(input());
    expect(r.totals).toMatchObject({
      chargedUzs: 0,
      costUzs: 0,
      marginUzs: 0,
      calls: 0,
      aiOrders: 0,
      avgCostPerAiOrderUzs: 0,
    });
    expect(r.byMarket).toEqual([]);
    expect(r.cache).toMatchObject({ cacheSavedUzs: 0, hitRate: null });
    expect(r.dailySeries.map((d) => d.day)).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
    ]);
    expect(
      r.dailySeries.every((d) => d.costUzs === 0 && d.chargedUzs === 0),
    ).toBe(true);
    // Chaqiruv yo'q — kesh alerti ham yo'q.
    expect(r.alerts).toEqual([]);
  });

  it('TC4: kesh tejagan summa cache_read_tokens ga proporsional; yozish qo‘shimchasi alohida (sof tejov)', () => {
    const at = (read: number) =>
      buildAiMarginReport(
        input({
          costByMarket: [{ market_id: '12', calls: 1, usd: '0', uzs: '0' }],
          cacheByModel: [
            {
              model: 'claude-sonnet-5',
              calls: 1,
              cache_read_tokens: String(read),
              cache_creation_tokens: '1000',
              // cache_saved_usd = read × 3 × 0.9 / 1M (yozuvda muzlatilgan).
              saved_usd: String((read * 3 * 0.9) / 1e6),
              saved_uzs: String(((read * 3 * 0.9) / 1e6) * 12800),
              creation_rate_tokens: String(1000 * 12800),
            },
          ],
        }),
      ).cache;
    const one = at(10_000);
    const two = at(20_000);
    expect(two.cacheSavedUzs).toBeCloseTo(one.cacheSavedUzs * 2, 2);
    expect(one.cacheSavedUzs).toBeCloseTo(345.6, 2);
    // Yozish qo'shimchasi: 1000 × 3 × 0.25 / 1M × 12800 = 9.6 so'm.
    expect(one.cacheWriteCostUzs).toBeCloseTo(9.6, 2);
    expect(one.cacheNetSavedUzs).toBeCloseTo(345.6 - 9.6, 2);
    expect(one.hitRate).toBeCloseTo(10_000 / 11_000, 4);
  });

  it('TC5: kesh butunlay buzilganda (cache_read = 0) — tejov 0 va critical alert', () => {
    const r = buildAiMarginReport(
      input({
        costByMarket: [{ market_id: '12', calls: 3, usd: '0.05', uzs: '640' }],
        cacheByModel: [
          {
            model: 'claude-sonnet-5',
            calls: 3,
            cache_read_tokens: '0',
            cache_creation_tokens: '12216',
            saved_usd: '0',
            saved_uzs: '0',
            creation_rate_tokens: String(12216 * 12800),
          },
        ],
      }),
    );
    expect(r.cache.cacheSavedUzs).toBe(0);
    expect(r.cache.hitRate).toBe(0);
    expect(r.alerts).toContainEqual(
      expect.objectContaining({ type: 'cache_broken', severity: 'critical' }),
    );
    // Buzilgan kesh ikkinchi marta "hit-rate past" deb takrorlanmaydi.
    expect(r.alerts.some((a) => a.type === 'cache_hit_low')).toBe(false);
  });

  it('TC6: order_extract_image alohida qator, 1 chaqiruvga o‘rtacha xarajati matnlidan yuqori', () => {
    const r = buildAiMarginReport(
      input({
        byFeature: [
          {
            feature: 'order_extract_image',
            area: 'order',
            calls: 2,
            images: 3,
            usd: '0.4',
            uzs: '5120',
          },
          {
            feature: 'order_extract_multi',
            area: 'order',
            calls: 10,
            images: 0,
            usd: '0.2',
            uzs: '2560',
          },
        ],
      }),
    );
    const image = r.byFeature.find((f) => f.feature === 'order_extract_image')!;
    const text = r.byFeature.find((f) => f.feature === 'order_extract_multi')!;
    expect(image).toMatchObject({
      calls: 2,
      images: 3,
      avgCostPerCallUzs: 2560,
    });
    expect(text.avgCostPerCallUzs).toBe(256);
    expect(image.avgCostPerCallUzs).toBeGreaterThan(text.avgCostPerCallUzs);
  });

  it('TC7: request_area=internal — charj qilinmagan xarajat markazi: byMarket ga kirmaydi, jami xarajatda bor', () => {
    const r = buildAiMarginReport(
      input({
        costByMarket: [{ market_id: '12', calls: 1, usd: '0.01', uzs: '128' }],
        chargedByMarket: [
          {
            market_id: '12',
            ai_orders: 1,
            unpriced_orders: 0,
            free_orders: 0,
            charged_uzs: '300',
          },
        ],
        internal: [{ calls: 4, usd: '0.3', uzs: '3840' }],
        byFeature: [
          {
            feature: 'finance_report',
            area: 'internal',
            calls: 4,
            images: 0,
            usd: '0.3',
            uzs: '3840',
          },
        ],
        cacheByModel: HEALTHY_CACHE,
      }),
    );
    expect(r.internal).toEqual({
      calls: 4,
      costUsd: 0.3,
      costUzs: 3840,
      charged: false,
    });
    expect(r.byMarket.map((m) => m.marketId)).toEqual(['12']);
    expect(r.byFeature[0]).toMatchObject({ area: 'internal', charged: false });
    expect(r.totals).toMatchObject({
      chargedUzs: 300,
      chargeableCostUzs: 128,
      orderMarginUzs: 172,
      costUzs: 3968,
      marginUzs: -3668,
      calls: 5,
    });
  });

  it('TC9: kunlik seriya (Toshkent kunlari SQL dan) — charged va cost bir kunda, marja kunlik', () => {
    const r = buildAiMarginReport(
      input({
        costByDay: [{ day: '2026-10-02', calls: 3, uzs: '400' }],
        chargedByDay: [{ day: '2026-10-02', orders: 2, charged_uzs: '600' }],
      }),
    );
    expect(r.dailySeries).toEqual([
      expect.objectContaining({ day: '2026-10-01', costUzs: 0 }),
      {
        day: '2026-10-02',
        chargedUzs: 600,
        costUzs: 400,
        marginUzs: 200,
        calls: 3,
        aiOrders: 2,
      },
      expect.objectContaining({ day: '2026-10-03', chargedUzs: 0 }),
    ]);
  });

  it('bepul market (hamma buyurtma 0 so‘m) — marja manfiy, lekin negative_margin alerti yo‘q', () => {
    const r = buildAiMarginReport(
      input({
        costByMarket: [{ market_id: '55', calls: 2, usd: '0.02', uzs: '256' }],
        chargedByMarket: [
          {
            market_id: '55',
            ai_orders: 2,
            unpriced_orders: 0,
            free_orders: 2,
            charged_uzs: '0',
          },
        ],
        cacheByModel: HEALTHY_CACHE,
      }),
    );
    expect(r.byMarket[0]).toMatchObject({
      marginNegative: true,
      freeAiOrders: 2,
    });
    expect(r.alerts.some((a) => a.type === 'negative_margin')).toBe(false);
  });

  it('kunlik shift 80% (AI_CAP_WARN_RATIO) — warning, oshgan — critical', () => {
    const warn = buildAiMarginReport(
      input({
        capStatus: { state: 'warn', ratio: 0.85, period_key: '2026-10-03' },
      }),
    );
    expect(warn.alerts).toContainEqual(
      expect.objectContaining({
        type: 'daily_cap_warn',
        severity: 'warning',
        value: 0.85,
        threshold: 0.8,
      }),
    );
    const exceeded = buildAiMarginReport(
      input({
        capStatus: { state: 'exceeded', ratio: 1.02, period_key: '2026-10-03' },
      }),
    );
    expect(exceeded.alerts[0]).toMatchObject({
      type: 'daily_cap_warn',
      severity: 'critical',
    });
    const ok = buildAiMarginReport(
      input({ capStatus: { state: 'ok', ratio: 0.1, period_key: 'x' } }),
    );
    expect(ok.alerts).toEqual([]);
  });

  it('bitta market kunlik xarajati o‘zining o‘rtachasidan 5x oshsa — market_spike', () => {
    const days = [
      { market_id: '12', day: '2026-10-01', uzs: '100' },
      { market_id: '12', day: '2026-10-02', uzs: '120' },
      { market_id: '12', day: '2026-10-03', uzs: '700' },
      // Boshqa market barqaror.
      { market_id: '13', day: '2026-10-01', uzs: '100' },
      { market_id: '13', day: '2026-10-03', uzs: '110' },
      // Yangi market (bitta kun) — solishtirish yo'q, alert yo'q.
      { market_id: '14', day: '2026-10-03', uzs: '5000' },
    ];
    const r = buildAiMarginReport(input({ marketDayCost: days }));
    const spikes = r.alerts.filter((a) => a.type === 'market_spike');
    expect(spikes).toEqual([
      expect.objectContaining({
        marketId: '12',
        day: '2026-10-03',
        value: 700,
        threshold: 550, // 5 × (100 + 120) / 2
      }),
    ]);
  });

  describe('TC12: alert chegaralari konfiguratsiyadan (hardcode emas)', () => {
    it('sukutlar: 0.8 / 0.5 / 5 / 0', () => {
      expect(readAiMarginThresholds(cfg({}))).toEqual({
        capWarnRatio: 0.8,
        cacheHitMinRatio: 0.5,
        marketSpikeFactor: 5,
        marginMinUzs: 0,
      });
    });

    it('env qiymatlari o‘qiladi va alertlarni o‘zgartiradi', () => {
      const thresholds = readAiMarginThresholds(
        cfg({
          AI_CAP_WARN_RATIO: '0.9',
          AI_ALERT_CACHE_HIT_MIN_RATIO: '0.95',
          AI_ALERT_MARKET_SPIKE_FACTOR: '2',
          AI_ALERT_MARGIN_MIN_UZS: '1000',
        }),
      );
      expect(thresholds).toEqual({
        capWarnRatio: 0.9,
        cacheHitMinRatio: 0.95,
        marketSpikeFactor: 2,
        marginMinUzs: 1000,
      });
      const raw = input({
        costByMarket: [{ market_id: '12', calls: 1, usd: '0', uzs: '100' }],
        chargedByMarket: [
          {
            market_id: '12',
            ai_orders: 2,
            unpriced_orders: 0,
            free_orders: 0,
            charged_uzs: '600',
          },
        ],
        // hit-rate = 40720 / 44792 ≈ 0.909
        cacheByModel: HEALTHY_CACHE,
        marketDayCost: [
          { market_id: '12', day: '2026-10-01', uzs: '100' },
          { market_id: '12', day: '2026-10-02', uzs: '300' },
        ],
      });
      // Sukut chegaralarda alert yo'q.
      expect(buildAiMarginReport(raw).alerts).toEqual([]);
      // Env chegaralarida: marja 500 < 1000, hit 0.91 < 0.95, 300 > 2 × 100.
      const types = buildAiMarginReport({ ...raw, thresholds }).alerts.map(
        (a) => a.type,
      );
      expect(types.sort()).toEqual([
        'cache_hit_low',
        'market_spike',
        'negative_margin',
      ]);
    });

    it('yaroqsiz env qiymati — sukut', () => {
      expect(
        readAiMarginThresholds(
          cfg({
            AI_ALERT_CACHE_HIT_MIN_RATIO: '7',
            AI_ALERT_MARKET_SPIKE_FACTOR: '0.5',
            AI_CAP_WARN_RATIO: 'abc',
          }),
        ),
      ).toEqual(AI_MARGIN_DEFAULT_THRESHOLDS);
    });
  });
});

describe('NFiXfmq6 — AiMarginService.margin()', () => {
  const setup = (budget?: Partial<AiBudgetService>) => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new AiMarginService(
      { query } as unknown as Repository<AiUsageLog>,
      cfg({ AI_PRICE_PER_ORDER: 350 }),
      budget as AiBudgetService | undefined,
    );
    return { service, query };
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('TC2: charged va cost AYNAN bir vaqt oynasida (bir xil $1/$2), market filtri $3', async () => {
    const { service, query } = setup();
    const r = await service.margin('2026-10-01', '2026-10-15', '12');
    const cost = query.mock.calls.find(
      ([sql]) => sql === AI_MARGIN_COST_BY_MARKET_SQL,
    )!;
    const charged = query.mock.calls.find(
      ([sql]) => sql === AI_MARGIN_CHARGED_BY_MARKET_SQL,
    )!;
    expect(cost[1]).toEqual([
      '2026-10-01T00:00:00+05:00',
      '2026-10-16T00:00:00+05:00',
      '12',
    ]);
    expect(charged[1]).toEqual(cost[1]);
    expect(query).toHaveBeenCalledTimes(8);
    expect(r).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-15',
      marketId: '12',
      pricing: { defaultPricePerOrderUzs: 350 },
    });
  });

  it('market berilmasa $3 = null (hamma market)', async () => {
    const { service, query } = setup();
    await service.margin('2026-10-01', '2026-10-01');
    expect(query.mock.calls[0][1]).toEqual([
      '2026-10-01T00:00:00+05:00',
      '2026-10-02T00:00:00+05:00',
      null,
    ]);
  });

  it('noto‘g‘ri market_id / from > to — 400, SQL ketmaydi', async () => {
    const { service, query } = setup();
    await expect(
      service.margin('2026-10-01', '2026-10-02', '12; drop'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.margin('2026-10-05', '2026-10-01'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });

  it('shift holati (budget) o‘qilmasa hisobot baribir qaytadi', async () => {
    const { service } = setup({
      status: jest.fn().mockRejectedValue(new Error('db down')),
    });
    const r = await service.margin('2026-10-01', '2026-10-01');
    expect(r.alerts).toEqual([]);
  });

  it('shift 80% — daily_cap_warn alerti', async () => {
    const { service } = setup({
      status: jest.fn().mockResolvedValue({
        state: 'warn',
        ratio: 0.82,
        period_key: '2026-10-01',
      }),
    });
    const r = await service.margin('2026-10-01', '2026-10-01');
    expect(r.alerts[0]).toMatchObject({ type: 'daily_cap_warn', value: 0.82 });
  });
});
