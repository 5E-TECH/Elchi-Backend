import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RmqContext } from '@nestjs/microservices';
import type { Repository } from 'typeorm';
import type { RmqService } from '@app/common';
import { AiServiceController } from '../ai-service.controller';
import { AiUsageLog } from '../entities/ai-usage-log.entity';
import {
  AI_ORDERS_BY_DAY_SQL,
  AI_ORDERS_COUNT_SQL,
  AI_ORDERS_LIST_SQL,
  AI_USAGE_DASHBOARD_BY_AREA_SQL,
  AI_USAGE_DASHBOARD_BY_FEATURE_SQL,
  AI_USAGE_DASHBOARD_BY_MODEL_SQL,
  AI_USAGE_SUMMARY_BY_DAY_SQL,
  AI_USAGE_SUMMARY_TOTALS_SQL,
  AiUsageService,
} from './ai-usage.service';
import { TASHKENT_DAY_SQL, TASHKENT_DAY_SQL_CREATED_AT } from './tashkent-day';

/**
 * Celz3rKJ — "Moliyaviy balans → AI xarajat" paneli (`ai.usage.dashboard`,
 * `ai.usage.ai_orders`). SQL natijalari pg'dan SATR bo'lib kelishi mumkin —
 * javobda hammasi son.
 */
function setup(config: Record<string, unknown> = {}) {
  const query = jest.fn<Promise<unknown>, [string, unknown[]?]>();
  const repo = {
    create: jest.fn(),
    save: jest.fn(),
    query,
  } as unknown as Repository<AiUsageLog>;
  const service = new AiUsageService(repo, {
    get: (key: string): unknown =>
      ({ AI_USD_UZS_RATE: 12800, AI_ORDER_PRICE_UZS: 300, ...config })[key],
  } as unknown as ConfigService);
  return { service, query };
}

function mockDashboard(
  query: jest.Mock<Promise<unknown>, [string, unknown[]?]>,
) {
  query.mockImplementation((sql: string) => {
    switch (sql) {
      case AI_USAGE_SUMMARY_TOTALS_SQL:
        return Promise.resolve([
          {
            calls: '5',
            total_usd: '0.3',
            total_uzs: '3840.00',
            cache_saved_usd: '0.0027',
            cache_saved_uzs: '34.56',
            meta_incomplete_calls: '1',
            linked_calls: '2',
          },
        ]);
      case AI_USAGE_DASHBOARD_BY_AREA_SQL:
        return Promise.resolve([
          {
            area: 'order',
            calls: 5,
            input_tokens: '1000',
            output_tokens: '400',
            usd: '0.3',
            uzs: '3840.00',
          },
        ]);
      case AI_USAGE_DASHBOARD_BY_FEATURE_SQL:
        return Promise.resolve([
          {
            feature: 'order_extract_multi',
            area: 'order',
            calls: 3,
            steps: '4',
            input_tokens: '800',
            output_tokens: '300',
            usd: '0.25',
            uzs: '3200.00',
          },
          {
            feature: 'order_district',
            area: 'order',
            calls: 2,
            steps: '2',
            input_tokens: '200',
            output_tokens: '100',
            usd: '0.05',
            uzs: '640.00',
          },
        ]);
      case AI_USAGE_DASHBOARD_BY_MODEL_SQL:
        return Promise.resolve([
          { model: 'claude-sonnet-5', calls: 3, usd: '0.25', uzs: '3200.00' },
          { model: 'claude-haiku-4-5', calls: 2, usd: '0.05', uzs: '640.00' },
        ]);
      case AI_USAGE_SUMMARY_BY_DAY_SQL:
        return Promise.resolve([
          { day: '2026-10-01', calls: 2, usd: '0.1', uzs: '1280.00' },
          { day: '2026-10-03', calls: 3, usd: '0.2', uzs: '2560.00' },
        ]);
      case AI_ORDERS_BY_DAY_SQL:
        return Promise.resolve([
          { day: '2026-10-01', orders: '2' },
          { day: '2026-10-03', orders: '4' },
        ]);
      default:
        return Promise.reject(new Error('kutilmagan SQL'));
    }
  });
}

