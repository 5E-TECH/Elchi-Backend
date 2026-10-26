/**
 * J3hEDtFN #2 — AI ekstraksiya EVAL'i CI'da (kalitsiz, tarmoqsiz, replay).
 *
 * Har fixture HAQIQIY OrderExtractService quvuridan (maskPhones → ClaudeService
 * → unmask → sanitize) yozib olingan javob bilan o'tadi va maydon bo'yicha
 * baholanadi. Darvoza: ≥40 fixture, karta toifalari ≥4 tadan, telefon / narx /
 * tuman ≥95%, hech bir maydon `_baseline.json` dan past emas.
 */
import { Logger } from '@nestjs/common';
import {
  maskPhones,
  normGeo,
  normalizeUzPhone,
  regionAlias,
} from '@app/common';
import { regions } from '../../logistics-service/src/data/regions-districts.data';
import {
  ORDER_EXTRACT_PROMPT_VERSION,
  ORDER_EXTRACT_SYSTEM,
} from '../src/prompts/order-extract.prompt';
import { ORDER_EXTRACT_SCHEMA } from '../src/prompts/order-extract.schema';
import {
  ORDER_EXTRACT_EFFORT,
  ORDER_EXTRACT_MAX_TOKENS,
} from '../src/order-extract/order-extract.service';
import {
  GATED_FIELDS,
  GATE_MIN_ACCURACY,
  MIN_FIXTURES,
  MIN_PER_CATEGORY,
  REQUIRED_CATEGORIES,
  SCORED_FIELDS,
  buildReplayService,
  buildSeedRecording,
  gateFailures,
  loadBaseline,
  loadFixtures,
  loadRecordings,
  runReplay,
  scoreFixture,
  type EvalReport,
  type FieldTally,
  type ScoredField,
} from './eval/order-extract-eval';

/** Sintetik telefon: +998 XX 000 XX XX (o'rta guruh doim 000). */
const SYNTHETIC_PHONE_RE = /^\+998\d{2}000\d{4}$/;

const fixtures = loadFixtures();
const recordings = loadRecordings();

describe('J3hEDtFN eval to‘plami (fixtures)', () => {
  it(`kamida ${MIN_FIXTURES} ta fixture, id = fayl, karta toifalari ≥${MIN_PER_CATEGORY}`, () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(MIN_FIXTURES);
    expect(new Set(fixtures.map((f) => f.id)).size).toBe(fixtures.length);
    for (const c of REQUIRED_CATEGORIES) {
      const n = fixtures.filter((f) => f.category.includes(c)).length;
      expect({ category: c, n: n >= MIN_PER_CATEGORY }).toEqual({
        category: c,
        n: true,
      });
    }
  });

  it('PII qo‘riqchisi: matndagi barcha telefonlar sintetik (+998 XX 000 XX XX)', () => {
    for (const f of fixtures) {
      const { tokens } = maskPhones(f.input.text);
      for (const e164 of tokens.values()) {
        expect({
          id: f.id,
          phone: e164,
          ok: SYNTHETIC_PHONE_RE.test(e164),
        }).toEqual({ id: f.id, phone: e164, ok: true });
      }
      for (const o of f.expected.orders) {
        for (const p of [o.phone_number, o.extra_number]) {
          if (p) expect(SYNTHETIC_PHONE_RE.test(p)).toBe(true);
        }
      }
    }
  });

  it('kutilgan viloyat/tuman Elchi geografiyasida bor (fixture xatosi emas)', () => {
    for (const f of fixtures) {
      for (const o of f.expected.orders) {
        if (!o.region_name) continue;
        const sato = regionAlias(o.region_name);
        const region = regions.find((r) => r.sato_code === sato);
        expect({ id: f.id, region: o.region_name, found: !!region }).toEqual({
          id: f.id,
          region: o.region_name,
          found: true,
        });
        if (!o.district_name || !region) continue;
        const found = region.districts.some(
          (d) => normGeo(d.name) === normGeo(o.district_name),
        );
        expect({ id: f.id, district: o.district_name, found }).toEqual({
          id: f.id,
          district: o.district_name,
          found: true,
        });
      }
    }
  });

  it('har fixture uchun yozuv bor, joriy prompt versiyasida; yozuvda ochiq telefon YO‘Q', () => {
    for (const f of fixtures) {
      const rec = recordings.get(f.id);
      expect({ id: f.id, has: !!rec }).toEqual({ id: f.id, has: true });
      expect(rec?.prompt_version).toBe(ORDER_EXTRACT_PROMPT_VERSION);
      // Model faqat [TEL_n] tokenini ko'radi — yozuvda raqam bo'lmasligi kerak.
      const raw = JSON.stringify(rec?.response ?? {});
      expect(/\d{2}[ -]?000[ -]?\d{2}[ -]?\d{2}/.test(raw)).toBe(false);
    }
  });

  it('seed yozuvlar kutilgan natijadan aynan qayta yasaladi (qo‘lda tahrir yo‘q)', () => {
    for (const f of fixtures) {
      const rec = recordings.get(f.id);
      if (rec?.source !== 'seed') continue;
      expect(rec.response).toEqual(buildSeedRecording(f).response);
    }
  });
});

