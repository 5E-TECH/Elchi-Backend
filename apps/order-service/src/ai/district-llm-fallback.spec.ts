import { Logger } from '@nestjs/common';
import type { ClientProxy } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import type {
  AiDistrictPickRequest,
  IdempotencyService,
  RawOrderExtraction,
} from '@app/common';
import { AiPreviewService } from './ai-preview.service';
import type {
  DistrictTextQuery,
  DistrictTextResolution,
} from './ai-preview.types';
import {
  DistrictLlmFallbackService,
  NoopDistrictPicker,
  applyDistrictChoice,
  buildDistrictPool,
  districtRowsOf,
  isRiskyResolution,
  toPoolEntries,
  type DistrictPicker,
  type DistrictRow,
} from './district-llm-fallback';
import { ProductResolverService } from './product-resolver.service';

/**
 * 5Z1ZvvzE — tuman LLM fallback'i (order-service tomoni: risky aniqlash,
 * pool, viloyat qulfi, indeks diapazoni, SOATO darvozasi). Real Anthropic
 * CHAQIRILMAYDI — `DistrictPicker` soxta.
 *
 * Baza: 14 viloyat × 13 tuman = 182 − 1 = 181 tuman (jonli baza hajmi),
 * SOATO kodlari `<viloyat 4 raqam><3 raqam>`.
 */
type RawDistrict = {
  id: string;
  name: string;
  sato_code: string | null;
  region_id: string;
  isDeleted?: boolean;
  region: { id: string; name: string; sato_code: string | null };
};

const REGIONS = Array.from({ length: 14 }, (_, r) => ({
  id: String(r + 1),
  name:
    r === 0
      ? 'Andijon viloyati'
      : r === 1
        ? 'Sirdaryo viloyati'
        : `Viloyat ${r + 1}`,
  sato_code: String(1703 + r * 3),
}));

const NAMED: Record<string, string[]> = {
  '1': ['Asaka', "Xo'jaobod", 'Paxtaobod', 'Andijon', 'Shahrixon', 'Baliqchi'],
  '2': ['Mirzaobod', 'Guliston', 'Boyovut'],
};

function makeDb(): RawDistrict[] {
  const rows: RawDistrict[] = [];
  let id = 100;
  for (const region of REGIONS) {
    const names = NAMED[region.id] ?? [];
    const count = region.id === '14' ? 12 : 13;
    for (let k = 0; k < count; k++) {
      id += 1;
      rows.push({
        id: String(id),
        name: names[k] ?? `Tuman ${region.id}-${k + 1}`,
        sato_code: `${region.sato_code}${String(200 + k)}`,
        region_id: region.id,
        region: region,
      });
    }
  }
  // O'chirilgan qator — hisobga olinmaydi.
  rows.push({
    id: '999',
    name: 'Eski',
    sato_code: null,
    region_id: '1',
    isDeleted: true,
    region: REGIONS[0],
  });
  return rows;
}

const DB = makeDb();
const ROWS = districtRowsOf({ data: DB });

const UNRESOLVED: DistrictTextResolution = {
  region_id: null,
  district_id: null,
  region_name: null,
  district_name: null,
  region_given: false,
  candidates: [],
  reason: 'district_not_found',
};
const REGION_LOCKED: DistrictTextResolution = {
  ...UNRESOLVED,
  region_id: '1',
  region_name: 'Andijon viloyati',
  region_label: 'Andijon',
  region_given: true,
};
const RESOLVED: DistrictTextResolution = {
  ...REGION_LOCKED,
  district_id: '101',
  district_name: 'Asaka',
  reason: undefined,
};
const Q = (over: Partial<DistrictTextQuery> = {}): DistrictTextQuery => ({
  district_name: 'xojaobd',
  address: 'paxtaobod mfy 5-uy',
  ...over,
});

const CTX = {
  market_id: '121',
  requester: { id: '7', roles: ['market'] },
  trace_id: 't',
  draft_id: 'd',
  deadline_at: Date.now() + 25_000,
};

