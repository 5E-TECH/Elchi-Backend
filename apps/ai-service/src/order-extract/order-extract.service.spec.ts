import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  AI_MAX_ITEMS_PER_ORDER,
  AI_MAX_ORDERS_PER_PARSE,
  AI_MODEL_DEFAULTS,
  type AiOrderExtractRequest,
  type ClaudeService,
  type ExtractJsonOptions,
} from '@app/common';
import type { AiDraftService } from '../draft/ai-draft.service';
import {
  ORDER_EXTRACT_PROMPT_VERSION,
  ORDER_EXTRACT_SYSTEM,
} from '../prompts/order-extract.prompt';
import { ORDER_EXTRACT_SCHEMA } from '../prompts/order-extract.schema';
import {
  ORDER_EXTRACT_EFFORT,
  ORDER_EXTRACT_MAX_TOKENS,
  OrderExtractService,
  chunkImages,
  estimateOrderCount,
  orderExtractMaxTokens,
} from './order-extract.service';

const TEXT_MODEL = 'test-order-model';
const VISION_MODEL = 'test-vision-model';

function rawOrder(overrides: Record<string, unknown> = {}) {
  return {
    customer_name: 'Ali',
    phone_number: '[TEL_1]',
    extra_number: null,
    region_name: 'Andijon',
    district_name: 'Asaka',
    address: null,
    full_address: null,
    items: [{ name: 'atir', quantity: 3 }],
    total_price: 750000,
    comment: null,
    where_deliver: 'address',
    is_replacement: false,
    operator: null,
    warnings: [],
    ...overrides,
  };
}