describe('J3hEDtFN eval replay (CI darvozasi)', () => {
  let report: EvalReport;
  let bodies: Record<string, unknown>[];
  let fetchSpy: jest.SpyInstance | null = null;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    if (typeof globalThis.fetch === 'function') {
      fetchSpy = jest.spyOn(globalThis, 'fetch');
    }
    const deps = buildReplayService();
    report = await runReplay({ deps });
    bodies = deps.client.bodies;
  }, 60_000);

  afterAll(() => jest.restoreAllMocks());

  it('tarmoqqa hech qanday so‘rov ketmadi (faqat soxta mijoz)', () => {
    expect(fetchSpy?.mock.calls.length ?? 0).toBe(0);
    expect(bodies.length).toBe(fixtures.length);
  });

  it('so‘rov tanasi: effort low, dinamik max_tokens ≤16000, keshlangan system, sxema', () => {
    for (const body of bodies) {
      const oc = body.output_config as {
        effort?: string;
        format?: { schema?: unknown };
      };
      expect(oc.effort).toBe(ORDER_EXTRACT_EFFORT);
      expect(oc.format?.schema).toEqual(ORDER_EXTRACT_SCHEMA);
      expect(body.max_tokens).toBeLessThanOrEqual(ORDER_EXTRACT_MAX_TOKENS);
      expect(body.max_tokens).toBeGreaterThanOrEqual(2_100);
      expect('thinking' in body).toBe(false);
      expect(body.system).toEqual([
        {
          type: 'text',
          text: ORDER_EXTRACT_SYSTEM,
          cache_control: { type: 'ephemeral' },
        },
      ]);
    }
  });

  it(`darvoza: ${GATED_FIELDS.join(', ')} ≥ ${GATE_MIN_ACCURACY * 100}% va baseline'dan past emas`, () => {
    const failures = gateFailures(report, loadBaseline());
    expect(failures).toEqual([]);
    for (const f of GATED_FIELDS) {
      expect(report.accuracy[f]).toBeGreaterThanOrEqual(GATE_MIN_ACCURACY);
    }
  });

  it('har fixture quvurdan o‘tdi (extract ok)', () => {
    const notOk = report.results.filter((r) => r.reason !== null);
    expect(notOk.map((r) => `${r.id}:${r.reason}`)).toEqual([]);
  });
});

describe('baholash o‘zi to‘g‘ri ishlaydi (salbiy holatlar)', () => {
  const fresh = (): Record<ScoredField, FieldTally> => {
    const t = {} as Record<ScoredField, FieldTally>;
    for (const f of SCORED_FIELDS) t[f] = { correct: 0, total: 0 };
    return t;
  };
  const fixture = fixtures.find((f) => f.id === 'price-per-unit-times-qty');

  it('xato narx, telefon va tuman maydon xatosi sifatida sanaladi', () => {
    expect(fixture).toBeDefined();
    const exp = fixture!.expected.orders[0];
    const failed = scoreFixture(
      fixture!,
      [
        {
          customer_name: exp.customer_name ?? null,
          phone_number: '+998900009999',
          extra_number: null,
          region_name: exp.region_name ?? null,
          district_name: 'Asaka',
          address: null,
          full_address: null,
          items: exp.items ?? [],
          total_price: 75000,
          comment: null,
          where_deliver: null,
          is_replacement: false,
          operator: null,
          warnings: [],
        },
      ],
      fresh(),
    );
    expect(failed).toEqual(
      expect.arrayContaining(['phone_number', 'district_name', 'total_price']),
    );
    expect(normalizeUzPhone('+998 90 000 99 99')).toBe('+998900009999');
  });

  it('buyurtma yetishmasa — orders_count va barcha maydonlar xato', () => {
    const multi = fixtures.find((f) => f.id === 'multi-numbered-two')!;
    const tallies = fresh();
    const failed = scoreFixture(multi, [], tallies);
    expect(failed[0]).toMatch(/^orders_count/);
    expect(tallies.phone_number.correct).toBe(0);
    expect(tallies.phone_number.total).toBe(2);
  });

  it('aniqlik 95% dan past bo‘lsa darvoza yiqiladi', () => {
    const tallies = fresh();
    tallies.total_price = { correct: 9, total: 10 };
    tallies.phone_number = { correct: 10, total: 10 };
    tallies.district_name = { correct: 10, total: 10 };
    const accuracy = {} as EvalReport['accuracy'];
    for (const f of SCORED_FIELDS) {
      const t = tallies[f];
      accuracy[f] = t.total ? t.correct / t.total : null;
    }
    const failures = gateFailures(
      {
        promptVersion: ORDER_EXTRACT_PROMPT_VERSION,
        fixtures: fixtures.length,
        fields: tallies,
        accuracy,
        categories: Object.fromEntries(
          REQUIRED_CATEGORIES.map((c) => [c, { passed: 4, total: 4 }]),
        ),
        results: [],
        staleRecordings: [],
        seedRecordings: 0,
        liveRecordings: 0,
        usage: null,
        latency: null,
      },
      { prompt_version: 'x', fields: { phone_number: 1 } },
    );
    expect(failures.join('\n')).toMatch(/total_price accuracy 90\.0%/);
  });
});
