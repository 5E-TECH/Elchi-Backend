import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  AI_MODEL_DEFAULTS,
  ClaudeService,
  type AiDistrictCatalogEntry,
  type AiDistrictPickItem,
  type AiDistrictPickRequest,
  type AnthropicClientFactory,
  type ClaudeUsageRecord,
  type ClaudeUsageSink,
} from '@app/common';
import {
  DISTRICT_PICK_CATALOG_SYSTEM,
  DISTRICT_PICK_SYSTEM,
  buildDistrictCatalogSystem,
} from '../prompts/district-pick.prompt';
import { cacheMinTokensFor } from '../usage/ai-pricing';
import {
  DISTRICT_CHARS_PER_TOKEN_ESTIMATE,
  DistrictPickService,
} from './district-pick.service';

/**
 * 5Z1ZvvzE TC9 — "Ikkinchi chaqiruvda cache_read_input_tokens > 0 (ro'yxat
 * system-promptga chiqarilgan holatda)".
 *
 * ⚠️ Real Anthropic CHAQIRILMAYDI. Soxta mijoz Anthropic prompt keshini
 * taqlid qiladi: `cache_control: ephemeral` belgilangan system bloki (model +
 * matn) oldingi chaqiruvdagi bilan BAYTMA-BAYT bir xil bo'lsa — `cache_read`,
 * aks holda `cache_creation`; prefiks modelning minimal keshlanadigan
 * chegarasidan (`AI_MODEL_CACHE_MIN_TOKENS`) qisqa bo'lsa — JIMGINA keshsiz
 * (Anthropic xulqi). Haqiqiy `cache_read_input_tokens` — faqat prodda (⏳).
 */
interface SentBody {
  model: string;
  system: Array<{
    type: string;
    text: string;
    cache_control?: { type: string };
  }>;
  messages: Array<{ role: string; content: string }>;
  output_config: Record<string, unknown>;
}

function estTokens(text: string): number {
  return Math.ceil(text.length / DISTRICT_CHARS_PER_TOKEN_ESTIMATE);
}

function fakeCachingClient(
  bodies: SentBody[],
  reply: () => unknown = () => ({ picks: [] }),
): AnthropicClientFactory {
  const cache = new Set<string>();
  return () => ({
    messages: {
      create: (body: unknown) => {
        const b = body as SentBody;
        bodies.push(b);
        const block = b.system?.[0];
        const tokens = block ? estTokens(block.text) : 0;
        const min = cacheMinTokensFor(b.model) ?? 512;
        const key =
          block?.cache_control?.type === 'ephemeral' && tokens >= min
            ? `${b.model}\u0000${block.text}`
            : null;
        const hit = key !== null && cache.has(key);
        if (key) cache.add(key);
        return Promise.resolve({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify(reply()) }],
          usage: {
            input_tokens: 80,
            output_tokens: 12,
            cache_creation_input_tokens: key && !hit ? tokens : 0,
            cache_read_input_tokens: hit ? tokens : 0,
            // Keshsiz holatda system ham oddiy kirish tokeni.
            ...(key ? {} : { input_tokens: 80 + tokens }),
          },
        });
      },
    },
  });
}

/** 14 viloyat × 13 tuman − 1 = 181 (jonli baza hajmi), `ORDER BY id` tartibi. */
const CATALOG: AiDistrictCatalogEntry[] = (() => {
  const out: AiDistrictCatalogEntry[] = [];
  const named: Record<number, string[]> = {
    0: ['Asaka', "Xo'jaobod", 'Paxtaobod', 'Andijon shahri', 'Shahrixon'],
    1: ['Mirzaobod', 'Guliston', 'Boyovut'],
    2: ['Mirobod', 'Chilonzor', 'Yunusobod', 'Yashnobod'],
  };
  for (let r = 0; r < 14; r++) {
    const region =
      r === 0
        ? 'Andijon viloyati'
        : r === 1
          ? 'Sirdaryo viloyati'
          : r === 2
            ? 'Toshkent shahri'
            : `Viloyat ${r + 1}`;
    const count = r === 13 ? 12 : 13;
    for (let k = 0; k < count; k++) {
      out.push({
        region_name: region,
        district_name: named[r]?.[k] ?? `Tuman ${r + 1}-${k + 1} tumani`,
      });
    }
  }
  return out;
})();

/** Katalogning [from..to] (1-asosli) qismidan item pooli (pool `index` 1 dan). */
function poolOf(from: number, to: number): AiDistrictPickItem['pool'] {
  const pool: AiDistrictPickItem['pool'] = [];
  for (let ci = from; ci <= to; ci++) {
    pool.push({
      index: pool.length + 1,
      region_name: CATALOG[ci - 1].region_name,
      district_name: CATALOG[ci - 1].district_name,
      catalog_index: ci,
    });
  }
  return pool;
}