function okResult(data: unknown) {
  return {
    ok: true as const,
    data,
    model: TEXT_MODEL,
    attempts: 1 as const,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

function baseReq(
  overrides: Partial<AiOrderExtractRequest> = {},
): AiOrderExtractRequest {
  return {
    text: 'Ali 90 123 45 67 Andijon Asaka 3 ta atir donasi 250 ming',
    market_id: '121',
    requester: { id: '7', roles: ['market'] },
    trace_id: 'trace-1',
    draft_id: '0b9f7c3e-1d2a-4b5c-8d6e-7f8091a2b3c4',
    deadline_at: Date.now() + 60_000,
    ...overrides,
  };
}

describe('OrderExtractService', () => {
  let extractJson: jest.Mock<Promise<unknown>, [ExtractJsonOptions]>;
  let configValues: Record<string, unknown>;
  let service: OrderExtractService;

  /** extractJson'ga uzatilgan opsiyalar (birinchi chaqiruv). */
  function sentOptions(): ExtractJsonOptions {
    expect(extractJson).toHaveBeenCalledTimes(1);
    return extractJson.mock.calls[0][0];
  }

  beforeEach(() => {
    // Chegara WARN'lari test chiqishini to'ldirmasin.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    extractJson = jest
      .fn<Promise<unknown>, [ExtractJsonOptions]>()
      .mockResolvedValue(okResult({ orders: [] }));
    configValues = {
      AI_ORDER_MODEL: TEXT_MODEL,
      AI_ORDER_VISION_MODEL: VISION_MODEL,
    };
    const config = { get: jest.fn((key: string) => configValues[key]) };
    service = new OrderExtractService(
      { extractJson } as unknown as ClaudeService,
      config as unknown as ConfigService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('model va feature tanlovi', () => {
    it('faqat matn → AI_ORDER_MODEL, order_extract_multi, effort low, max_tokens 1500+600×N', async () => {
      const req = baseReq();
      await service.extract(req, 1234);
      const opts = sentOptions();
      expect(opts.system).toBe(ORDER_EXTRACT_SYSTEM);
      expect(opts.schema).toBe(ORDER_EXTRACT_SCHEMA);
      expect(opts.model).toBe(TEXT_MODEL);
      // WHMAIqyo #1: bitta telefon → 1 buyurtma → 1500 + 600.
      expect(opts.maxTokens).toBe(2100);
      expect(opts.effort).toBe('low');
      expect(ORDER_EXTRACT_EFFORT).toBe('low');
      expect(ORDER_EXTRACT_MAX_TOKENS).toBe(16000);
      expect(opts.meta.feature).toBe('order_extract_multi');
      expect(opts.images).toEqual([]);
      expect(opts.deadlineAt).toBe(1234);
    });

    it('rasm bor → AI_ORDER_VISION_MODEL, order_extract_image, rasm bloklari', async () => {
      await service.extract(
        baseReq({
          text: 'Asaka',
          images: [
            { media_type: 'image/jpeg', data_base64: 'QUJD' },
            { media_type: 'image/png', data_base64: 'REVG' },
          ],
        }),
      );
      const opts = sentOptions();
      expect(opts.model).toBe(VISION_MODEL);
      // matn (1) + 2 rasm × 3 = 7 buyurtma → 1500 + 600 × 7.
      expect(opts.maxTokens).toBe(5700);
      expect(opts.effort).toBe('low');
      expect(opts.meta.feature).toBe('order_extract_image');
      expect(opts.images).toEqual([
        { mediaType: 'image/jpeg', dataBase64: 'QUJD' },
        { mediaType: 'image/png', dataBase64: 'REVG' },
      ]);
    });

    it('faqat rasm → userText bo‘sh (qo‘shimcha gap YO‘Q)', async () => {
      await service.extract(
        baseReq({
          text: undefined,
          images: [{ media_type: 'image/jpeg', data_base64: 'QUJD' }],
        }),
      );
      expect(sentOptions().userText).toBe('');
    });

    it('env bo‘sh bo‘lsa AI_MODEL_DEFAULTS ishlatiladi', async () => {
      configValues = {};
      await service.extract(baseReq());
      await service.extract(
        baseReq({ images: [{ media_type: 'image/png', data_base64: 'QQ==' }] }),
      );
      const calls = extractJson.mock.calls;
      expect(calls[0][0].model).toBe(AI_MODEL_DEFAULTS.order);
      expect(calls[1][0].model).toBe(AI_MODEL_DEFAULTS.vision);
    });
  });

  it('meta: 6 ta kalitning HAMMASI uzatiladi', async () => {
    await service.extract(baseReq());
    expect(sentOptions().meta).toEqual({
      feature: 'order_extract_multi',
      requestArea: 'order',
      marketId: '121',
      userId: '7',
      traceId: 'trace-1',
      draftId: '0b9f7c3e-1d2a-4b5c-8d6e-7f8091a2b3c4',
    });
  });

  it('meta: berilmagan qiymatlar null bo‘ladi (kalit baribir bor)', async () => {
    await service.extract(
      baseReq({
        trace_id: null,
        draft_id: undefined as unknown as string,
        requester: undefined as unknown as AiOrderExtractRequest['requester'],
      }),
    );
    const meta = sentOptions().meta;
    expect(Object.keys(meta).sort()).toEqual(
      [
        'draftId',
        'feature',
        'marketId',
        'requestArea',
        'traceId',
        'userId',
      ].sort(),
    );
    expect(meta.userId).toBeNull();
    expect(meta.traceId).toBeNull();
    expect(meta.draftId).toBeNull();
  });

  describe('telefon maskalash (HD5zOyBp)', () => {
    it('#1: Claude’ga ketgan userText’da telefon raqami YO‘Q, [TEL_1] bor', async () => {
      await service.extract(
        baseReq({
          text: '  Ali +998 (90) 123-45-67, qo‘shimcha 91 234 56 78, Andijon Asaka  ',
        }),
      );
      const userText = sentOptions().userText;
      expect(userText).toContain('[TEL_1]');
      expect(userText).toContain('[TEL_2]');
      expect(userText).not.toMatch(/\d(?:[ .\-()]*\d){6}/);
      expect(userText.replace(/\D/g, '')).not.toContain('901234567');
      expect(userText.replace(/\D/g, '')).not.toContain('912345678');
      // trim qilingan
      expect(userText.startsWith('Ali')).toBe(true);
    });

    it('#2: token har buyurtmada o‘z raqamiga qaytadi, aralashmaydi', async () => {
      extractJson.mockResolvedValue(
        okResult({
          orders: [
            rawOrder({ customer_name: 'Ali', phone_number: '[TEL_1]' }),
            rawOrder({
              customer_name: 'Vali',
              phone_number: '[TEL_2]',
              extra_number: '[TEL_1]',
            }),
          ],
        }),
      );
      const res = await service.extract(
        baseReq({
          text: 'Ali 90 123 45 67; Vali 91 234 56 78 (yoki 901234567)',
        }),
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.orders.map((o) => [o.customer_name, o.phone_number])).toEqual([
        ['Ali', '+998901234567'],
        ['Vali', '+998912345678'],
      ]);
      expect(res.orders[1].extra_number).toBe('+998901234567');
      expect(JSON.stringify(res)).not.toContain('TEL_');
    });

    it('#2: model o‘ylab topgan token ([TEL_9]) null bo‘ladi, sizib chiqmaydi', async () => {
      extractJson.mockResolvedValue(
        okResult({ orders: [rawOrder({ phone_number: '[TEL_9]' })] }),
      );
      const res = await service.extract(baseReq({ text: 'Ali 90 123 45 67' }));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.orders[0].phone_number).toBeNull();
      expect(JSON.stringify(res)).not.toContain('TEL_');
    });

    it('#3: telefonsiz matn o‘zgarmaydi', async () => {
      const text = '3 ta atir, donasi 250 ming, 1 500 000 so‘m, Andijon Asaka';
      await service.extract(baseReq({ text }));
      expect(sentOptions().userText).toBe(text);
    });
  });

  describe('xato natija o‘zgarishsiz uzatiladi', () => {
    it.each([
      'disabled',
      'refused',
      'truncated',
      'network',
      'invalid_json',
      'ai_error',
    ])('%s', async (reason) => {
      extractJson.mockResolvedValue({ ok: false, reason, attempts: 1 });
      await expect(service.extract(baseReq())).resolves.toEqual({
        ok: false,
        reason,
      });
    });

    it('cap_exceeded — scope va reset_at bilan', async () => {
      extractJson.mockResolvedValue({
        ok: false,
        reason: 'cap_exceeded',
        scope: 'global',
        reset_at: '2026-09-28T00:00:00+05:00',
        attempts: 0,
      });
      await expect(service.extract(baseReq())).resolves.toEqual({
        ok: false,
        reason: 'cap_exceeded',
        scope: 'global',
        reset_at: '2026-09-28T00:00:00+05:00',
      });
    });
  });

  describe('chegaralar', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        rawOrder({ customer_name: `M${i}`, phone_number: '[TEL_1]' }),
      );

    it(`${AI_MAX_ORDERS_PER_PARSE} dan ko‘p buyurtma → truncated`, async () => {
      extractJson.mockResolvedValue(
        okResult({ orders: many(AI_MAX_ORDERS_PER_PARSE + 1) }),
      );
      await expect(service.extract(baseReq())).resolves.toEqual({
        ok: false,
        reason: 'truncated',
      });
    });

    it(`aynan ${AI_MAX_ORDERS_PER_PARSE} ta buyurtma → ok`, async () => {
      extractJson.mockResolvedValue(
        okResult({ orders: many(AI_MAX_ORDERS_PER_PARSE) }),
      );
      const res = await service.extract(baseReq());
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.orders).toHaveLength(AI_MAX_ORDERS_PER_PARSE);
    });

    it('axlat elementlari chegaraga hisoblanmaydi (sanitize’dan keyin)', async () => {
      const junk = rawOrder({ phone_number: null, items: [] });
      extractJson.mockResolvedValue(
        okResult({ orders: [...many(AI_MAX_ORDERS_PER_PARSE), junk] }),
      );
      const res = await service.extract(baseReq());
      expect(res.ok).toBe(true);
    });

    it(`bitta buyurtmada ${AI_MAX_ITEMS_PER_ORDER} dan ko‘p qator → truncated`, async () => {
      const items = Array.from(
        { length: AI_MAX_ITEMS_PER_ORDER + 1 },
        (_, i) => ({ name: `mahsulot ${i}`, quantity: 1 }),
      );
      extractJson.mockResolvedValue(
        okResult({ orders: [rawOrder({ items })] }),
      );
      await expect(service.extract(baseReq())).resolves.toEqual({
        ok: false,
        reason: 'truncated',
      });
    });
  });

  it('natija sanitize’dan o‘tadi (begona kalit, #, narx, enum)', async () => {
    extractJson.mockResolvedValue(
      okResult({
        orders: [
          rawOrder({
            district_id: '160',
            operator: '#sevinch',
            total_price: -1,
            where_deliver: 'free',
          }),
        ],
      }),
    );
    const res = await service.extract(baseReq());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.orders[0]).not.toHaveProperty('district_id');
    expect(res.orders[0].operator).toBe('sevinch');
    expect(res.orders[0].total_price).toBeNull();
    expect(res.orders[0].where_deliver).toBeNull();
  });

  it('Claude javobi kutilmagan shaklda bo‘lsa bo‘sh ro‘yxat (throw yo‘q)', async () => {
    extractJson.mockResolvedValue(okResult({ orders: 'nope' }));
    await expect(service.extract(baseReq())).resolves.toEqual({
      ok: true,
      orders: [],
    });
  });

  it('matn ham, rasm ham yo‘q → Claude chaqirilmaydi', async () => {
    await expect(
      service.extract(baseReq({ text: '   ', images: [] })),
    ).resolves.toEqual({ ok: true, orders: [] });
    expect(extractJson).not.toHaveBeenCalled();
  });

  it('MAXFIYLIK: matn, telefon va buyurtmalar logga chiqmaydi', async () => {
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
      (m) => jest.spyOn(Logger.prototype, m).mockImplementation(() => {}),
    );
    extractJson.mockResolvedValue(
      okResult({
        orders: Array.from({ length: AI_MAX_ORDERS_PER_PARSE + 1 }, () =>
          rawOrder({
            customer_name: 'Dilnoza Maxfiy',
            address: 'Maxfiy ko‘cha 5',
          }),
        ),
      }),
    );
    await service.extract(
      baseReq({ text: 'Dilnoza Maxfiy 90 123 45 67 Maxfiy ko‘cha 5' }),
    );
    const logged = spies
      .flatMap((s) => s.mock.calls)
      .map((args) => JSON.stringify(args))
      .join('\n');
    expect(logged).not.toContain('Maxfiy');
    expect(logged).not.toContain('901234567');
    expect(logged).not.toContain('90 123 45 67');
  });
});

