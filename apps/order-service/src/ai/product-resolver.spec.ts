/**
 * `rmqSend` — modul funksiyasi. Haqiqiy implementatsiya ishlaydi (ClientProxy
 * mock'i `of(...)` qaytaradi), lekin chaqiruv opsiyalarini (timeout, retries,
 * attachRequestId) tekshirish uchun spy bilan o'raladi.
 */
jest.mock('@app/common', () => {
  const actual =
    jest.requireActual<typeof import('@app/common')>('@app/common');
  return { ...actual, rmqSend: jest.fn(actual.rmqSend) };
});

import { Logger } from '@nestjs/common';
import type { ClientProxy } from '@nestjs/microservices';
import { of } from 'rxjs';
import { rmqSend as rmqSendFn } from '@app/common';
import {
  CATALOG_LOAD_LIMIT,
  ProductResolverService,
  rankProducts,
  sameDigitTokens,
  shouldAutoPick,
  type CatalogProduct,
  type ProductResolveContext,
} from './product-resolver.service';
import type {
  ProductDisambiguationPicks,
  ProductDisambiguator,
} from './product-disambiguator';

const rmqSend = jest.mocked(rmqSendFn);

/**
 * luv25zlI — AI buyurtma: mahsulot rezolyutsiyasi (checklist 1-12).
 * DB'siz, RMQ'siz: CATALOG mijozi `of(...)` qaytaradi, LLM porti spy.
 */

const MARKET = '121';
const OTHER_MARKET = '3';

const prod = (
  id: string,
  name: string,
  user_id: string = MARKET,
): CatalogProduct => ({ id, name, user_id });

const ctx = (): ProductResolveContext => ({
  requester: { id: '7', roles: ['market'] },
  trace_id: 'trace-1',
  draft_id: 'draft-1',
  deadline_at: Date.now() + 60_000,
});

type PickFn = ProductDisambiguator['pick'];

function setup(
  rows: Array<Record<string, unknown>> = [],
  pick: PickFn = () => Promise.resolve(null),
  total?: number,
) {
  const catalogClient = {
    send: jest.fn(() =>
      of({ data: rows, total: total ?? rows.length, page: 1, limit: 500 }),
    ),
  };
  const disambiguator = { pick: jest.fn(pick) };
  const svc = new ProductResolverService(
    catalogClient as unknown as ClientProxy,
    disambiguator,
  );
  return { svc, catalogClient, disambiguator };
}

const picks = (
  list: Array<{ item_index: unknown; choice: unknown }>,
): PickFn => {
  return () =>
    Promise.resolve({ picks: list } as unknown as ProductDisambiguationPicks);
};

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