const req = (
  over: Partial<AiDistrictPickRequest> = {},
): AiDistrictPickRequest => ({
  market_id: '121',
  requester: { id: '7', roles: ['market'] },
  trace_id: 't-1',
  draft_id: '0b9f7c3e-1d2a-4b5c-8d6e-7f8091a2b3c4',
  deadline_at: Date.now() + 60_000,
  catalog: CATALOG,
  items: [
    {
      item_index: 0,
      place_text: 'xojaobd paxtaobod mfy',
      region_name: 'Andijon',
      // Viloyat qulfi: faqat Andijon (katalog 1..13).
      pool: poolOf(1, 13),
    },
  ],
  ...over,
});

function setup(model?: string, reply?: () => unknown) {
  const values: Record<string, unknown> = {
    ANTHROPIC_API_KEY: 'sk-ant-test',
    ...(model ? { AI_DISTRICT_MODEL: model } : {}),
  };
  const config = { get: (k: string) => values[k] } as unknown as ConfigService;
  const bodies: SentBody[] = [];
  const records: ClaudeUsageRecord[] = [];
  const sink: ClaudeUsageSink = { record: (r) => void records.push(r) };
  const claude = new ClaudeService(
    config,
    fakeCachingClient(bodies, reply),
    sink,
  );
  return { service: new DistrictPickService(claude, config), bodies, records };
}