describe('WHMAIqyo — max_tokens taxmini, bo‘laklash, birlashtirish', () => {
  it('estimateOrderCount: telefon tokenlari / ro‘yxat / bo‘sh qator bloklari; rasm × 3; chegara 30', () => {
    expect(estimateOrderCount('Ali [TEL_1] Asaka', 1, 0)).toBe(1);
    expect(estimateOrderCount('1. a [TEL_1]\n2. b [TEL_2]\n3. c', 2, 0)).toBe(
      3,
    );
    expect(estimateOrderCount('a\n\nb\n\nc\n\nd', 0, 0)).toBe(4);
    expect(estimateOrderCount('', 0, 5)).toBe(15);
    expect(estimateOrderCount('x', 0, 20)).toBe(AI_MAX_ORDERS_PER_PARSE);
  });

  it('orderExtractMaxTokens: 1500 + 600 × N, chegara 16000', () => {
    expect(orderExtractMaxTokens(1)).toBe(2100);
    expect(orderExtractMaxTokens(10)).toBe(7500);
    expect(orderExtractMaxTokens(30)).toBe(16000);
    expect(orderExtractMaxTokens(0)).toBe(2100);
  });

  it('chunkImages: 5 tadan, tartib saqlanadi', () => {
    expect(chunkImages([1, 2, 3, 4, 5, 6, 7], 5)).toEqual([
      [1, 2, 3, 4, 5],
      [6, 7],
    ]);
    expect(chunkImages([], 5)).toEqual([]);
  });

  function build(results: unknown[]) {
    const extractJson = jest.fn();
    for (const r of results) extractJson.mockResolvedValueOnce(r);
    const config = { get: jest.fn(() => undefined) };
    const recordExtraction = jest.fn().mockResolvedValue(undefined);
    const service = new OrderExtractService(
      { extractJson } as unknown as ClaudeService,
      config as unknown as ConfigService,
      { recordExtraction } as unknown as AiDraftService,
    );
    return { service, extractJson, recordExtraction };
  }

  const images = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      media_type: 'image/jpeg' as const,
      data_base64: `IMG${i}`,
    }));

  it('12 rasm → 3 bo‘lak (5/5/2) PARALLEL, matn faqat 1-bo‘lakda', async () => {
    const { service, extractJson } = build([
      okResult({ orders: [rawOrder()] }),
      okResult({ orders: [rawOrder({ phone_number: '+998 91 000 22 33' })] }),
      okResult({ orders: [] }),
    ]);
    const res = await service.extract(
      baseReq({ text: 'Ali 90 123 45 67', images: images(12) }),
    );
    expect(extractJson).toHaveBeenCalledTimes(3);
    const calls = extractJson.mock.calls.map((c) => c[0] as ExtractJsonOptions);
    expect(calls.map((c) => (c.images ?? []).length)).toEqual([5, 5, 2]);
    expect(calls[0].userText).toContain('[TEL_1]');
    expect(calls[1].userText).toBe('');
    expect(calls[2].userText).toBe('');
    expect(calls.every((c) => c.effort === 'low')).toBe(true);
    expect(calls.map((c) => c.maxTokens)).toEqual([
      1500 + 600 * 16,
      1500 + 600 * 15,
      1500 + 600 * 6,
    ]);
    expect(calls.every((c) => c.meta.feature === 'order_extract_image')).toBe(
      true,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.orders).toHaveLength(2);
  });

  it('bo‘laklar orasidagi DUBLIKAT birlashtiriladi (bir telefon, bir tomonda mahsulot yo‘q)', async () => {
    const { service } = build([
      okResult({
        orders: [rawOrder({ items: [], total_price: null, address: 'X 5-uy' })],
      }),
      okResult({ orders: [rawOrder({ phone_number: '90 123 45 67' })] }),
    ]);
    const res = await service.extract(
      baseReq({ text: 'Ali 90 123 45 67', images: images(6) }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.orders).toHaveLength(1);
    expect(res.orders[0]).toMatchObject({
      address: 'X 5-uy',
      total_price: 750000,
      items: [{ name: 'atir', quantity: 3 }],
    });
  });

  it('rasm-faqat bo‘lakda o‘ylab topilgan [TEL_1] matndagi raqamga aylanmaydi', async () => {
    const { service } = build([
      okResult({ orders: [] }),
      okResult({ orders: [rawOrder({ customer_name: 'Vali' })] }),
    ]);
    const res = await service.extract(
      baseReq({ text: 'Ali 90 123 45 67', images: images(6) }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.orders).toHaveLength(1);
    expect(res.orders[0].customer_name).toBe('Vali');
    expect(res.orders[0].phone_number).toBeNull();
  });

  it('bitta bo‘lak yiqilsa — butun parse yiqiladi (yarim natija berilmaydi)', async () => {
    const { service, recordExtraction } = build([
      okResult({ orders: [rawOrder()] }),
      { ok: false, reason: 'network', attempts: 1 },
    ]);
    await expect(
      service.extract(baseReq({ text: '', images: images(7) })),
    ).resolves.toEqual({ ok: false, reason: 'network' });
    expect(recordExtraction.mock.calls[0][0]).toMatchObject({
      outcome: 'network',
      rawExtraction: null,
    });
  });

  it('audit yozuvi KUTILMAYDI (fire-and-forget) — javob recordExtraction tugashini kutmaydi', async () => {
    const { service, recordExtraction } = build([
      okResult({ orders: [rawOrder()] }),
    ]);
    recordExtraction.mockReturnValue(new Promise(() => {}));
    const res = await service.extract(baseReq());
    expect(res.ok).toBe(true);
    expect(recordExtraction).toHaveBeenCalledTimes(1);
  });
});

