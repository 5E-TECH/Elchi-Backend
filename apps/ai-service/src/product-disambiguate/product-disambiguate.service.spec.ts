import type { ConfigService } from '@nestjs/config';
import {
  AI_MODEL_DEFAULTS,
  type AiProductDisambiguateRequest,
  type ClaudeService,
  type ExtractJsonOptions,
} from '@app/common';
import {
  PRODUCT_DISAMBIG_SYSTEM,
  buildProductDisambigUserText,
} from '../prompts/product-disambiguate.prompt';
import { PRODUCT_DISAMBIG_SCHEMA } from '../prompts/product-disambiguate.schema';
import {
  PRODUCT_DISAMBIG_MAX_TOKENS,
  ProductDisambiguateService,
} from './product-disambiguate.service';

const CLASSIFY_MODEL = 'test-classify-model';

function req(
  overrides: Partial<AiProductDisambiguateRequest> = {},
): AiProductDisambiguateRequest {
  return {
    market_id: '121',
    requester: { id: '7', roles: ['market'] },
    trace_id: 'trace-9',
    draft_id: '0b9f7c3e-1d2a-4b5c-8d6e-7f8091a2b3c4',
    deadline_at: Date.now() + 20_000,
    items: [
      { item_index: 0, name: 'quloqchin', quantity: 1 },
      { item_index: 1, name: 'atir', quantity: 2 },
    ],
    catalog: [
      { index: 1, name: 'Simsiz quloqchin' },
      { index: 2, name: 'Simli quloqchin' },
      { index: 3, name: 'Atir 50 ml' },
    ],
    ...overrides,
  };
}

function ok(data: unknown) {
  return {
    ok: true as const,
    data,
    model: CLASSIFY_MODEL,
    attempts: 1 as const,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

describe('ProductDisambiguateService (luv25zlI)', () => {
  let extractJson: jest.Mock<Promise<unknown>, [ExtractJsonOptions]>;
  let configValues: Record<string, unknown>;
  let service: ProductDisambiguateService;

  function sentOptions(): ExtractJsonOptions {
    expect(extractJson).toHaveBeenCalledTimes(1);
    return extractJson.mock.calls[0][0];
  }

  beforeEach(() => {
    extractJson = jest
      .fn<Promise<unknown>, [ExtractJsonOptions]>()
      .mockResolvedValue(ok({ picks: [] }));
    configValues = { AI_CLASSIFY_MODEL: CLASSIFY_MODEL };
    service = new ProductDisambiguateService(
      { extractJson } as unknown as ClaudeService,
      {
        get: jest.fn((k: string) => configValues[k]),
      } as unknown as ConfigService,
    );
  });

  it('model = AI_CLASSIFY_MODEL, maxTokens 512, feature order_item_match', async () => {
    const r = req();
    await service.pick(r, 4321);
    const opts = sentOptions();
    expect(opts.model).toBe(CLASSIFY_MODEL);
    expect(opts.maxTokens).toBe(512);
    expect(PRODUCT_DISAMBIG_MAX_TOKENS).toBe(512);
    expect(opts.meta.feature).toBe('order_item_match');
    expect(opts.system).toBe(PRODUCT_DISAMBIG_SYSTEM);
    expect(opts.schema).toBe(PRODUCT_DISAMBIG_SCHEMA);
    expect(opts.userText).toBe(buildProductDisambigUserText(r));
    expect(opts.deadlineAt).toBe(4321);
    expect(opts.images).toBeUndefined();
  });

  it('env bo‘sh bo‘lsa sukut classify modeli (haiku)', async () => {
    configValues = {};
    await service.pick(req());
    expect(sentOptions().model).toBe(AI_MODEL_DEFAULTS.classify);
  });

  it('meta: 6 ta kalit to‘liq', async () => {
    await service.pick(req());
    expect(sentOptions().meta).toEqual({
      feature: 'order_item_match',
      requestArea: 'order',
      marketId: '121',
      userId: '7',
      traceId: 'trace-9',
      draftId: '0b9f7c3e-1d2a-4b5c-8d6e-7f8091a2b3c4',
    });
  });

  it('meta: draft_id/trace_id null bo‘lsa null', async () => {
    await service.pick(req({ draft_id: null, trace_id: null }));
    const meta = sentOptions().meta;
    expect(meta.draftId).toBeNull();
    expect(meta.traceId).toBeNull();
  });

  it('muvaffaqiyat → {ok:true, picks}; shakl tozalanadi, diapazon tekshirilmaydi', async () => {
    extractJson.mockResolvedValue(
      ok({
        picks: [
          { item_index: 0, choice: 1, product_id: '55' },
          { item_index: 1, choice: 0 },
          // diapazon/egalik order-service'da tekshiriladi — bu yerda o'tadi
          { item_index: 1, choice: 99 },
          { item_index: '1', choice: 2 },
          { item_index: 1.5, choice: 2 },
          null,
          'x',
        ],
      }),
    );
    await expect(service.pick(req())).resolves.toEqual({
      ok: true,
      picks: [
        { item_index: 0, choice: 1 },
        { item_index: 1, choice: 0 },
        { item_index: 1, choice: 99 },
      ],
    });
  });

  it('picks massiv bo‘lmasa bo‘sh ro‘yxat', async () => {
    extractJson.mockResolvedValue(ok({ picks: 'nope' }));
    await expect(service.pick(req())).resolves.toEqual({ ok: true, picks: [] });
  });

  it.each([
    'disabled',
    'network',
    'refused',
    'truncated',
    'invalid_json',
    'cap_exceeded',
  ])('xato %s → {ok:false, reason}', async (reason) => {
    extractJson.mockResolvedValue({
      ok: false,
      reason,
      attempts: 1,
      ...(reason === 'cap_exceeded'
        ? { scope: 'global', reset_at: '2026-09-28T00:00:00+05:00' }
        : {}),
    });
    await expect(service.pick(req())).resolves.toEqual({ ok: false, reason });
  });

  it('item yoki katalog bo‘sh → Claude chaqirilmaydi', async () => {
    await expect(service.pick(req({ items: [] }))).resolves.toEqual({
      ok: true,
      picks: [],
    });
    await expect(service.pick(req({ catalog: [] }))).resolves.toEqual({
      ok: true,
      picks: [],
    });
    expect(extractJson).not.toHaveBeenCalled();
  });
});