function setup(pickImpl?: DistrictPicker['pick'], dbFails = false) {
  const logistics = {
    send: jest.fn(() =>
      dbFails
        ? throwError(() => new Error('logistics down'))
        : of({ statusCode: 200, message: 'success', data: DB }),
    ),
  };
  const pick = jest.fn(pickImpl ?? (() => Promise.resolve(null)));
  const svc = new DistrictLlmFallbackService(
    logistics as unknown as ClientProxy,
    { pick },
  );
  const sent = (): AiDistrictPickRequest => {
    expect(pick).toHaveBeenCalledTimes(1);
    return pick.mock.calls[0][0];
  };
  return { svc, logistics, pick, sent };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('districtRowsOf', () => {
  it('181 faol tuman, o‘chirilgan tashlanadi, ORDER BY id', () => {
    expect(ROWS).toHaveLength(181);
    expect(ROWS.some((r) => r.id === '999')).toBe(false);
    const ids = ROWS.map((r) => Number(r.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });
});

describe('isRiskyResolution', () => {
  it('TC1: tuman aniq → risky EMAS', () => {
    expect(isRiskyResolution(RESOLVED, Q())).toBe(false);
  });
  it('nomzodlar bor (operator tanlaydi) va ataylab to‘xtatilgan holatlar → LLM’ga berilmaydi', () => {
    expect(
      isRiskyResolution(
        {
          ...UNRESOLVED,
          candidates: [
            { id: '1', label: 'x', region_name: 'y', district_name: 'z' },
          ],
          reason: 'district_ambiguous',
        },
        Q(),
      ),
    ).toBe(false);
    expect(
      isRiskyResolution(
        { ...UNRESOLVED, reason: 'cross_region_confusable' },
        Q(),
      ),
    ).toBe(false);
    expect(
      isRiskyResolution({ ...UNRESOLVED, reason: 'sato_mismatch' }, Q()),
    ).toBe(false);
  });
  it('joy matni bo‘sh → risky emas (so‘raladigan narsa yo‘q)', () => {
    expect(isRiskyResolution(UNRESOLVED, {})).toBe(false);
    expect(isRiskyResolution(UNRESOLVED, Q())).toBe(true);
    expect(isRiskyResolution(null, Q())).toBe(true);
  });
});

describe('buildDistrictPool', () => {
  it('TC2: viloyat qulflangan → FAQAT o‘sha viloyat (to‘liq, shortlist emas), boshqa viloyat YO‘Q', () => {
    const { trustRegion, pool } = buildDistrictPool(REGION_LOCKED, Q(), ROWS);
    expect(trustRegion).toBe(true);
    expect(pool).toHaveLength(13);
    expect(pool.every((r) => r.region_id === '1')).toBe(true);
  });

  it('TC7: viloyat noaniq → shortlist kamida 40 (181 tumanli baza), to‘g‘ri tuman ichida', () => {
    const { trustRegion, pool } = buildDistrictPool(UNRESOLVED, Q(), ROWS);
    expect(trustRegion).toBe(false);
    expect(pool.length).toBeGreaterThanOrEqual(40);
    expect(pool.length).toBeLessThanOrEqual(50);
    expect(pool.map((r) => r.name)).toContain("Xo'jaobod");
  });

  it('TC8: ikki marta qurilgan prompt ro‘yxati bayt darajasida bir xil va ORDER BY id', () => {
    const a = JSON.stringify(
      toPoolEntries(buildDistrictPool(UNRESOLVED, Q(), ROWS).pool),
    );
    const shuffled = [...ROWS].reverse();
    const b = JSON.stringify(
      toPoolEntries(buildDistrictPool(UNRESOLVED, Q(), shuffled).pool),
    );
    expect(b).toBe(a);
    const { pool } = buildDistrictPool(REGION_LOCKED, Q(), shuffled);
    const ids = pool.map((r) => Number(r.id));
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
  });

  it('modelga ko‘rinadigan pool’da ID YO‘Q — faqat indeks va nomlar', () => {
    const entries = toPoolEntries(
      buildDistrictPool(REGION_LOCKED, Q(), ROWS).pool,
    );
    expect(entries[0]).toEqual({
      index: 1,
      region_name: 'Andijon viloyati',
      district_name: 'Asaka',
    });
    expect(JSON.stringify(entries)).not.toMatch(/"id"/);
  });
});

describe('applyDistrictChoice', () => {
  const { pool } = buildDistrictPool(REGION_LOCKED, Q(), ROWS);

  it('TC5: choice=3 → district_id AYNAN pool[2].id', () => {
    const next = applyDistrictChoice(REGION_LOCKED, pool, true, 3);
    expect(next?.district_id).toBe(pool[2].id);
    expect(next?.region_id).toBe('1');
    expect(next?.candidates).toEqual([]);
    expect(next?.llm_picked).toBe(true);
  });

  it.each([0, -1, pool.length + 1, 1.5, '2', null])(
    'TC3/TC4: choice=%p → rad (null), natija o‘zgarmaydi',
    (choice) => {
      expect(applyDistrictChoice(REGION_LOCKED, pool, true, choice)).toBeNull();
    },
  );

  it('TC6: SOATO viloyat prefiksiga mos kelmasa — RAD; kod yo‘q bo‘lsa ham RAD', () => {
    const broken: DistrictRow[] = pool.map((r, i) =>
      i === 0
        ? { ...r, sato_code: '1726200' }
        : i === 1
          ? { ...r, sato_code: null }
          : r,
    );
    expect(applyDistrictChoice(REGION_LOCKED, broken, true, 1)).toBeNull();
    expect(applyDistrictChoice(REGION_LOCKED, broken, true, 2)).toBeNull();
    expect(applyDistrictChoice(REGION_LOCKED, broken, true, 3)).not.toBeNull();
  });

  it('viloyat qulfi: qulflangan holatda boshqa viloyat qatori tanlansa — RAD', () => {
    const other = ROWS.filter((r) => r.region_id === '2');
    expect(applyDistrictChoice(REGION_LOCKED, other, true, 1)).toBeNull();
  });
});

describe('DistrictLlmFallbackService.refine', () => {
  it('TC1: risky yo‘q → LLM ham, tuman ro‘yxati ham CHAQIRILMAYDI', async () => {
    const fx = setup();
    const out = await fx.svc.refine([Q()], [RESOLVED], CTX);
    expect(out).toEqual([RESOLVED]);
    expect(fx.pick).not.toHaveBeenCalled();
    expect(fx.logistics.send).not.toHaveBeenCalled();
  });

  it('TC2/TC5: viloyat qulflangan — so‘rov faqat o‘sha viloyat pooli; tanlov pool[choice-1]', async () => {
    const { pool } = buildDistrictPool(REGION_LOCKED, Q(), ROWS);
    const fx = setup(() =>
      Promise.resolve({ picks: [{ item_index: 0, choice: 2 }] }),
    );
    const out = await fx.svc.refine([Q()], [REGION_LOCKED], CTX);
    const req = fx.sent();
    expect(req.items).toHaveLength(1);
    expect(
      req.items[0].pool.every((p) => p.region_name === 'Andijon viloyati'),
    ).toBe(true);
    expect(req.items[0].pool).toHaveLength(13);
    expect(req.market_id).toBe('121');
    expect(out[0]?.district_id).toBe(pool[1].id);
    expect(out[0]?.district_name).toBe("Xo'jaobod");
  });

  it('TC3: choice=0 → tuman null, viloyat SAQLANADI, boshqa viloyatga o‘tilmaydi', async () => {
    const fx = setup(() =>
      Promise.resolve({ picks: [{ item_index: 0, choice: 0 }] }),
    );
    const out = await fx.svc.refine([Q()], [REGION_LOCKED], CTX);
    expect(out[0]).toEqual(REGION_LOCKED);
  });

  it('TC4: diapazondan tashqari choice → natija o‘zgarmaydi', async () => {
    const fx = setup(() =>
      Promise.resolve({ picks: [{ item_index: 0, choice: 14 }] }),
    );
    const out = await fx.svc.refine([Q()], [REGION_LOCKED], CTX);
    expect(out[0]).toEqual(REGION_LOCKED);
  });

  it('TC11/TC12: AI natijasiz (o‘chiq / kesilgan / tarmoq) → jimgina deterministik natija', async () => {
    const fx = setup(() => Promise.resolve(null));
    await expect(fx.svc.refine([Q()], [UNRESOLVED], CTX)).resolves.toEqual([
      UNRESOLVED,
    ]);
    const noop = new DistrictLlmFallbackService(
      { send: jest.fn(() => of({ data: DB })) } as unknown as ClientProxy,
      new NoopDistrictPicker(),
    );
    await expect(noop.refine([Q()], [UNRESOLVED], CTX)).resolves.toEqual([
      UNRESOLVED,
    ]);
  });

  it('picker throw qilsa ham / tuman ro‘yxati o‘qilmasa ham oqim yiqilmaydi', async () => {
    const fx = setup(() => Promise.reject(new Error('boom')));
    await expect(fx.svc.refine([Q()], [UNRESOLVED], CTX)).resolves.toEqual([
      UNRESOLVED,
    ]);
    const down = setup(undefined, true);
    await expect(down.svc.refine([Q()], [UNRESOLVED], CTX)).resolves.toEqual([
      UNRESOLVED,
    ]);
    expect(down.pick).not.toHaveBeenCalled();
  });

  it('partiya: BITTA chaqiruv, faqat risky buyurtmalar (ko‘pi bilan 10)', async () => {
    const fx = setup();
    const queries = Array.from({ length: 14 }, () => Q());
    const res = queries.map((_, i) => (i === 0 ? RESOLVED : UNRESOLVED));
    await fx.svc.refine(queries, res, CTX);
    const req = fx.sent();
    expect(req.items.map((i) => i.item_index)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it('tuman ro‘yxati keshlanadi (10 daqiqa) — ikkinchi preview’da logistics qayta chaqirilmaydi', async () => {
    const fx = setup();
    await fx.svc.refine([Q()], [UNRESOLVED], CTX);
    await fx.svc.refine([Q()], [UNRESOLVED], CTX);
    expect(fx.logistics.send).toHaveBeenCalledTimes(1);
  });
});

describe('AiPreviewService + fallback (integratsiya)', () => {
  it('rezolver topolmagan tumanni LLM tanlaydi → preview district_id + district_source:"ai"', async () => {
    const logisticsClient = {
      send: jest.fn(
        (pattern: { cmd: string }, payload: { items?: unknown[] }) =>
          pattern.cmd === 'logistics.district.resolve_by_text'
            ? of({
                data: (payload.items ?? []).map(() => REGION_LOCKED),
              })
            : of({ data: DB }),
      ),
    };
    const catalogClient = { send: jest.fn(() => of({ data: [], total: 0 })) };
    const identityClient = {
      send: jest.fn(() => of({ data: { default_tariff: 'center' } })),
    };
    const resolver = new ProductResolverService(
      catalogClient as unknown as ClientProxy,
      { pick: jest.fn(() => Promise.resolve(null)) },
    );
    const pick = jest.fn(() =>
      Promise.resolve({ picks: [{ item_index: 0, choice: 2 }] }),
    );
    const fallback = new DistrictLlmFallbackService(
      logisticsClient as unknown as ClientProxy,
      { pick },
    );
    const svc = new AiPreviewService(
      resolver,
      logisticsClient as unknown as ClientProxy,
      identityClient as unknown as ClientProxy,
      {
        prunePattern: jest.fn().mockResolvedValue(0),
      } as unknown as IdempotencyService,
      fallback,
    );
    const { previews } = await svc.resolve({
      raw_orders: [
        {
          customer_name: 'Nozima',
          phone_number: '+998901234567',
          region_name: 'Andijon',
          district_name: 'xojaobd',
          address: 'paxtaobod mfy 5-uy',
          items: [{ name: 'muzlatgich', quantity: 1 }],
          total_price: 4200000,
        } as Partial<RawOrderExtraction>,
      ],
      market_id: '121',
      requester: { id: '7', roles: ['market'] },
      trace_id: 't',
      draft_id: 'd',
      deadline_at: Date.now() + 25_000,
    });
    expect(previews[0]).toMatchObject({
      district_id: '102',
      district_name: "Xo'jaobod",
      region_id: '1',
      district_source: 'ai',
    });
    expect(previews[0].issues).not.toContain('district_missing');
  });
});