describe('WHMAIqyo #3 — image_refs (rasm RMQ’da base64 emas)', () => {
  const DRAFT_ID = '0b9f7c3e-1d2a-4b5c-8d6e-7f8091a2b3c4';
  function build(store: unknown) {
    const extractJson = jest
      .fn()
      .mockResolvedValue(okResult({ orders: [rawOrder()] }));
    const config = { get: jest.fn(() => undefined) };
    const service = new OrderExtractService(
      { extractJson } as unknown as ClaudeService,
      config as unknown as ConfigService,
      undefined,
      store as never,
    );
    return { service, extractJson };
  }
  const refs = [
    { key: `ai-tmp/${DRAFT_ID}/0.jpg`, media_type: 'image/jpeg' as const },
    { key: `ai-tmp/${DRAFT_ID}/1.webp`, media_type: 'image/webp' as const },
  ];

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('kalitlar saqlovdan o‘qiladi, Claude’ga rasm bo‘lib ketadi va DARHOL o‘chiriladi', async () => {
    const store = {
      getAll: jest.fn().mockResolvedValue([
        { media_type: 'image/jpeg', data_base64: 'QUJD' },
        { media_type: 'image/webp', data_base64: 'REVG' },
      ]),
      deleteAll: jest.fn().mockResolvedValue(undefined),
    };
    const { service, extractJson } = build(store);
    const res = await service.extract(
      baseReq({ text: '', images: [], image_refs: refs }),
    );
    expect(res.ok).toBe(true);
    expect(store.getAll).toHaveBeenCalledWith(refs);
    expect(store.deleteAll).toHaveBeenCalledWith(refs);
    const opts = extractJson.mock.calls[0][0] as ExtractJsonOptions;
    expect(opts.images).toEqual([
      { mediaType: 'image/jpeg', dataBase64: 'QUJD' },
      { mediaType: 'image/webp', dataBase64: 'REVG' },
    ]);
    expect(opts.meta.feature).toBe('order_extract_image');
  });

  it('begona kalit (boshqa draft / boshqa papka) → ai_error, saqlov O‘QILMAYDI', async () => {
    const store = { getAll: jest.fn(), deleteAll: jest.fn() };
    const { service, extractJson } = build(store);
    await expect(
      service.extract(
        baseReq({
          images: [],
          image_refs: [{ key: 'products/1.jpg', media_type: 'image/jpeg' }],
        }),
      ),
    ).resolves.toEqual({ ok: false, reason: 'ai_error' });
    expect(store.getAll).not.toHaveBeenCalled();
    expect(extractJson).not.toHaveBeenCalled();
  });

  it('saqlov sozlanmagan yoki o‘qib bo‘lmasa → ai_error (Claude chaqirilmaydi)', async () => {
    const none = build(null);
    await expect(
      none.service.extract(baseReq({ images: [], image_refs: refs })),
    ).resolves.toEqual({ ok: false, reason: 'ai_error' });
    const failing = {
      getAll: jest.fn().mockRejectedValue(new Error('NoSuchKey')),
      deleteAll: jest.fn().mockResolvedValue(undefined),
    };
    const broken = build(failing);
    await expect(
      broken.service.extract(baseReq({ images: [], image_refs: refs })),
    ).resolves.toEqual({ ok: false, reason: 'ai_error' });
    expect(failing.deleteAll).toHaveBeenCalledWith(refs);
    expect(broken.extractJson).not.toHaveBeenCalled();
  });
});

