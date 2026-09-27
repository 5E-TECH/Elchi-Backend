/**
 * `rmqSend` spy bilan o'raladi (haqiqiy implementatsiya ishlaydi) —
 * LOGISTICS/IDENTITY chaqiruvlarining opsiyalarini tekshirish uchun.
 */
jest.mock('@app/common', () => {
  const actual =
    jest.requireActual<typeof import('@app/common')>('@app/common');
  return { ...actual, rmqSend: jest.fn(actual.rmqSend) };
});

import { Logger } from '@nestjs/common';
import { RpcException, type ClientProxy } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import {
  rmqSend as rmqSendFn,
  type IdempotencyService,
  type RawOrderExtraction,
} from '@app/common';
import { ProductResolverService } from './product-resolver.service';
import type { ProductDisambiguator } from './product-disambiguator';
import {
  AI_PREVIEW_PATTERN,
  AI_PREVIEW_PRUNE_INTERVAL_MS,
  AI_PREVIEW_RETENTION_MS,
  AiPreviewService,
} from './ai-preview.service';
import {
  AI_ISSUES,
  type AiOrderPreview,
  type AiResolvePreviewRequest,
  type DistrictTextQuery,
  type DistrictTextResolution,
} from './ai-preview.types';

const rmqSend = jest.mocked(rmqSendFn);

/**
 * fPre2MRr — `order.ai_resolve_preview` (checklist 1-9, 11) va
 * HD5zOyBp #10 (preview PII keshini tozalash).
 * DB'siz: CATALOG/LOGISTICS/IDENTITY mijozlari `of(...)` qaytaradi.
 */

const MARKET = '121';

const CATALOG = [
  { id: '11', name: 'Atir sepgich', user_id: MARKET },
  { id: '12', name: 'Blender', user_id: MARKET },
  { id: '13', name: 'Changyutgich', user_id: MARKET },
];

const RESOLVED_ASAKA: DistrictTextResolution = {
  region_id: '2',
  district_id: '20',
  region_label: 'Andijon viloyati',
  district_label: 'Asaka',
  region_name: 'Andijon viloyati',
  district_name: 'Asaka',
  region_given: true,
  candidates: [],
};

const UNRESOLVED: DistrictTextResolution = {
  region_id: null,
  district_id: null,
  region_name: null,
  district_name: null,
  region_given: false,
  candidates: [],
  reason: 'district_not_found',
};

/** Soxta logistics rezolveri: tuman nomiga qarab javob beradi. */
const defaultResolve = (q: DistrictTextQuery): DistrictTextResolution => {
  if (q.district_name === 'Asaka') return RESOLVED_ASAKA;
  if (q.district_name === 'Mirzaobod') {
    return {
      region_id: null,
      district_id: null,
      region_name: null,
      district_name: null,
      region_given: false,
      candidates: [
        {
          id: '31',
          label: 'Sirdaryo viloyati, Mirzaobod',
          region_name: 'Sirdaryo viloyati',
          district_name: 'Mirzaobod',
        },
        {
          id: '41',
          label: 'Toshkent shahri, Mirobod',
          region_name: 'Toshkent shahri',
          district_name: 'Mirobod',
        },
      ],
      reason: 'cross_region_confusable',
    };
  }
  return UNRESOLVED;
};

const raw = (over: Record<string, unknown> = {}): RawOrderExtraction =>
  ({
    customer_name: 'Dilnoza',
    phone_number: '998901234567',
    extra_number: null,
    region_name: 'Andijon',
    district_name: 'Asaka',
    address: "temiryol ko'chasi 12 uy",
    full_address: 'Andijon Asaka temiryol kochasi 12 uy',
    items: [{ name: 'atir sepgich', quantity: 3 }],
    total_price: 750000,
    comment: null,
    where_deliver: 'address',
    is_replacement: false,
    operator: null,
    ...over,
  }) as RawOrderExtraction;