describe('tuman LLM fallback — prompt keshi (5Z1ZvvzE TC9)', () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('TC9: ikkinchi chaqiruvda cache_read_tokens > 0 (ro‘yxat system’da, user/market har xil)', async () => {
    const { service, bodies, records } = setup();

    await service.pick(req());
    await service.pick(
      req({
        market_id: '999',
        requester: { id: '8', roles: ['market'] },
        trace_id: 't-2',
        items: [
          {
            item_index: 3,
            place_text: 'mirzaobot',
            region_name: null,
            pool: poolOf(10, 40),
          },
        ],
      }),
    );

    expect(records).toHaveLength(2);
    expect(records.every((r) => r.feature === 'order_district')).toBe(true);
    expect(records[0].cacheCreationTokens).toBeGreaterThan(0);
    expect(records[0].cacheReadTokens).toBe(0);
    expect(records[1].cacheReadTokens).toBeGreaterThan(0);
    expect(records[1].cacheCreationTokens).toBe(0);
    // Ikkinchi yozuv ham market/user bilan (TC10 buzilmagan).
    expect(records[1].marketId).toBe('999');
    expect(records[1].userId).toBe('8');

    // System — bitta blok, cache_control ephemeral, ikkala chaqiruvda AYNAN bir xil.
    for (const b of bodies) {
      expect(b.system).toHaveLength(1);
      expect(b.system[0].cache_control).toEqual({ type: 'ephemeral' });
    }
    expect(bodies[1].system[0].text).toBe(bodies[0].system[0].text);
    expect(bodies[0].system[0].text).toBe(buildDistrictCatalogSystem(CATALOG));
    expect(
      bodies[0].system[0].text.startsWith(DISTRICT_PICK_CATALOG_SYSTEM),
    ).toBe(true);
    expect(bodies[0].system[0].text).toContain(
      "[2] Andijon viloyati — Xo'jaobod",
    );
    expect(bodies[0].system[0].text).toContain(
      `[181] ${CATALOG[180].region_name} — ${CATALOG[180].district_name}`,
    );
    expect(bodies[0].model).toBe(AI_MODEL_DEFAULTS.district);
  });

  it("o'zgaruvchan qism faqat user blokda: item_index, place_text, region_name, candidates (nom/ID/market YO'Q)", async () => {
    const { service, bodies } = setup();
    await service.pick(req());

    const user = bodies[0].messages[0].content;
    const json = user
      .replace(/^<user_message>\n/, '')
      .replace(/\n<\/user_message>$/, '');
    expect(JSON.parse(json)).toEqual({
      items: [
        {
          item_index: 0,
          place_text: 'xojaobd paxtaobod mfy',
          region_name: 'Andijon',
          candidates: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
        },
      ],
    });
    expect(user).not.toContain("Xo'jaobod");
    expect(user).not.toContain('121');
    // System'da esa o'zgaruvchan qism yo'q.
    expect(bodies[0].system[0].text).not.toContain('paxtaobod mfy');
    expect(bodies[0].system[0].text).not.toContain('"candidates":');
  });

  it('katalog system-prompti BIR marta quriladi (memo) va bayt darajasida barqaror', async () => {
    const { service, bodies } = setup();
    await service.pick(req());
    await service.pick(req({ trace_id: 't-3' }));
    await service.pick(req({ catalog: CATALOG.map((e) => ({ ...e })) }));

    const built = logSpy.mock.calls.filter((c) =>
      String(c[0]).startsWith('district_pick_catalog_system qurildi'),
    );
    expect(built).toHaveLength(1);
    expect(new Set(bodies.map((b) => b.system[0].text)).size).toBe(1);
    expect(buildDistrictCatalogSystem(CATALOG)).toBe(
      buildDistrictCatalogSystem(CATALOG.map((e) => ({ ...e }))),
    );
  });

  it('katalog raqami pool indeksiga o‘giriladi; candidates’da yo‘q raqam (boshqa viloyat) RAD; 0 saqlanadi', async () => {
    const { service } = setup(undefined, () => ({
      picks: [
        { item_index: 0, choice: 2 }, // Xo'jaobod → pool index 2
        { item_index: 1, choice: 15 }, // Sirdaryo, lekin item 1 candidates = 27..39 → RAD
        { item_index: 2, choice: 0 },
      ],
    }));
    const r = await service.pick(
      req({
        items: [
          {
            item_index: 0,
            place_text: 'xojaobd',
            region_name: 'Andijon',
            pool: poolOf(1, 13),
          },
          {
            item_index: 1,
            place_text: 'mirzaobot',
            region_name: 'Toshkent',
            pool: poolOf(27, 39),
          },
          {
            item_index: 2,
            place_text: 'qayerdir',
            region_name: null,
            pool: poolOf(1, 45),
          },
        ],
      }),
    );
    expect(r).toEqual({
      ok: true,
      picks: [
        { item_index: 0, choice: 2 },
        { item_index: 2, choice: 0 },
      ],
    });
  });

  it('pool’dagi (katalogdan tashqari) raqam ham RAD: choice=pool.length+1 natijani o‘zgartirmaydi', async () => {
    const { service } = setup(undefined, () => ({
      picks: [{ item_index: 0, choice: 14 }],
    }));
    await expect(service.pick(req())).resolves.toEqual({
      ok: true,
      picks: [],
    });
  });

  it('effort: sonnet-5 (sukut adaptive thinking) → output_config.effort=low; haiku-4-5 → effort YO‘Q', async () => {
    const a = setup('claude-sonnet-5');
    await a.service.pick(req());
    expect(a.bodies[0].output_config.effort).toBe('low');

    const b = setup('claude-haiku-4-5');
    await b.service.pick(req());
    expect(b.bodies[0].output_config).not.toHaveProperty('effort');
  });

  it('Haiku 4.5: minimal kesh prefiksi 4096 > katalog prompti → ESKI rejim (pool user blokda), kesh baribir yo‘q', async () => {
    const { service, bodies, records } = setup('claude-haiku-4-5');
    await service.pick(req());
    await service.pick(req({ trace_id: 't-2' }));

    expect(estTokens(buildDistrictCatalogSystem(CATALOG))).toBeLessThan(4096);
    expect(cacheMinTokensFor('claude-haiku-4-5')).toBe(4096);
    expect(bodies[0].system[0].text).toBe(DISTRICT_PICK_SYSTEM);
    expect(bodies[0].messages[0].content).toContain('"pool"');
    expect(records.map((r) => r.cacheReadTokens)).toEqual([0, 0]);
    expect(
      warnSpy.mock.calls.filter((c) =>
        String(c[0]).startsWith('district_pick_cache_below_min'),
      ),
    ).toHaveLength(1);
  });

  it.each([
    ['katalog yo‘q (eski order-service)', { catalog: undefined }],
    [
      'pool nomi katalog bilan mos emas (eskirgan katalog)',
      {
        items: [
          {
            item_index: 0,
            place_text: 'xojaobd',
            region_name: null,
            pool: [
              {
                index: 1,
                region_name: 'Andijon viloyati',
                district_name: 'Boshqa',
                catalog_index: 1,
              },
            ],
          },
        ],
      },
    ],
    [
      'catalog_index diapazondan tashqari',
      {
        items: [
          {
            item_index: 0,
            place_text: 'xojaobd',
            region_name: null,
            pool: [
              {
                index: 1,
                region_name: 'Andijon viloyati',
                district_name: 'Asaka',
                catalog_index: 182,
              },
            ],
          },
        ],
      },
    ],
    ['katalog bo‘sh', { catalog: [] }],
  ] as Array<[string, Partial<AiDistrictPickRequest>]>)(
    '%s → ESKI rejim (DISTRICT_PICK_SYSTEM, pool user blokda), choice o‘zgarishsiz',
    async (_label, over) => {
      const { service, bodies } = setup(undefined, () => ({
        picks: [{ item_index: 0, choice: 1 }],
      }));
      const r = await service.pick(req(over));
      expect(bodies[0].system[0].text).toBe(DISTRICT_PICK_SYSTEM);
      expect(bodies[0].messages[0].content).toContain('"pool"');
      expect(r).toEqual({ ok: true, picks: [{ item_index: 0, choice: 1 }] });
    },
  );
});