describe('ProductResolverService (luv25zlI)', () => {
  describe('#1 aniq teng nom avto-tanlanadi', () => {
    it("product_id to'ladi, candidates bo'sh, unresolved=false", () => {
      const { svc } = setup();
      const [item] = svc.resolveItems(
        [{ name: 'Blender', quantity: 1 }],
        [prod('1', 'blender'), prod('2', 'changyutgich')],
        MARKET,
      );
      expect(item).toEqual({
        ai_name: 'Blender',
        quantity: 1,
        product_id: '1',
        resolved_name: 'blender',
        candidates: [],
        unresolved: false,
      });
    });

    it('kirillcha yozuv ham translit orqali aniq teng', () => {
      const { svc } = setup();
      const [item] = svc.resolveItems(
        [{ name: 'Блендер', quantity: 2 }],
        [prod('1', 'Blender'), prod('2', 'Dazmol')],
        MARKET,
      );
      expect(item.product_id).toBe('1');
      expect(item.unresolved).toBe(false);
    });

    it('bir xil skeletli ikki mahsulot (1 va 1) — avto-tanlanmaydi', () => {
      expect(shouldAutoPick([{ score: 1 }, { score: 1 }])).toBe(false);
      expect(shouldAutoPick([{ score: 1 }, { score: 0.99 }])).toBe(true);
      expect(shouldAutoPick([{ score: 1 }])).toBe(true);
    });
  });

  describe('#2 substring (0.8) avto-TANLANMAYDI', () => {
    it("'quloqchin' ↔ 'simsiz quloqchin' — nomzod, lekin product_id yo'q", () => {
      const catalog = [prod('5', 'simsiz quloqchin')];
      expect(rankProducts('quloqchin', catalog)).toEqual([
        { product: catalog[0], score: 0.8 },
      ]);
      const { svc } = setup();
      const [item] = svc.resolveItems(
        [{ name: 'quloqchin', quantity: 1 }],
        catalog,
        MARKET,
      );
      expect(item.product_id).toBeNull();
      expect(item.unresolved).toBe(true);
      expect(item.candidates).toEqual([{ id: '5', name: 'simsiz quloqchin' }]);
    });

    it('yagona substring nomzodi ham avto emas (0.8 < 0.85)', () => {
      expect(shouldAutoPick([{ score: 0.8 }])).toBe(false);
    });
  });

  describe('#3 >=0.85 va farq >=0.2 — avto; farq 0.1 — nomzod', () => {
    it('qoidaning chegaralari', () => {
      expect(shouldAutoPick([{ score: 0.9 }, { score: 0.7 }])).toBe(true);
      expect(shouldAutoPick([{ score: 0.9 }, { score: 0.8 }])).toBe(false);
      expect(shouldAutoPick([{ score: 0.95 }, { score: 0.85 }])).toBe(false);
      // suzuvchi nuqta: 0.85 - 0.65 = 0.19999999999999996
      expect(shouldAutoPick([{ score: 0.85 }, { score: 0.65 }])).toBe(true);
      expect(shouldAutoPick([{ score: 0.84 }])).toBe(false);
      expect(shouldAutoPick([])).toBe(false);
    });

    it("imlo xatosi 'televizr' → 'televizor' (0.89, ikkinchisi 0.5) avto-tanlanadi", () => {
      const { svc } = setup();
      const [item] = svc.resolveItems(
        [{ name: 'televizr', quantity: 1 }],
        [prod('1', 'Televizor'), prod('2', 'Telefon')],
        MARKET,
      );
      expect(item.product_id).toBe('1');
      expect(item.resolved_name).toBe('Televizor');
    });

    it("'atir sepgch' → 'atir sepgich' 0.93 vs 'atir' 0.8 (farq ~0.13) — nomzod qoladi", () => {
      const catalog = [prod('1', 'Atir sepgich'), prod('2', 'Atir')];
      const ranked = rankProducts('atir sepgch', catalog);
      expect(ranked.map((r) => r.product.id)).toEqual(['1', '2']);
      expect(ranked[0].score).toBeGreaterThanOrEqual(0.85);
      expect(ranked[0].score - ranked[1].score).toBeLessThan(0.2);

      const { svc } = setup();
      const [item] = svc.resolveItems(
        [{ name: 'atir sepgch', quantity: 1 }],
        catalog,
        MARKET,
      );
      expect(item.product_id).toBeNull();
      expect(item.candidates.map((c) => c.id)).toEqual(['1', '2']);
    });
  });

  describe("#4 raqam qat'iyligi — '700 gr' hech qachon '500 gr' emas", () => {
    it('avto-tanlanmaydi va digit token tekshiruvi farqni ushlaydi', () => {
      const { svc } = setup();
      const [item] = svc.resolveItems(
        [{ name: 'quloqchin 700 gr', quantity: 1 }],
        [prod('1', 'quloqchin 500 gr')],
        MARKET,
      );
      expect(item.product_id).toBeNull();
      expect(item.unresolved).toBe(true);
      expect(sameDigitTokens('quloqchin 700 gr', 'quloqchin 500 gr')).toBe(
        false,
      );
      expect(sameDigitTokens('Atir 50ml', 'atir 050 ml')).toBe(true);
    });

    it("LLM '500 gr' ni tanlasa ham RAD etiladi", async () => {
      const catalog = [
        prod('1', 'quloqchin 500 gr'),
        prod('2', 'quloqchin 300 gr'),
        prod('3', 'blender'),
      ];
      const { svc } = setup([], picks([{ item_index: 0, choice: 1 }]));
      const [[item]] = await svc.resolveOrders(
        MARKET,
        [{ items: [{ name: 'quloqchin 700 gr', quantity: 1 }] }],
        ctx(),
        catalog,
      );
      expect(item.product_id).toBeNull();
      expect(item.unresolved).toBe(true);
    });
  });

  describe("#5 katalog partiyaga BIR MARTA yuklanadi (N+1 yo'q)", () => {
    it('5 itemli buyurtmada CATALOG RPC 1 marta, payload AYNAN {query:{user_id, limit:500}}', async () => {
      const { svc, catalogClient } = setup([
        { id: '1', name: 'Blender', user_id: MARKET },
        { id: '2', name: 'Dazmol', user_id: MARKET },
      ]);
      const res = await svc.resolveOrders(
        MARKET,
        [
          {
            items: [
              { name: 'blender', quantity: 1 },
              { name: 'dazmol', quantity: 1 },
              { name: 'televizor', quantity: 1 },
              { name: 'qozon', quantity: 1 },
              { name: 'atir', quantity: 1 },
            ],
          },
        ],
        ctx(),
      );
      expect(res[0]).toHaveLength(5);
      expect(catalogClient.send).toHaveBeenCalledTimes(1);
      expect(catalogClient.send).toHaveBeenCalledWith(
        { cmd: 'catalog.product.find_all' },
        { query: { user_id: MARKET, limit: CATALOG_LOAD_LIMIT } },
      );
      expect(CATALOG_LOAD_LIMIT).toBe(500);
      expect(rmqSend).toHaveBeenCalledWith(
        catalogClient,
        { cmd: 'catalog.product.find_all' },
        { query: { user_id: MARKET, limit: 500 } },
        { timeoutMs: 6000, retries: 1, attachRequestId: false },
      );
    });

    it('bir nechta buyurtmada ham CATALOG 1 marta', async () => {
      const { svc, catalogClient } = setup([
        { id: '1', name: 'Blender', user_id: MARKET },
      ]);
      await svc.resolveOrders(
        MARKET,
        [
          { items: [{ name: 'blender', quantity: 1 }] },
          { items: [{ name: 'blender', quantity: 2 }] },
          { items: [{ name: 'blender', quantity: 3 }] },
        ],
        ctx(),
      );
      expect(catalogClient.send).toHaveBeenCalledTimes(1);
    });

    it("oldindan yuklangan katalog berilsa RPC umuman yo'q", async () => {
      const { svc, catalogClient } = setup();
      await svc.resolveOrders(
        MARKET,
        [{ items: [{ name: 'blender', quantity: 1 }] }],
        ctx(),
        [prod('1', 'Blender')],
      );
      expect(catalogClient.send).not.toHaveBeenCalled();
    });
  });

  describe("#6 ambiguity yo'q bo'lsa LLM UMUMAN chaqirilmaydi (spy: 0)", () => {
    it('hamma item aniq teng — pick 0 marta', async () => {
      const { svc, disambiguator } = setup([
        { id: '1', name: 'Blender', user_id: MARKET },
        { id: '2', name: 'Dazmol', user_id: MARKET },
        { id: '3', name: 'Qozon', user_id: MARKET },
      ]);
      const [items] = await svc.resolveOrders(
        MARKET,
        [
          {
            items: [
              { name: 'blender', quantity: 1 },
              { name: 'dazmol', quantity: 1 },
            ],
          },
        ],
        ctx(),
      );
      expect(items.every((i) => !i.unresolved)).toBe(true);
      expect(disambiguator.pick).toHaveBeenCalledTimes(0);
    });

    it("mos nomzodi umuman yo'q item (candidates bo'sh) — LLM chaqirilmaydi", async () => {
      const { svc, disambiguator } = setup();
      await svc.resolveOrders(
        MARKET,
        [{ items: [{ name: 'kir yuvish mashinasi', quantity: 1 }] }],
        ctx(),
        [prod('1', 'Blender'), prod('2', 'Dazmol'), prod('3', 'Qozon')],
      );
      expect(disambiguator.pick).toHaveBeenCalledTimes(0);
    });

    it("katalogda 1-2 mahsulot bo'lsa noaniq item bo'lsa ham LLM chaqirilmaydi", async () => {
      const { svc, disambiguator } = setup();
      const [[item]] = await svc.resolveOrders(
        MARKET,
        [{ items: [{ name: 'atir sepgch', quantity: 1 }] }],
        ctx(),
        [prod('1', 'Atir sepgich'), prod('2', 'Atir')],
      );
      expect(item.unresolved).toBe(true);
      expect(disambiguator.pick).toHaveBeenCalledTimes(0);
    });

    it("partiyada noaniq itemlar ko'p bo'lsa ham LLM BITTA chaqiruv", async () => {
      const catalog = [
        prod('1', 'Atir sepgich'),
        prod('2', 'Atir'),
        prod('3', 'simsiz quloqchin'),
        prod('4', 'Blender'),
      ];
      const { svc, disambiguator } = setup(
        [],
        picks([
          { item_index: 0, choice: 1 },
          { item_index: 1, choice: 3 },
        ]),
      );
      const c = ctx();
      const res = await svc.resolveOrders(
        MARKET,
        [
          { items: [{ name: 'atir sepgch', quantity: 2 }] },
          {
            items: [
              { name: 'blender', quantity: 1 },
              { name: 'quloqchin', quantity: 1 },
            ],
          },
        ],
        c,
        catalog,
      );
      expect(disambiguator.pick).toHaveBeenCalledTimes(1);
      expect(disambiguator.pick).toHaveBeenCalledWith({
        market_id: MARKET,
        requester: c.requester,
        trace_id: 'trace-1',
        draft_id: 'draft-1',
        deadline_at: c.deadline_at,
        items: [
          { item_index: 0, name: 'atir sepgch', quantity: 2 },
          { item_index: 1, name: 'quloqchin', quantity: 1 },
        ],
        catalog: [
          { index: 1, name: 'Atir sepgich' },
          { index: 2, name: 'Atir' },
          { index: 3, name: 'simsiz quloqchin' },
          { index: 4, name: 'Blender' },
        ],
      });
      expect(res[0][0]).toMatchObject({
        product_id: '1',
        resolved_name: 'Atir sepgich',
        candidates: [],
        unresolved: false,
      });
      expect(res[1][0]).toMatchObject({ product_id: '4', unresolved: false });
      expect(res[1][1]).toMatchObject({
        product_id: '3',
        resolved_name: 'simsiz quloqchin',
        unresolved: false,
      });
    });
  });

  describe('#7 LLM choice=0 — product_id null, item unresolved', () => {
    it('nomzodlar operatorga qoladi', async () => {
      const { svc } = setup([], picks([{ item_index: 0, choice: 0 }]));
      const [[item]] = await svc.resolveOrders(
        MARKET,
        [{ items: [{ name: 'atir sepgch', quantity: 1 }] }],
        ctx(),
        [prod('1', 'Atir sepgich'), prod('2', 'Atir'), prod('3', 'Blender')],
      );
      expect(item.product_id).toBeNull();
      expect(item.unresolved).toBe(true);
      expect(item.candidates.map((c) => c.id)).toEqual(['1', '2']);
    });
  });

  describe("#8 diapazondan tashqari / noto'g'ri tanlov RAD etiladi", () => {
    const catalog = [
      prod('1', 'Atir sepgich'),
      prod('2', 'Atir'),
      prod('3', 'Blender'),
    ];

    it.each([
      ['choice -1', { item_index: 0, choice: -1 }],
      ['choice 1.5', { item_index: 0, choice: 1.5 }],
      ['choice len+1', { item_index: 0, choice: catalog.length + 1 }],
      ['choice satr', { item_index: 0, choice: '1' }],
      ['item_index 99', { item_index: 99, choice: 1 }],
      ['item_index -1', { item_index: -1, choice: 1 }],
      ['item_index 0.5', { item_index: 0.5, choice: 1 }],
    ])('%s → item unresolved, WARN', async (_name, pick) => {
      const { svc } = setup([], picks([pick]));
      const [[item]] = await svc.resolveOrders(
        MARKET,
        [{ items: [{ name: 'atir sepgch', quantity: 1 }] }],
        ctx(),
        catalog,
      );
      expect(item.product_id).toBeNull();
      expect(item.unresolved).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('1 ta tanlov rad etildi'),
      );
    });

    it("hal bo'lgan item'ga ikkinchi tanlov e'tiborsiz (birinchisi qoladi)", async () => {
      const { svc } = setup(
        [],
        picks([
          { item_index: 0, choice: 1 },
          { item_index: 0, choice: 2 },
        ]),
      );
      const [[item]] = await svc.resolveOrders(
        MARKET,
        [{ items: [{ name: 'atir sepgch', quantity: 1 }] }],
        ctx(),
        catalog,
      );
      expect(item.product_id).toBe('1');
    });
  });

  describe('#9 boshqa market mahsuloti RAD etiladi', () => {
    it('loadCatalog boshqa market qatorini WARN bilan tashlaydi', async () => {
      const { svc } = setup([
        { id: '1', name: 'Blender', user_id: MARKET },
        { id: '9', name: 'Atir', user_id: OTHER_MARKET },
        { id: '2', name: 'Dazmol', user_id: Number(MARKET) },
      ]);
      const catalog = await svc.loadCatalog(MARKET);
      expect(catalog).toEqual([
        { id: '1', name: 'Blender', user_id: MARKET },
        { id: '2', name: 'Dazmol', user_id: MARKET },
      ]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('boshqa marketning 1 ta mahsuloti tashlandi'),
      );
    });

    it("LLM boshqa market qatorini tanlasa — rad, item unresolved; LLM uni ko'rmaydi", async () => {
      const catalog = [
        prod('1', 'Atir sepgich'),
        prod('2', 'Atir'),
        prod('9', 'Atir sepgich mini', OTHER_MARKET),
        prod('3', 'Blender'),
      ];
      const { svc, disambiguator } = setup(
        [],
        picks([{ item_index: 0, choice: 3 }]),
      );
      const [[item]] = await svc.resolveOrders(
        MARKET,
        [{ items: [{ name: 'atir sepgch', quantity: 1 }] }],
        ctx(),
        catalog,
      );
      expect(item.product_id).toBeNull();
      expect(item.unresolved).toBe(true);
      expect(item.candidates.map((c) => c.id)).not.toContain('9');
      const req = disambiguator.pick.mock.calls[0][0];
      expect(req.catalog).toEqual([
        { index: 1, name: 'Atir sepgich' },
        { index: 2, name: 'Atir' },
        { index: 4, name: 'Blender' },
      ]);
    });

    it('deterministik moslash ham faqat shu market mahsulotlari orasida', () => {
      const { svc } = setup();
      const [item] = svc.resolveItems(
        [{ name: 'blender', quantity: 1 }],
        [prod('9', 'Blender', OTHER_MARKET)],
        MARKET,
      );
      expect(item.product_id).toBeNull();
      expect(item.candidates).toEqual([]);
    });
  });

  describe("#10 katalogda mos yo'q — product_name JIMGINA yozilmaydi", () => {
    it('{product_id:null, ai_name, unresolved:true}', () => {
      const { svc } = setup();
      const [item] = svc.resolveItems(
        [{ name: ' kir yuvish mashinasi ', quantity: 1 }],
        [prod('1', 'Blender'), prod('2', 'Dazmol')],
        MARKET,
      );
      expect(item).toEqual({
        ai_name: 'kir yuvish mashinasi',
        quantity: 1,
        product_id: null,
        resolved_name: null,
        candidates: [],
        unresolved: true,
      });
      expect(item).not.toHaveProperty('product_name');
    });
  });

  describe("#11 son ko'rsatilmasa 1", () => {
    it.each([
      [undefined, 1],
      [null, 1],
      [3, 3],
      ['4', 4],
      [2.7, 2],
      [0, 1],
      [-5, 1],
      ['abc', 1],
    ])('quantity %p → %p', (quantity, expected) => {
      const { svc } = setup();
      const [item] = svc.resolveItems(
        [{ name: 'blender', quantity }],
        [prod('1', 'Blender')],
        MARKET,
      );
      expect(item.quantity).toBe(expected);
    });

    it("bo'sh nomli item tashlanadi", () => {
      const { svc } = setup();
      const res = svc.resolveItems(
        [
          { name: '  ', quantity: 1 },
          { name: null, quantity: 1 },
          { name: 'blender', quantity: 1 },
        ],
        [prod('1', 'Blender')],
        MARKET,
      );
      expect(res.map((i) => i.ai_name)).toEqual(['blender']);
    });
  });

  describe("#12 bo'sh katalogli market — oqim yiqilmaydi", () => {
    it('hamma item unresolved, LLM chaqirilmaydi', async () => {
      const { svc, catalogClient, disambiguator } = setup([]);
      const res = await svc.resolveOrders(
        MARKET,
        [
          {
            items: [
              { name: 'blender', quantity: 1 },
              { name: 'dazmol', quantity: 2 },
            ],
          },
          { items: null },
        ],
        ctx(),
      );
      expect(catalogClient.send).toHaveBeenCalledTimes(1);
      expect(res).toHaveLength(2);
      expect(res[0].every((i) => i.unresolved && i.product_id === null)).toBe(
        true,
      );
      expect(res[1]).toEqual([]);
      expect(disambiguator.pick).not.toHaveBeenCalled();
    });
  });

  describe('loadCatalog chegaralari', () => {
    it("bo'sh marketId — RPC'siz []", async () => {
      const { svc, catalogClient } = setup([
        { id: '1', name: 'Blender', user_id: MARKET },
      ]);
      await expect(svc.loadCatalog('')).resolves.toEqual([]);
      await expect(svc.loadCatalog('   ')).resolves.toEqual([]);
      expect(catalogClient.send).not.toHaveBeenCalled();
    });

    it("total > data.length bo'lsa WARN", async () => {
      const { svc } = setup(
        [{ id: '1', name: 'Blender', user_id: MARKET }],
        undefined,
        700,
      );
      await svc.loadCatalog(MARKET);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("to'liq emas"));
    });

    it('RPC xatosi — [] + WARN, xato tashlanmaydi', async () => {
      const { svc } = setup();
      rmqSend.mockRejectedValueOnce(new Error('timeout'));
      await expect(svc.loadCatalog(MARKET)).resolves.toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('katalog yuklanmadi'),
      );
    });

    it('LLM porti xato tashlasa ham itemlar shunchaki unresolved', async () => {
      const { svc } = setup([], () => Promise.reject(new Error('boom')));
      const [[item]] = await svc.resolveOrders(
        MARKET,
        [{ items: [{ name: 'atir sepgch', quantity: 1 }] }],
        ctx(),
        [prod('1', 'Atir sepgich'), prod('2', 'Atir'), prod('3', 'Blender')],
      );
      expect(item.unresolved).toBe(true);
    });
  });
});