interface SetupOptions {
  resolve?: (q: DistrictTextQuery) => DistrictTextResolution;
  logisticsFails?: boolean;
  identityFails?: boolean;
  tariff?: unknown;
  pick?: ProductDisambiguator['pick'];
  catalog?: Array<Record<string, unknown>>;
}

function setup(opts: SetupOptions = {}) {
  const catalogClient = {
    send: jest.fn(() => of({ data: opts.catalog ?? CATALOG, total: 3 })),
  };
  const logisticsClient = {
    send: jest.fn((_p: unknown, payload: { items: DistrictTextQuery[] }) =>
      opts.logisticsFails
        ? throwError(() => new RpcException('logistics down'))
        : of({
            statusCode: 200,
            message: 'success',
            data: payload.items.map(opts.resolve ?? defaultResolve),
          }),
    ),
  };
  const identityClient = {
    send: jest.fn(() =>
      opts.identityFails
        ? throwError(() => new RpcException('identity down'))
        : of({
            statusCode: 200,
            message: 'success',
            data: {
              id: MARKET,
              default_tariff: 'tariff' in opts ? opts.tariff : 'center',
            },
          }),
    ),
  };
  const disambiguator = {
    pick: jest.fn(opts.pick ?? (() => Promise.resolve(null))),
  };
  const idempotency = { prunePattern: jest.fn().mockResolvedValue(0) };
  const resolver = new ProductResolverService(
    catalogClient as unknown as ClientProxy,
    disambiguator,
  );
  const svc = new AiPreviewService(
    resolver,
    logisticsClient as unknown as ClientProxy,
    identityClient as unknown as ClientProxy,
    idempotency as unknown as IdempotencyService,
  );
  return {
    svc,
    catalogClient,
    logisticsClient,
    identityClient,
    disambiguator,
    idempotency,
  };
}

const request = (
  raw_orders: unknown,
  over: Partial<AiResolvePreviewRequest> = {},
): AiResolvePreviewRequest => ({
  raw_orders: raw_orders as AiResolvePreviewRequest['raw_orders'],
  market_id: MARKET,
  requester: { id: '7', roles: ['market'] },
  request_id: 'req-1',
  trace_id: 'trace-1',
  draft_id: 'draft-1',
  deadline_at: Date.now() + 25_000,
  ...over,
});

const one = async (
  svc: AiPreviewService,
  order: RawOrderExtraction,
): Promise<AiOrderPreview> => {
  const { previews } = await svc.resolve(request([order]));
  expect(previews).toHaveLength(1);
  return previews[0];
};

const PREVIEW_KEYS = [
  'address',
  'comment',
  'customer_name',
  'district_candidates',
  'district_id',
  'district_name',
  'extra_number',
  'index',
  'is_replacement',
  'issues',
  'items',
  'operator',
  'phone_number',
  'price_confirmed',
  'ready',
  'region_given',
  'region_id',
  'region_name',
  'total_price',
  'where_deliver',
];

let warn: jest.SpyInstance;