describe('Celz3rKJ — AiUsageService.dashboard()', () => {
  it('⭐ TC2: summary.totalCostUsd va totalCostUzs — son (satr emas)', async () => {
    const { service, query } = setup();
    mockDashboard(query);
    const res = await service.dashboard('2026-10-01', '2026-10-03');

    expect(res.summary.totalCostUsd).toBe(0.3);
    expect(res.summary.totalCostUzs).toBe(3840);
    expect(typeof res.summary.totalCostUsd).toBe('number');
    expect(res.summary).toEqual({
      totalCostUsd: 0.3,
      totalCostUzs: 3840,
      totalCalls: 5,
      cacheSavedUsd: 0.0027,
      cacheSavedUzs: 34.56,
      metaIncompleteCalls: 1,
      linkedCalls: 2,
      aiOrderCount: 6,
      orderCostUsd: 0.3,
      orderCostUzs: 3840,
      avgCostPerAiOrderUsd: 0.05,
      avgCostPerAiOrderUzs: 640,
    });
    expect(res.usdUzsRate).toBe(12800);
    expect(res.from).toBe('2026-10-01');
    expect(res.to).toBe('2026-10-03');
  });

  it('⭐ TC4: feature kesimi — order_extract_multi, order_district qatorlari', async () => {
    const { service, query } = setup();
    mockDashboard(query);
    const res = await service.dashboard('2026-10-01', '2026-10-03');
    expect(res.byFeature).toEqual([
      {
        feature: 'order_extract_multi',
        area: 'order',
        calls: 3,
        steps: 4,
        inputTokens: 800,
        outputTokens: 300,
        costUsd: 0.25,
        costUzs: 3200,
      },
      {
        feature: 'order_district',
        area: 'order',
        calls: 2,
        steps: 2,
        inputTokens: 200,
        outputTokens: 100,
        costUsd: 0.05,
        costUzs: 640,
      },
    ]);
    expect(res.byModel.map((m) => m.model)).toEqual([
      'claude-sonnet-5',
      'claude-haiku-4-5',
    ]);
    expect(res.byArea[0]).toEqual({
      area: 'order',
      calls: 5,
      inputTokens: 1000,
      outputTokens: 400,
      costUsd: 0.3,
      costUzs: 3840,
    });
  });

  it('⭐ TC5: kunlik seriya — xarajat + chaqiruv + AI buyurtma, bo`sh kun 0 bilan', async () => {
    const { service, query } = setup();
    mockDashboard(query);
    const res = await service.dashboard('2026-10-01', '2026-10-03');
    expect(res.dailySeries).toEqual([
      { day: '2026-10-01', costUsd: 0.1, costUzs: 1280, calls: 2, aiOrders: 2 },
      { day: '2026-10-02', costUsd: 0, costUzs: 0, calls: 0, aiOrders: 0 },
      { day: '2026-10-03', costUsd: 0.2, costUzs: 2560, calls: 3, aiOrders: 4 },
    ]);
  });

  it('⭐ TC5: kun bucketi SQL`da Asia/Tashkent bo`yicha (UTC emas)', () => {
    expect(TASHKENT_DAY_SQL).toContain("AT TIME ZONE 'Asia/Tashkent'");
    expect(TASHKENT_DAY_SQL_CREATED_AT).toContain(
      "AT TIME ZONE 'Asia/Tashkent'",
    );
    expect(AI_USAGE_SUMMARY_BY_DAY_SQL).toContain(
      `GROUP BY ${TASHKENT_DAY_SQL}`,
    );
    expect(AI_ORDERS_BY_DAY_SQL).toContain(
      `GROUP BY ${TASHKENT_DAY_SQL_CREATED_AT}`,
    );
    for (const sql of [
      AI_USAGE_DASHBOARD_BY_AREA_SQL,
      AI_USAGE_DASHBOARD_BY_FEATURE_SQL,
      AI_USAGE_DASHBOARD_BY_MODEL_SQL,
    ]) {
      expect(sql).toContain('ai_schema.ai_usage_log');
      expect(sql).toContain('is_deleted = false');
      expect(sql).toContain('::float8');
    }
    expect(AI_ORDERS_BY_DAY_SQL).toContain('ai_schema.ai_order_draft_item');
  });

  it('davr chegaralari — Toshkent yarim tunlari, barcha so`rovlarda bir xil', async () => {
    const { service, query } = setup();
    mockDashboard(query);
    await service.dashboard('2026-10-01', '2026-10-03');
    expect(query).toHaveBeenCalledTimes(6);
    for (const call of query.mock.calls) {
      expect(call[1]).toEqual([
        '2026-10-01T00:00:00+05:00',
        '2026-10-04T00:00:00+05:00',
      ]);
    }
  });

  it('AI buyurtma yo`q — o`rtacha 0 (NaN/Infinity emas)', async () => {
    const { service, query } = setup();
    query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql === AI_USAGE_DASHBOARD_BY_AREA_SQL
          ? [{ area: 'order', calls: 1, usd: '0.1', uzs: '1280' }]
          : [],
      ),
    );
    const res = await service.dashboard('2026-10-01', '2026-10-01');
    expect(res.summary.aiOrderCount).toBe(0);
    expect(res.summary.avgCostPerAiOrderUsd).toBe(0);
    expect(res.summary.avgCostPerAiOrderUzs).toBe(0);
    expect(res.summary.totalCostUsd).toBe(0);
    expect(res.dailySeries).toEqual([
      { day: '2026-10-01', costUsd: 0, costUzs: 0, calls: 0, aiOrders: 0 },
    ]);
  });

  it('366 kundan uzun davr — bo`sh kunlar to`ldirilmaydi (faqat ma`lumotli kunlar)', async () => {
    const { service, query } = setup();
    mockDashboard(query);
    const res = await service.dashboard('2020-01-01', '2026-10-03');
    expect(res.dailySeries.map((d) => d.day)).toEqual([
      '2026-10-01',
      '2026-10-03',
    ]);
  });

  it('from > to → 400 (SQL ketmaydi)', async () => {
    const { service, query } = setup();
    await expect(
      service.dashboard('2026-10-05', '2026-10-01'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('Celz3rKJ — AiUsageService.aiOrders()', () => {
  it('ro`yxat: draft xarajati, model, tahrirlangan maydonlar; limit 100 dan oshmaydi', async () => {
    const { service, query } = setup();
    query.mockImplementation((sql: string) => {
      if (sql === AI_ORDERS_LIST_SQL) {
        return Promise.resolve([
          {
            order_id: '501',
            draft_id: '5f2b8c1e-0000-4000-8000-000000000001',
            market_id: '12',
            confirmed_by: '34',
            edited_fields: ['district_id'],
            created_at: new Date('2026-10-01T07:00:00Z'),
            model: 'claude-sonnet-5',
            source_kind: 'text',
            draft_cost_usd: '0.012',
            draft_cost_uzs: '153.60',
            draft_orders: '2',
          },
        ]);
      }
      if (sql === AI_ORDERS_COUNT_SQL) {
        return Promise.resolve([{ total: '7' }]);
      }
      return Promise.reject(new Error('kutilmagan SQL'));
    });

    const res = await service.aiOrders('2026-10-01', '2026-10-14', 500);
    expect(res.limit).toBe(100);
    expect(res.total).toBe(7);
    expect(res.items).toEqual([
      {
        orderId: '501',
        draftId: '5f2b8c1e-0000-4000-8000-000000000001',
        marketId: '12',
        confirmedBy: '34',
        editedFields: ['district_id'],
        createdAt: '2026-10-01T07:00:00.000Z',
        model: 'claude-sonnet-5',
        sourceKind: 'text',
        draftCostUsd: 0.012,
        draftCostUzs: 153.6,
        draftOrders: 2,
      },
    ]);
    const listCall = query.mock.calls.find(
      ([sql]) => sql === AI_ORDERS_LIST_SQL,
    );
    expect(listCall?.[1]).toEqual([
      '2026-10-01T00:00:00+05:00',
      '2026-10-15T00:00:00+05:00',
      100,
    ]);
  });

  it.each([[undefined], [0], [-5], ['abc']])(
    'limit=%p → 100 (sukut)',
    async (limit) => {
      const { service, query } = setup();
      query.mockResolvedValue([]);
      const res = await service.aiOrders('2026-10-01', '2026-10-01', limit);
      expect(res.limit).toBe(100);
      expect(res.items).toEqual([]);
      expect(res.total).toBe(0);
    },
  );
});

describe('Celz3rKJ — RMQ: ai.usage.dashboard / ai.usage.ai_orders', () => {
  const ctx = {} as RmqContext;
  const make = (usage: Partial<AiUsageService>) =>
    new AiServiceController(
      { ack: jest.fn(), nackForError: jest.fn() } as unknown as RmqService,
      { get: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      usage as AiUsageService,
      {} as never,
      {} as never,
      {} as never,
    );

  it('dashboard(from, to) ga uzatiladi', async () => {
    const dashboard = jest.fn().mockResolvedValue({ summary: {} });
    await make({ dashboard }).usageDashboard(
      { from: '2026-10-01', to: '2026-10-14' },
      ctx,
    );
    expect(dashboard).toHaveBeenCalledWith('2026-10-01', '2026-10-14');
  });

  it('aiOrders(from, to, limit) ga uzatiladi', async () => {
    const aiOrders = jest.fn().mockResolvedValue({ items: [] });
    await make({ aiOrders }).usageAiOrders(
      { from: '2026-10-01', to: '2026-10-14', limit: 20 },
      ctx,
    );
    expect(aiOrders).toHaveBeenCalledWith('2026-10-01', '2026-10-14', 20);
  });

  it('BadRequestException → RpcException 400 (requeue yo`q)', async () => {
    const dashboard = jest
      .fn()
      .mockRejectedValue(new BadRequestException('from > to'));
    const err = await make({ dashboard })
      .usageDashboard({ from: '2026-10-05', to: '2026-10-01' }, ctx)
      .catch((e: { getError?: () => { statusCode?: number } }) => e);
    expect(
      (err as { getError: () => { statusCode?: number } }).getError()
        .statusCode,
    ).toBe(400);
  });
});
