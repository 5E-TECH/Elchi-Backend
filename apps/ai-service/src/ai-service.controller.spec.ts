import { BadRequestException, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { RpcException, type RmqContext } from '@nestjs/microservices';
import type {
  AiOrderExtractRequest,
  AiProductDisambiguateRequest,
  AiStatusResponse,
  ClaudeService,
  RmqService,
} from '@app/common';
import { AiServiceController } from './ai-service.controller';
import type { AiBudgetService } from './budget/ai-budget.service';
import { OrderExtractService } from './order-extract/order-extract.service';
import type { ProductDisambiguateService } from './product-disambiguate/product-disambiguate.service';
import type { AiUsageService } from './usage/ai-usage.service';

const CAP: AiStatusResponse['cap'] = {
  period_key: '2026-09-27',
  spent_usd: 1.5,
  cap_usd: 50,
  override_usd: 0,
  effective_cap_usd: 50,
  ratio: 0.03,
  state: 'ok',
  reset_at: '2026-09-28T00:00:00+05:00',
};

function extractReq(
  overrides: Partial<AiOrderExtractRequest> = {},
): AiOrderExtractRequest {
  return {
    text: 'Ali 90 123 45 67 Andijon Asaka atir',
    market_id: '121',
    requester: { id: '7', roles: ['market'] },
    trace_id: null,
    draft_id: '0b9f7c3e-1d2a-4b5c-8d6e-7f8091a2b3c4',
    deadline_at: Date.now() + 60_000,
    ...overrides,
  };
}

function disambigReq(): AiProductDisambiguateRequest {
  return {
    market_id: '121',
    requester: { id: '7', roles: ['market'] },
    trace_id: null,
    draft_id: null,
    deadline_at: Date.now() + 20_000,
    items: [{ item_index: 0, name: 'atir', quantity: 1 }],
    catalog: [
      { index: 1, name: 'Atir 50 ml' },
      { index: 2, name: 'Atir 100 ml' },
      { index: 3, name: 'Krem' },
    ],
  };
}

describe('AiServiceController', () => {
  let ack: jest.Mock;
  let nackForError: jest.Mock;
  let ctx: RmqContext;
  let configValues: Record<string, unknown>;
  let claude: {
    isEnabled: jest.Mock;
    keyState: jest.Mock;
    extractJson: jest.Mock;
  };
  let extract: jest.Mock;
  let pick: jest.Mock;
  let usage: {
    summary: jest.Mock;
    linkOrders: jest.Mock;
    persistFailures: jest.Mock;
  };
  let budget: { status: jest.Mock; raise: jest.Mock };
  let config: { get: jest.Mock };

  function build(orderExtract?: OrderExtractService): AiServiceController {
    return new AiServiceController(
      { ack, nackForError } as unknown as RmqService,
      config as unknown as ConfigService,
      claude as unknown as ClaudeService,
      orderExtract ?? ({ extract } as unknown as OrderExtractService),
      { pick } as unknown as ProductDisambiguateService,
      usage as unknown as AiUsageService,
      budget as unknown as AiBudgetService,
    );
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    ack = jest.fn();
    nackForError = jest.fn();
    ctx = { getPattern: () => 'test' } as unknown as RmqContext;
    configValues = {
      AI_ORDER_MODEL: 'claude-sonnet-5',
      AI_ORDER_VISION_MODEL: 'claude-sonnet-5',
      AI_CLASSIFY_MODEL: 'claude-haiku-4-5',
      AI_DAILY_USD_CAP: 50,
    };
    config = { get: jest.fn((k: string) => configValues[k]) };
    claude = {
      isEnabled: jest.fn().mockReturnValue(true),
      keyState: jest.fn().mockReturnValue({ state: 'ok', misnamedKeys: [] }),
      extractJson: jest.fn(),
    };
    extract = jest.fn();
    pick = jest.fn();
    usage = {
      summary: jest.fn(),
      linkOrders: jest.fn(),
      persistFailures: jest.fn().mockReturnValue(0),
    };
    budget = { status: jest.fn().mockResolvedValue(CAP), raise: jest.fn() };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('ai.health', () => {
    it('shakl: {service, status, ai, timestamp} va ack', async () => {
      const res = await build().health(ctx);
      expect(res).toEqual({
        service: 'ai-service',
        status: 'ok',
        ai: 'enabled',
        timestamp: expect.any(String) as unknown as string,
      });
      expect(Number.isNaN(Date.parse(res.timestamp))).toBe(false);
      expect(ack).toHaveBeenCalledWith(ctx);
    });

    it("kalit yo'q → ai: 'disabled'", async () => {
      claude.isEnabled.mockReturnValue(false);
      await expect(build().health(ctx)).resolves.toMatchObject({
        ai: 'disabled',
      });
    });
  });

  describe('ai.order.extract', () => {
    it('servis natijasini qaytaradi va ack qiladi', async () => {
      extract.mockResolvedValue({ ok: true, orders: [] });
      const data = extractReq();
      await expect(build().extractOrders(data, ctx)).resolves.toEqual({
        ok: true,
        orders: [],
      });
      expect(extract).toHaveBeenCalledWith(data, data.deadline_at);
      expect(ack).toHaveBeenCalledWith(ctx);
      expect(nackForError).not.toHaveBeenCalled();
    });

    it('servis reject qilsa → {ok:false, reason:network}, throw YO‘Q, ack', async () => {
      extract.mockRejectedValue(new Error('boom'));
      await expect(build().extractOrders(extractReq(), ctx)).resolves.toEqual({
        ok: false,
        reason: 'network',
      });
      expect(ack).toHaveBeenCalledWith(ctx);
      expect(nackForError).not.toHaveBeenCalled();
    });

    it('haqiqiy OrderExtractService + ClaudeService reject → baribir network', async () => {
      claude.extractJson.mockRejectedValue(new Error('sdk exploded'));
      const real = new OrderExtractService(
        claude as unknown as ClaudeService,
        config as unknown as ConfigService,
      );
      await expect(
        build(real).extractOrders(extractReq(), ctx),
      ).resolves.toEqual({ ok: false, reason: 'network' });
      expect(ack).toHaveBeenCalledWith(ctx);
    });

    it('eskirgan xabar → servis chaqirilmaydi, network', async () => {
      const res = await build().extractOrders(
        extractReq({ deadline_at: Date.now() - 1 }),
        ctx,
      );
      expect(res).toEqual({ ok: false, reason: 'network' });
      expect(extract).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledWith(ctx);
    });

    it('AI xato natijasi (cap_exceeded) o‘zgarishsiz qaytadi', async () => {
      const fail = {
        ok: false,
        reason: 'cap_exceeded',
        scope: 'global',
        reset_at: CAP.reset_at,
      };
      extract.mockResolvedValue(fail);
      await expect(build().extractOrders(extractReq(), ctx)).resolves.toEqual(
        fail,
      );
    });
  });

  describe('ai.product.disambiguate', () => {
    it('servis natijasi', async () => {
      pick.mockResolvedValue({
        ok: true,
        picks: [{ item_index: 0, choice: 1 }],
      });
      const data = disambigReq();
      await expect(build().disambiguateProducts(data, ctx)).resolves.toEqual({
        ok: true,
        picks: [{ item_index: 0, choice: 1 }],
      });
      expect(pick).toHaveBeenCalledWith(data, data.deadline_at);
      expect(ack).toHaveBeenCalledWith(ctx);
    });

    it('servis reject qilsa → {ok:false, reason:network}, throw YO‘Q', async () => {
      pick.mockRejectedValue(new Error('boom'));
      await expect(
        build().disambiguateProducts(disambigReq(), ctx),
      ).resolves.toEqual({ ok: false, reason: 'network' });
      expect(ack).toHaveBeenCalledWith(ctx);
      expect(nackForError).not.toHaveBeenCalled();
    });
  });

  describe('ai.status', () => {
    it('AiStatusResponse: holat, modellar, shift, jurnal xatolari', async () => {
      usage.persistFailures.mockReturnValue(2);
      await expect(build().status(ctx)).resolves.toEqual({
        enabled: true,
        key_state: 'ok',
        models: {
          order: 'claude-sonnet-5',
          vision: 'claude-sonnet-5',
          classify: 'claude-haiku-4-5',
        },
        cap: CAP,
        usage_persist_failures: 2,
      });
      expect(ack).toHaveBeenCalledWith(ctx);
    });

    it("kalit misnamed → enabled:false, key_state 'misnamed' (qiymat yo'q)", async () => {
      claude.isEnabled.mockReturnValue(false);
      claude.keyState.mockReturnValue({
        state: 'misnamed',
        misnamedKeys: ['ANTROPIC_API_KEY'],
      });
      const res = await build().status(ctx);
      expect(res.enabled).toBe(false);
      expect(res.key_state).toBe('misnamed');
      expect(JSON.stringify(res)).not.toContain('ANTROPIC_API_KEY');
    });

    it("budget.status() xato → cap.state 'unknown', status yiqilmaydi", async () => {
      budget.status.mockRejectedValue(new Error('db down'));
      const res = await build().status(ctx);
      expect(res.cap.state).toBe('unknown');
      expect(res.cap.cap_usd).toBe(50);
      expect(res.cap.period_key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof res.cap.reset_at).toBe('string');
      expect(ack).toHaveBeenCalledWith(ctx);
      expect(nackForError).not.toHaveBeenCalled();
    });

    it('modellar env bo‘sh bo‘lsa sukut qiymatlar', async () => {
      configValues = {};
      const res = await build().status(ctx);
      expect(res.models).toEqual({
        order: 'claude-sonnet-5',
        vision: 'claude-sonnet-5',
        classify: 'claude-haiku-4-5',
      });
    });
  });

  describe('admin handlerlar', () => {
    it('ai.cap.raise → budget.raise(extra_usd, reason, requester)', async () => {
      const out = {
        period_key: '2026-09-27',
        override_usd: 10,
        effective_cap_usd: 60,
      };
      budget.raise.mockResolvedValue(out);
      const requester = { id: '1', roles: ['superadmin'] };
      await expect(
        build().raiseCap({ extra_usd: 10, reason: 'aksiya', requester }, ctx),
      ).resolves.toEqual(out);
      expect(budget.raise).toHaveBeenCalledWith(10, 'aksiya', requester);
      expect(ack).toHaveBeenCalledWith(ctx);
    });

    it('ai.usage.summary → usage.summary(from, to)', async () => {
      const summary = { total_usd: 1, calls: 3 };
      usage.summary.mockResolvedValue(summary);
      await expect(
        build().usageSummary({ from: '2026-09-01', to: '2026-09-27' }, ctx),
      ).resolves.toEqual(summary);
      expect(usage.summary).toHaveBeenCalledWith('2026-09-01', '2026-09-27');
    });

    it('ai.usage.link_orders → usage.linkOrders(draft_id, order_ids, market_id)', async () => {
      usage.linkOrders.mockResolvedValue({ updated: 2 });
      await expect(
        build().linkOrders(
          { draft_id: 'd-1', order_ids: ['10', '11'], market_id: '121' },
          ctx,
        ),
      ).resolves.toEqual({ updated: 2 });
      expect(usage.linkOrders).toHaveBeenCalledWith('d-1', ['10', '11'], '121');
    });

    it('kutilmagan xato RpcException’ga o‘raladi (DLQ, requeue YO‘Q)', async () => {
      usage.summary.mockRejectedValue(new Error('db down'));
      const err: unknown = await build()
        .usageSummary({}, ctx)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RpcException);
      expect(nackForError).toHaveBeenCalledWith(ctx, err);
      expect(ack).not.toHaveBeenCalled();
    });

    it('HTTP-uslubdagi xato status kodi bilan o‘raladi', async () => {
      budget.raise.mockRejectedValue(
        new BadRequestException('noto‘g‘ri summa'),
      );
      const err = (await build()
        .raiseCap(
          { extra_usd: -1, reason: 'x', requester: { id: '1', roles: [] } },
          ctx,
        )
        .catch((e: unknown) => e)) as RpcException;
      expect(err).toBeInstanceOf(RpcException);
      expect(err.getError()).toMatchObject({
        statusCode: 400,
        message: 'noto‘g‘ri summa',
      });
    });

    it('link_orders xatosi ham RpcException (throw qilinadi, requeue yo‘q)', async () => {
      usage.linkOrders.mockRejectedValue(new Error('timeout'));
      await expect(
        build().linkOrders(
          { draft_id: 'd', order_ids: ['1'], market_id: '1' },
          ctx,
        ),
      ).rejects.toBeInstanceOf(RpcException);
      expect(nackForError).toHaveBeenCalledTimes(1);
    });
  });
});