beforeEach(() => {
  rmqSend.mockClear();
  warn = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

describe('AiPreviewService.resolve (fPre2MRr)', () => {
  it("to'liq buyurtma — yassi shakl, ready=true, issues bo'sh", async () => {
    const { svc } = setup();
    const p = await one(svc, raw());
    expect(p).toEqual({
      index: 0,
      ready: true,
      issues: [],
      customer_name: 'Dilnoza',
      phone_number: '+998901234567',
      extra_number: null,
      region_id: '2',
      region_name: 'Andijon viloyati',
      region_given: true,
      district_id: '20',
      district_name: 'Asaka',
      district_candidates: [],
      address: "temiryol ko'chasi 12 uy",
      items: [
        {
          name: 'atir sepgich',
          quantity: 3,
          product_id: '11',
          resolved_name: 'Atir sepgich',
          candidates: [],
          unresolved: false,
        },
      ],
      total_price: 750000,
      price_confirmed: false,
      where_deliver: 'address',
      comment: null,
      is_replacement: false,
      operator: null,
    });
    expect(Object.keys(p).sort()).toEqual(PREVIEW_KEYS);
  });

  describe("#1 batching — sikl ichida RPC yo'q", () => {
    it('10 buyurtmada CATALOG 1, LOGISTICS <= 2 (bitta batch), IDENTITY 1', async () => {
      const { svc, catalogClient, logisticsClient, identityClient } = setup();
      const orders = Array.from({ length: 10 }, (_, i) =>
        raw({
          customer_name: `Mijoz ${i}`,
          district_name: i % 2 ? 'Asaka' : 'Nomalum',
        }),
      );
      const { previews } = await svc.resolve(request(orders));

      expect(previews).toHaveLength(10);
      expect(previews.map((p) => p.index)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
      ]);
      expect(catalogClient.send).toHaveBeenCalledTimes(1);
      expect(logisticsClient.send.mock.calls.length).toBeLessThanOrEqual(2);
      expect(logisticsClient.send).toHaveBeenCalledTimes(1);
      expect(identityClient.send).toHaveBeenCalledTimes(1);

      const [pattern, payload] = logisticsClient.send.mock.calls[0];
      expect(pattern).toEqual({ cmd: 'logistics.district.resolve_by_text' });
      expect(payload.items).toHaveLength(10);
      expect(payload.items[1]).toEqual({
        region_name: 'Andijon',
        district_name: 'Asaka',
        address: "temiryol ko'chasi 12 uy",
        full_address: 'Andijon Asaka temiryol kochasi 12 uy',
      });
    });

    it('RPC opsiyalari: logistics 6s/retries 1, identity 3s/retries 0, request_id biriktirilmaydi', async () => {
      const { svc, logisticsClient, identityClient } = setup();
      await svc.resolve(request([raw()]));
      expect(rmqSend).toHaveBeenCalledWith(
        logisticsClient,
        { cmd: 'logistics.district.resolve_by_text' },
        expect.objectContaining({ items: expect.any(Array) as unknown }),
        { timeoutMs: 6000, retries: 1, attachRequestId: false },
      );
      expect(rmqSend).toHaveBeenCalledWith(
        identityClient,
        { cmd: 'identity.user.find_by_id' },
        { id: MARKET },
        { timeoutMs: 3000, retries: 0, attachRequestId: false },
      );
      // attachRequestId:false — payload aynan o'zi (request_id qo'shilmagan)
      expect(identityClient.send).toHaveBeenCalledWith(
        { cmd: 'identity.user.find_by_id' },
        { id: MARKET },
      );
    });

    it('noaniq mahsulotlar bir nechta buyurtmada — LLM BITTA chaqiruv', async () => {
      const { svc, disambiguator } = setup({
        pick: () =>
          Promise.resolve({
            picks: [
              { item_index: 0, choice: 1 },
              { item_index: 1, choice: 2 },
            ],
          }),
        catalog: [
          { id: '11', name: 'Atir sepgich', user_id: MARKET },
          { id: '12', name: 'Blender', user_id: MARKET },
          { id: '14', name: 'Atir', user_id: MARKET },
        ],
      });
      const { previews } = await svc.resolve(
        request([
          raw({ items: [{ name: 'atir sepgch', quantity: 1 }] }),
          raw({ items: [{ name: 'blender mini', quantity: 1 }] }),
        ]),
      );
      expect(disambiguator.pick).toHaveBeenCalledTimes(1);
      expect(previews[0].items[0].product_id).toBe('11');
      expect(previews[1].items[0].product_id).toBe('12');
    });
  });

  describe("#2 tuman hal bo'lmasa — ready=false, issues KALIT bilan", () => {
    it("'district_missing' (matn emas)", async () => {
      const { svc } = setup();
      const p = await one(svc, raw({ district_name: 'Nomalum joy' }));
      expect(p.ready).toBe(false);
      expect(p.district_id).toBeNull();
      expect(p.issues).toContain('district_missing');
      expect(p.issues).toContain('region_missing');
      for (const issue of p.issues) {
        expect(AI_ISSUES).toContain(issue);
      }
    });

    it('logistics yiqilsa ham preview qaytadi — hamma tuman aniqlanmagan', async () => {
      const { svc } = setup({ logisticsFails: true });
      const { previews } = await svc.resolve(request([raw(), raw()]));
      expect(previews).toHaveLength(2);
      for (const p of previews) {
        expect(p.district_id).toBeNull();
        expect(p.region_id).toBeNull();
        expect(p.issues).toContain('district_missing');
      }
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('tumanlar aniqlanmadi'),
      );
    });

    it("logistics javobi qisqa bo'lsa yetishmagan buyurtma aniqlanmagan", async () => {
      const { svc, logisticsClient } = setup();
      logisticsClient.send.mockImplementation(() =>
        of({ statusCode: 200, message: 'success', data: [RESOLVED_ASAKA] }),
      );
      const { previews } = await svc.resolve(request([raw(), raw()]));
      expect(previews[0].district_id).toBe('20');
      expect(previews[1].district_id).toBeNull();
    });
  });

  describe("#3 district_candidates bo'lsa district_id null (jimgina tanlash yo'q)", () => {
    it('nomzodlar yassi {id,label,region_name}', async () => {
      const { svc } = setup();
      const p = await one(svc, raw({ district_name: 'Mirzaobod' }));
      expect(p.district_id).toBeNull();
      expect(p.district_name).toBeNull();
      expect(p.district_candidates).toEqual([
        {
          id: '31',
          label: 'Sirdaryo viloyati, Mirzaobod',
          region_name: 'Sirdaryo viloyati',
        },
        {
          id: '41',
          label: 'Toshkent shahri, Mirobod',
          region_name: 'Toshkent shahri',
        },
      ]);
      expect(p.issues).toContain('district_missing');
    });

    it('logistics district_id VA nomzod qaytarsa ham district_id null (invariant)', async () => {
      const { svc } = setup({
        resolve: () => ({
          ...RESOLVED_ASAKA,
          candidates: [
            {
              id: '21',
              label: 'Andijon viloyati, Asaka shahri',
              region_name: 'Andijon viloyati',
            },
          ],
        }),
      });
      const p = await one(svc, raw());
      expect(p.district_id).toBeNull();
      expect(p.district_candidates).toHaveLength(1);
      // viloyat rezolyutsiyadan keladi
      expect(p.region_id).toBe('2');
      expect(p.region_name).toBe('Andijon viloyati');
    });
  });

  describe('#4 telefon normalizeUzPhone orqali', () => {
    it.each([
      ['90 123 45 67', '+998901234567'],
      ['+998 (90) 123-45-67', '+998901234567'],
      ['0901234567', '+998901234567'],
    ])('%p → %p', async (input, expected) => {
      const { svc } = setup();
      const p = await one(svc, raw({ phone_number: input }));
      expect(p.phone_number).toBe(expected);
      expect(p.issues).not.toContain('phone_invalid');
    });

    it("normallashmasa — xom matn (trim) + phone_invalid, raqam to'ldirilmaydi", async () => {
      const { svc } = setup();
      const p = await one(svc, raw({ phone_number: '  90123456 ' }));
      expect(p.phone_number).toBe('90123456');
      expect(p.issues).toContain('phone_invalid');
      expect(p.ready).toBe(false);
    });

    it("telefon umuman yo'q — '' + phone_invalid, ready=false", async () => {
      const { svc } = setup();
      const p = await one(svc, raw({ phone_number: null, extra_number: null }));
      expect(p.phone_number).toBe('');
      expect(p.issues).toContain('phone_invalid');
      expect(p.ready).toBe(false);
    });
  });

  describe('#5 ikkinchi raqam extra_number — bloklamaydi', () => {
    it('ikkala raqam valid — ready=true, extra normallashgan', async () => {
      const { svc } = setup();
      const p = await one(svc, raw({ extra_number: '93 111 22 33' }));
      expect(p.phone_number).toBe('+998901234567');
      expect(p.extra_number).toBe('+998931112233');
      expect(p.ready).toBe(true);
    });

    it("asosiy bo'sh — extra asosiyga o'tadi, extra_number null", async () => {
      const { svc } = setup();
      const p = await one(
        svc,
        raw({ phone_number: null, extra_number: '93 111 22 33' }),
      );
      expect(p.phone_number).toBe('+998931112233');
      expect(p.extra_number).toBeNull();
      expect(p.issues).not.toContain('phone_invalid');
      expect(p.ready).toBe(true);
    });

    it("noto'g'ri extra — null, buyurtma bloklanmaydi", async () => {
      const { svc } = setup();
      const p = await one(svc, raw({ extra_number: '123' }));
      expect(p.extra_number).toBeNull();
      expect(p.ready).toBe(true);
    });
  });

  describe('#6 narx null/0 — ready=false, price_confirmed=false', () => {
    it.each([
      ['null', null, null, 'price_missing'],
      ['manfiy', -5000, null, 'price_missing'],
      ['son emas', 'abc', null, 'price_missing'],
      ['0', 0, 0, 'price_confirm'],
      ['10 000 dan kichik', 5000, 5000, 'price_confirm'],
    ])('%s → total_price %p, %s', async (_n, input, expected, issue) => {
      const { svc } = setup();
      const p = await one(svc, raw({ total_price: input }));
      expect(p.total_price).toBe(expected);
      expect(p.issues).toContain(issue);
      expect(p.ready).toBe(false);
      expect(p.price_confirmed).toBe(false);
    });

    it('musbat narx yaxlitlanadi', async () => {
      const { svc } = setup();
      const p = await one(svc, raw({ total_price: 750000.6 }));
      expect(p.total_price).toBe(750001);
      expect(p.issues).toEqual([]);
    });
  });

  describe("#7 katalogda yo'q item — unresolved, product_name YO'Q", () => {
    it('item_unresolved kaliti, product_name avtomatik yozilmaydi', async () => {
      const { svc } = setup();
      const p = await one(
        svc,
        raw({ items: [{ name: 'kir yuvish mashinasi', quantity: 1 }] }),
      );
      expect(p.items).toEqual([
        {
          name: 'kir yuvish mashinasi',
          quantity: 1,
          product_id: null,
          resolved_name: null,
          candidates: [],
          unresolved: true,
        },
      ]);
      expect(p.items[0]).not.toHaveProperty('product_name');
      expect(p.items[0]).not.toHaveProperty('allow_free_text');
      expect(p.issues).toContain('item_unresolved');
      expect(p.ready).toBe(false);
    });

    it("mahsulot umuman yo'q — items [] va items_missing", async () => {
      const { svc } = setup();
      const p = await one(svc, raw({ items: [{ name: ' ', quantity: 1 }] }));
      expect(p.items).toEqual([]);
      expect(p.issues).toContain('items_missing');
    });
  });

  describe("#8 operator faqat matn — operator_id YO'Q", () => {
    it.each([
      ['#sevinch', 'sevinch'],
      ['##ali ', 'ali'],
      ['#', null],
      [null, null],
    ])('%p → %p', async (input, expected) => {
      const { svc } = setup();
      const p = await one(svc, raw({ operator: input }));
      expect(p.operator).toBe(expected);
    });

    it('xom obyektdagi begona kalitlar javobga tushmaydi (whitelist)', async () => {
      const { svc } = setup();
      const p = await one(
        svc,
        raw({
          operator: '#sevinch',
          operator_id: '999',
          parent_order_id: '555',
          product_name: 'soxta',
          allow_free_text: true,
          score: 0.99,
          district_id: '7777',
          region_id: '8888',
          status: 'sold',
          items: [
            {
              name: 'atir sepgich',
              quantity: 1,
              product_id: '999',
              product_name: 'x',
              score: 1,
            },
          ],
        }),
      );
      expect(Object.keys(p).sort()).toEqual(PREVIEW_KEYS);
      expect(Object.keys(p.items[0]).sort()).toEqual([
        'candidates',
        'name',
        'product_id',
        'quantity',
        'resolved_name',
        'unresolved',
      ]);
      const json = JSON.stringify(p);
      for (const banned of [
        'operator_id',
        'parent_order_id',
        'product_name',
        'allow_free_text',
        'score',
        '7777',
        '8888',
        'sold',
      ]) {
        expect(json).not.toContain(banned);
      }
      // region/district faqat logistics rezolyutsiyasidan
      expect(p.district_id).toBe('20');
      expect(p.region_id).toBe('2');
      // product_id faqat katalogdan (AI bergan '999' emas)
      expect(p.items[0].product_id).toBe('11');
    });
  });

  describe("#9 is_replacement — comment belgisi, parent_order_id yo'q", () => {
    it("izohga '[ALMASHTIRISH] ' qo'shiladi", async () => {
      const { svc } = setup();
      const p = await one(
        svc,
        raw({ is_replacement: true, comment: ' eski buyurtma ' }),
      );
      expect(p.comment).toBe('[ALMASHTIRISH] eski buyurtma');
      expect(p.is_replacement).toBe(true);
      expect(p).not.toHaveProperty('parent_order_id');
    });

    it("izoh bo'lmasa ham belgi qo'yiladi", async () => {
      const { svc } = setup();
      const p = await one(svc, raw({ is_replacement: true, comment: null }));
      expect(p.comment).toBe('[ALMASHTIRISH]');
    });

    it("almashtirish bo'lmasa izoh o'zgarmaydi", async () => {
      const { svc } = setup();
      const p = await one(svc, raw({ comment: '  tezroq ' }));
      expect(p.comment).toBe('tezroq');
      expect(p.is_replacement).toBe(false);
    });
  });

  describe("#11 bo'sh raw_orders — bo'sh previews, RPC 0", () => {
    it.each([
      ["bo'sh massiv", []],
      ["yo'q (undefined)", undefined],
      ['null', null],
      ['massiv emas', { orders: [] }],
      [
        "hammasi axlat (telefon ham, mahsulot ham yo'q)",
        [raw({ phone_number: null, extra_number: '12', items: [] })],
      ],
    ])('%s', async (_name, input) => {
      const { svc, catalogClient, logisticsClient, identityClient } = setup();
      await expect(svc.resolve(request(input))).resolves.toEqual({
        previews: [],
      });
      expect(catalogClient.send).not.toHaveBeenCalled();
      expect(logisticsClient.send).not.toHaveBeenCalled();
      expect(identityClient.send).not.toHaveBeenCalled();
    });

    it('axlat element tashlanadi, qolganlari indekslanadi', async () => {
      const { svc } = setup();
      const { previews } = await svc.resolve(
        request([
          raw({ phone_number: null, items: [] }),
          raw({ customer_name: 'Aziz' }),
        ]),
      );
      expect(previews).toHaveLength(1);
      expect(previews[0].index).toBe(0);
      expect(previews[0].customer_name).toBe('Aziz');
    });
  });

  describe('where_deliver — AI qiymati, aks holda market default_tariff, aks holda center', () => {
    it.each([
      ["AI 'center' (tarif address)", 'center', 'address', 'center'],
      ["AI null → tarif 'address'", null, 'address', 'address'],
      ["AI noto'g'ri qiymat → tarif", 'free', 'address', 'address'],
      ['AI null, tarif null → center', null, null, 'center'],
      ["AI null, tarif noto'g'ri → center", null, 'pickup', 'center'],
    ])('%s', async (_n, aiValue, tariff, expected) => {
      const { svc } = setup({ tariff });
      const p = await one(svc, raw({ where_deliver: aiValue }));
      expect(p.where_deliver).toBe(expected);
    });

    it("identity yiqilsa — center, oqim to'xtamaydi", async () => {
      const { svc } = setup({ identityFails: true });
      const p = await one(svc, raw({ where_deliver: null }));
      expect(p.where_deliver).toBe('center');
    });
  });

  it("ism yo'q — '' va name_missing (\"Mijoz\" default yo'q)", async () => {
    const { svc } = setup();
    const p = await one(svc, raw({ customer_name: '   ' }));
    expect(p.customer_name).toBe('');
    expect(p.issues).toContain('name_missing');
  });

  describe('HD5zOyBp #10 — preview PII keshi tozalanadi (1 soat, 10 daqiqada bir)', () => {
    it('birinchi resolve prunePattern chaqiradi, 10 daqiqa ichida qayta emas', async () => {
      let now = 1_800_000_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        const { svc, idempotency } = setup();

        await svc.resolve(request([raw()], { deadline_at: now + 25_000 }));
        expect(idempotency.prunePattern).toHaveBeenCalledTimes(1);
        expect(idempotency.prunePattern).toHaveBeenCalledWith(
          AI_PREVIEW_PATTERN,
          AI_PREVIEW_RETENTION_MS,
        );
        expect(AI_PREVIEW_PATTERN).toBe('order.ai_resolve_preview');
        expect(AI_PREVIEW_RETENTION_MS).toBe(3_600_000);
        expect(AI_PREVIEW_PRUNE_INTERVAL_MS).toBe(600_000);

        now += AI_PREVIEW_PRUNE_INTERVAL_MS - 1;
        await svc.resolve(request([], { deadline_at: now + 25_000 }));
        expect(idempotency.prunePattern).toHaveBeenCalledTimes(1);

        now += 2;
        await svc.resolve(request([], { deadline_at: now + 25_000 }));
        expect(idempotency.prunePattern).toHaveBeenCalledTimes(2);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('tozalash xatosi javobni buzmaydi — faqat WARN', async () => {
      const { svc, idempotency } = setup();
      idempotency.prunePattern.mockRejectedValueOnce(new Error('db down'));
      const { previews } = await svc.resolve(request([raw()]));
      expect(previews).toHaveLength(1);
      await new Promise((r) => setImmediate(r));
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('kesh tozalash xato'),
      );
    });

    /**
     * Tozalash faqat `resolve` ga bog'liq bo'lsa, AI trafigi to'xtaganda
     * (kill switch, kunlik limit, funksiya ishlatilmasa) 1 soatdan eski PII
     * qatorlari muddatsiz qolardi — boot + 10 daqiqalik taymer shuni yopadi.
     */
    describe("AI trafigi bo'lmasa ham — boot'da va har 10 daqiqada taymer", () => {
      let active: AiPreviewService | null = null;

      afterEach(() => {
        active?.onModuleDestroy();
        active = null;
        jest.useRealTimers();
      });

      it("boot'da darhol, keyin har 10 daqiqada prunePattern (resolve'siz); taymer unref; destroy to'xtatadi", async () => {
        jest.useFakeTimers();
        const setIntervalSpy = jest.spyOn(global, 'setInterval');
        try {
          const { svc, idempotency, catalogClient, logisticsClient } = setup();
          active = svc;

          svc.onModuleInit();
          expect(idempotency.prunePattern).toHaveBeenCalledTimes(1);
          expect(idempotency.prunePattern).toHaveBeenLastCalledWith(
            AI_PREVIEW_PATTERN,
            AI_PREVIEW_RETENTION_MS,
          );
          expect(setIntervalSpy).toHaveBeenCalledWith(
            expect.any(Function),
            AI_PREVIEW_PRUNE_INTERVAL_MS,
          );
          // unref — taymer jarayonni tirik ushlab turmaydi.
          const timer = (svc as unknown as { pruneTimer: NodeJS.Timeout })
            .pruneTimer;
          expect(timer.hasRef()).toBe(false);

          await jest.advanceTimersByTimeAsync(AI_PREVIEW_PRUNE_INTERVAL_MS - 1);
          expect(idempotency.prunePattern).toHaveBeenCalledTimes(1);
          await jest.advanceTimersByTimeAsync(1);
          expect(idempotency.prunePattern).toHaveBeenCalledTimes(2);
          // Yana 1 soat (6 tik) — hech qanday AI so'rovisiz.
          await jest.advanceTimersByTimeAsync(AI_PREVIEW_PRUNE_INTERVAL_MS * 6);
          expect(idempotency.prunePattern).toHaveBeenCalledTimes(8);
          for (const call of idempotency.prunePattern.mock.calls) {
            expect(call).toEqual([AI_PREVIEW_PATTERN, AI_PREVIEW_RETENTION_MS]);
          }
          expect(catalogClient.send).not.toHaveBeenCalled();
          expect(logisticsClient.send).not.toHaveBeenCalled();

          // Ikkinchi onModuleInit ikkinchi taymer yaratmaydi.
          svc.onModuleInit();
          expect(
            setIntervalSpy.mock.calls.filter(
              ([, ms]) => ms === AI_PREVIEW_PRUNE_INTERVAL_MS,
            ),
          ).toHaveLength(1);
          expect(idempotency.prunePattern).toHaveBeenCalledTimes(8);

          svc.onModuleDestroy();
          await jest.advanceTimersByTimeAsync(AI_PREVIEW_PRUNE_INTERVAL_MS * 3);
          expect(idempotency.prunePattern).toHaveBeenCalledTimes(8);
        } finally {
          setIntervalSpy.mockRestore();
        }
      });

      it('taymer tozalash xatosi (async yoki sinxron) faqat WARN — boot yiqilmaydi, keyingi tik yana tozalaydi', async () => {
        jest.useFakeTimers();
        const { svc, idempotency } = setup();
        active = svc;
        idempotency.prunePattern
          .mockImplementationOnce(() => {
            throw new Error('sync boom');
          })
          .mockRejectedValueOnce(new Error('db down'));

        expect(() => svc.onModuleInit()).not.toThrow();
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('kesh tozalash xato: sync boom'),
        );

        await jest.advanceTimersByTimeAsync(AI_PREVIEW_PRUNE_INTERVAL_MS);
        expect(idempotency.prunePattern).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('kesh tozalash xato: db down'),
        );

        await jest.advanceTimersByTimeAsync(AI_PREVIEW_PRUNE_INTERVAL_MS);
        expect(idempotency.prunePattern).toHaveBeenCalledTimes(3);
      });

      it('taymer tozalagach 10 daqiqa ichida resolve qayta tozalamaydi (throttle umumiy)', async () => {
        jest.useFakeTimers();
        const { svc, idempotency } = setup();
        active = svc;

        svc.onModuleInit();
        expect(idempotency.prunePattern).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(AI_PREVIEW_PRUNE_INTERVAL_MS / 2);
        await svc.resolve(request([], { deadline_at: Date.now() + 25_000 }));
        expect(idempotency.prunePattern).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(AI_PREVIEW_PRUNE_INTERVAL_MS / 2);
        expect(idempotency.prunePattern).toHaveBeenCalledTimes(2);
        await svc.resolve(request([], { deadline_at: Date.now() + 25_000 }));
        expect(idempotency.prunePattern).toHaveBeenCalledTimes(2);
      });
    });
  });
});