describe('OrderExtractService — audit izi (vncdmXOy)', () => {
  const okData = { orders: [rawOrder()] };

  function build(result: unknown) {
    const recordExtraction = jest.fn().mockResolvedValue(undefined);
    const extractJson = jest.fn().mockResolvedValue(result);
    const values: Record<string, unknown> = {
      AI_ORDER_MODEL: 'claude-sonnet-5',
    };
    const service = new OrderExtractService(
      { extractJson } as unknown as ClaudeService,
      { get: (k: string) => values[k] } as unknown as ConfigService,
      { recordExtraction } as unknown as AiDraftService,
    );
    return { service, recordExtraction };
  }

  it('maskalangan matn, model, prompt versiyasi va LLM xom chiqishi (tokenlar bilan) yoziladi', async () => {
    const { service, recordExtraction } = build({
      ok: true,
      data: okData,
      model: 'claude-sonnet-5',
      attempts: 1,
      usage: {},
    });
    const req = baseReq({ text: 'Ali 90 123 45 67 Andijon Asaka 3 ta atir' });
    const res = await service.extract(req);
    expect(res.ok).toBe(true);
    expect(recordExtraction).toHaveBeenCalledTimes(1);
    const arg = recordExtraction.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).toMatchObject({
      draftId: req.draft_id,
      marketId: '121',
      userId: '7',
      model: 'claude-sonnet-5',
      promptVersion: ORDER_EXTRACT_PROMPT_VERSION,
      outcome: 'ok',
      originalText: req.text,
    });
    expect(String(arg.maskedText)).toContain('[TEL_1]');
    expect(String(arg.maskedText)).not.toContain('90 123 45 67');
    expect(JSON.stringify(arg.rawExtraction)).toContain('[TEL_1]');
  });

  it("AI chaqirilmagan ('disabled', attempts 0) → yozilmaydi; xato natija ham yoziladi", async () => {
    const off = build({ ok: false, reason: 'disabled', attempts: 0 });
    await off.service.extract(baseReq());
    expect(off.recordExtraction).not.toHaveBeenCalled();

    const refused = build({ ok: false, reason: 'refused', attempts: 1 });
    await refused.service.extract(baseReq());
    expect(refused.recordExtraction.mock.calls[0][0]).toMatchObject({
      outcome: 'refused',
      rawExtraction: null,
    });
  });
});
