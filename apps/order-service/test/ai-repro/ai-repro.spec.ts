/**
 * AI buyurtma — deterministik qatlam reproduktsiyasi (LLM / DB / tarmoq YO'Q).
 *
 * Joylashuv: `apps/order-service/test/ai-repro/` (`test` — build'ga
 * kirmaydi). Hisobot (results.json):
 *   AI_REPRO_OUT=<dir> npx jest apps/order-service/test/ai-repro --runInBand
 * Tuman va viloyat regressiyasi HAR DOIM ishlaydi (CI): har holat PASS,
 * `KNOWN_DATA_GAPS` dagilar esa kamida xavfsiz (avto-tanlov yo'q, operator
 * tanlaydi). Qolgan bo'limlar (telefon, narx) — faqat hisobot (A1–A3 keyin).
 *
 * Haqiqiy kod chaqiriladi:
 *  - logistics `resolveDistrictText` (seed snapshot, 181 tuman — xuddi
 *    district-resolver.spec.ts dagi kabi sintetik id bilan);
 *  - order-service `AiPreviewService` (haqiqiy ProductResolverService,
 *    haqiqiy DistrictLlmFallbackService; LLM o'rniga YOZIB OLUVCHI picker —
 *    hech narsa tanlamaydi, faqat modelga NIMA ketishini qayd qiladi);
 *  - ai-service `sanitizeExtraction`; `@app/common` `maskPhones`,
 *    `unmaskPhones`, `normalizeUzPhone`, `regionAlias`, `normGeo`.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { of } from 'rxjs';
import type { ClientProxy } from '@nestjs/microservices';
import { Logger } from '@nestjs/common';
import {
  maskPhones,
  unmaskPhones,
  normalizeUzPhone,
  regionAlias,
  normGeo,
  type IdempotencyService,
  type AiDistrictPickRequest,
} from '@app/common';
import { regions as seedRegions } from '../../../logistics-service/src/data/regions-districts.data';
import { satoRegions } from '../../../logistics-service/src/data/sato-codes';
import { resolveDistrictText } from '../../../logistics-service/src/district-resolver/district-resolver.service';
import type {
  DistrictSnapshot,
  DistrictTextResolution,
} from '../../../logistics-service/src/district-resolver/district-resolver.types';
import { sanitizeExtraction } from '../../../ai-service/src/order-extract/sanitize-extraction';
import { AiPreviewService } from '../../src/ai/ai-preview.service';
import { ProductResolverService } from '../../src/ai/product-resolver.service';
import {
  DistrictLlmFallbackService,
  type DistrictPicker,
  type DistrictPicks,
} from '../../src/ai/district-llm-fallback';
import type { AiOrderPreview } from '../../src/ai/ai-preview.types';
import {
  AMOUNT_MASK_CASES,
  AMOUNT_MODEL_CASES,
  DISTRICT_CASES,
  PHONE_MASK_CASES,
  PHONE_NORM_CASES,
  REGION_CASES,
  type DistrictCase,
} from './cases';

// Rezolver/fallback WARN'lari natijaga ta'sir qilmaydi — shovqinni o'chiramiz.
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

// ─────────────────────────── Snapshot (seed) ───────────────────────────
function buildSnapshot(): DistrictSnapshot {
  const regions: { id: string; name: string; sato_code: string | null }[] = [];
  const districts: {
    id: string;
    name: string;
    sato_code: string | null;
    region_id: string;
  }[] = [];
  let did = 1000;
  seedRegions.forEach((r, i) => {
    const rid = String(i + 1);
    regions.push({ id: rid, name: r.name, sato_code: r.sato_code });
    for (const d of r.districts) {
      did += 1;
      districts.push({
        id: String(did),
        name: d.name,
        sato_code: d.sato_code,
        region_id: rid,
      });
    }
  });
  return { regions, districts };
}
const SNAP = buildSnapshot();

/**
 * "Seed + rasmiy" snapshot: seed'da yo'q, lekin rasmiy SOATO ro'yxatida
 * (apps/logistics-service/src/data/sato-codes.ts) bor tumanlar qo'shiladi —
 * prod'da admin qo'shgan bo'lishi mumkin bo'lgan qatorlar (TAXMIN: prod DB
 * ko'rilmagan). Nom rasmiy ko'rinishda ("Zomin tumani", "Farg'ona shahri").
 */
function buildFullSnapshot(base: DistrictSnapshot): DistrictSnapshot {
  const regions = base.regions.map((r) => ({ ...r }));
  const districts = base.districts.map((d) => ({ ...d }));
  const have = new Set(districts.map((d) => d.sato_code));
  let did = 5000;
  for (const off of satoRegions) {
    const region = regions.find((r) => r.sato_code === off.sato_code);
    if (!region) continue;
    for (const d of off.districts) {
      if (have.has(d.sato_code)) continue;
      did += 1;
      districts.push({
        id: String(did),
        name: d.name,
        sato_code: d.sato_code,
        region_id: region.id,
      });
    }
  }
  return { regions, districts };
}
const SNAP_FULL = buildFullSnapshot(SNAP);
const districtById = new Map(SNAP_FULL.districts.map((d) => [d.id, d]));
const regionById = new Map(SNAP.regions.map((r) => [r.id, r]));
const satoById = (id: string | null | undefined): string | null =>
  id ? (districtById.get(id)?.sato_code ?? null) : null;
const regionSatoById = (id: string | null | undefined): string | null =>
  id ? (regionById.get(id)?.sato_code ?? null) : null;
const nameBySato = (sato: string | null): string =>
  sato
    ? (SNAP_FULL.districts.find((d) => d.sato_code === sato)?.name.trim() ??
      `?${sato}`)
    : '-';
const satoByRegionAndName = new Map(
  SNAP.districts.map((d) => [
    `${regionById.get(d.region_id)!.name.trim()}|${d.name.trim()}`,
    d.sato_code,
  ]),
);

/** `logistics.district.find_all` javobi shakli (districtRowsOf o'qiydi). */
const FIND_ALL_ROWS = SNAP.districts.map((d) => {
  const r = regionById.get(d.region_id)!;
  return {
    id: d.id,
    name: d.name,
    sato_code: d.sato_code,
    region_id: d.region_id,
    region: { id: r.id, name: r.name, sato_code: r.sato_code },
    isDeleted: false,
  };
});

// ─────────────────────────── Mock RPC mijozlari ───────────────────────────
const logisticsClient = {
  send: (pattern: { cmd: string }, payload: { items?: unknown[] }) => {
    if (pattern.cmd === 'logistics.district.resolve_by_text') {
      return of({
        statusCode: 200,
        message: 'success',
        data: (payload.items ?? []).map((q) =>
          resolveDistrictText(q as never, SNAP, () => undefined),
        ),
      });
    }
    if (pattern.cmd === 'logistics.district.find_all') {
      return of({ statusCode: 200, data: FIND_ALL_ROWS });
    }
    throw new Error(`unexpected logistics cmd ${pattern.cmd}`);
  },
};
const identityClient = {
  send: () => of({ statusCode: 200, data: { default_tariff: 'center' } }),
};
const catalogClient = {
  send: () =>
    of({ data: [{ id: '11', name: 'Atir', user_id: '121' }], total: 1 }),
};

/** LLM o'rniga: hech narsa tanlamaydi, modelga ketadigan so'rovni yozadi. */
class RecordingPicker implements DistrictPicker {
  last: AiDistrictPickRequest | null = null;
  pick(req: AiDistrictPickRequest): Promise<DistrictPicks | null> {
    this.last = req;
    return Promise.resolve(null);
  }
}

function makeService(picker: RecordingPicker): AiPreviewService {
  const resolver = new ProductResolverService(
    catalogClient as unknown as ClientProxy,
    { pick: () => Promise.resolve(null) },
  );
  const fallback = new DistrictLlmFallbackService(
    logisticsClient as unknown as ClientProxy,
    picker,
  );
  return new AiPreviewService(
    resolver,
    logisticsClient as unknown as ClientProxy,
    identityClient as unknown as ClientProxy,
    { prunePattern: () => Promise.resolve(0) } as unknown as IdempotencyService,
    fallback,
  );
}

const BASE_RAW = {
  customer_name: 'Test Mijoz',
  phone_number: '+998901234567',
  extra_number: null,
  region_name: null,
  district_name: null,
  address: null,
  full_address: null,
  items: [{ name: 'Atir', quantity: 1 }],
  total_price: 150000,
  comment: null,
  where_deliver: null,
  is_replacement: false,
  operator: null,
  warnings: [],
};

async function preview(
  over: Record<string, unknown>,
): Promise<{ p: AiOrderPreview; picker: RecordingPicker }> {
  const picker = new RecordingPicker();
  const svc = makeService(picker);
  // Model chiqishi → ai-service sanitize (haqiqiy) → order-service preview.
  const sanitized = sanitizeExtraction({ orders: [{ ...BASE_RAW, ...over }] });
  const { previews } = await svc.resolve({
    raw_orders: sanitized as never,
    market_id: '121',
    requester: { id: '7', roles: ['market'] },
    request_id: 'r',
    trace_id: 't',
    draft_id: 'd',
    deadline_at: Date.now() + 25_000,
  } as never);
  svc.onModuleDestroy();
  return { p: previews[0], picker };
}

// ─────────────────────────── Tasniflash ───────────────────────────
type Outcome =
  | 'PASS'
  | 'WRONG_AUTO' // jimgina NOTO'G'RI tuman tanlandi (eng xavfli)
  | 'MISS_CANDIDATES' // nomzodlar bor, to'g'risi yo'q
  | 'ASK_SHOULD_AUTO' // to'g'ri nomzod bor, lekin operator tanlashi kerak
  | 'UNRESOLVED' // na tuman, na nomzod → LLM fallback'ga
  | 'AUTO_GUESS'; // 'ask' holatida taxmin bilan avto-tanlov

interface DistrictResult {
  id: string;
  group: string;
  note: string;
  input: DistrictCase['input'];
  expect: DistrictCase['expect'] & { names?: string[] };
  resolver: {
    district: string | null;
    district_sato: string | null;
    region_sato: string | null;
    candidates: string[];
    reason: string | null;
  };
  preview: {
    district_sato: string | null;
    region_sato: string | null;
    candidates: string[];
    issues: string[];
  };
  llm_fallback: {
    called: boolean;
    pool_size: number | null;
    region_locked_pool: boolean | null;
    expected_in_pool: boolean | null;
  };
  outcome: Outcome;
  region_ok: boolean | null;
  /** "Seed + rasmiy" snapshotdagi natija (faqat rezolver). */
  full: {
    district: string | null;
    district_sato: string | null;
    candidates: string[];
    reason: string | null;
    outcome: Outcome;
  };
}

function classify(c: DistrictCase, res: DistrictTextResolution): Outcome {
  const auto = satoById(res.district_id);
  const cands = (res.candidates ?? []).map((x) => satoById(x.id));
  const want = c.expect.satos ?? [];
  if (c.expect.mode === 'auto') {
    if (auto && want.includes(auto)) return 'PASS';
    if (auto) return 'WRONG_AUTO';
    if (cands.length && cands.some((s) => s && want.includes(s)))
      return 'ASK_SHOULD_AUTO';
    if (cands.length) return 'MISS_CANDIDATES';
    return 'UNRESOLVED';
  }
  if (c.expect.mode === 'ask') {
    if (auto && want.includes(auto)) return 'AUTO_GUESS';
    if (auto) return 'WRONG_AUTO';
    if (cands.length && want.every((s) => cands.includes(s))) return 'PASS';
    if (cands.length) return 'MISS_CANDIDATES';
    return 'UNRESOLVED';
  }
  // not_in_db: avto-tanlov bo'lmasa — to'g'ri.
  if (auto) return 'WRONG_AUTO';
  return 'PASS';
}

const OUT = process.env.AI_REPRO_OUT;

/**
 * Faqat ma'lumot (seed/prod qatori) tuzatilganda hal bo'ladigan holatlar —
 * ular uchun avto-tanlov YO'Qligi talab qilinadi (`ASK_SHOULD_AUTO` qabul).
 * D10/D24: bazada 1710224 TUMAN qatori "Karshi" deb nomlangan, rus tilidagi
 * "Карши"/"Karshi" esa odatda Qarshi SHAHRI — qator "Qarshi tumani" ga
 * qayta nomlanguncha ikkalasi nomzod (docs/ai/DISTRICT_GAP_D1.md).
 */
const KNOWN_DATA_GAPS: ReadonlySet<string> = new Set(['D10', 'D24']);

describe('AI buyurtma — deterministik qatlam reproduktsiyasi', () => {
  const districtResults: DistrictResult[] = [];
  const regionResults: unknown[] = [];
  const phoneMaskResults: unknown[] = [];
  const phoneNormResults: unknown[] = [];
  const amountMaskResults: unknown[] = [];
  const amountModelResults: unknown[] = [];

  beforeAll(async () => {
    // ── Tumanlar ──
    for (const c of DISTRICT_CASES) {
      const res = resolveDistrictText(c.input as never, SNAP, () => undefined);
      const outcome = classify(c, res);
      const { p, picker } = await preview(c.input);
      const item = picker.last?.items?.[0];
      let expectedInPool: boolean | null = null;
      if (item && c.expect.satos?.length) {
        const poolSatos = item.pool.map((e) =>
          satoByRegionAndName.get(
            `${e.region_name.trim()}|${e.district_name.trim()}`,
          ),
        );
        expectedInPool = c.expect.satos.some((s) => poolSatos.includes(s));
      }
      const resolvedRegionSato = regionSatoById(res.region_id) ?? null;
      const resFull = resolveDistrictText(
        c.input as never,
        SNAP_FULL,
        () => undefined,
      );
      const cFull: DistrictCase = c.expect.officialSato
        ? {
            ...c,
            expect: {
              ...c.expect,
              mode: 'auto',
              satos: [c.expect.officialSato],
            },
          }
        : c;
      districtResults.push({
        id: c.id,
        group: c.group,
        note: c.note,
        input: c.input,
        expect: {
          ...c.expect,
          names: (c.expect.satos ?? []).map(nameBySato),
        },
        resolver: {
          district: res.district_name ?? null,
          district_sato: satoById(res.district_id),
          region_sato: resolvedRegionSato,
          candidates: (res.candidates ?? []).map(
            (x) => `${nameBySato(satoById(x.id))} (${satoById(x.id)})`,
          ),
          reason: res.reason ?? null,
        },
        preview: {
          district_sato: satoById(p.district_id),
          region_sato: regionSatoById(p.region_id),
          candidates: p.district_candidates.map((x) => satoById(x.id) ?? '?'),
          issues: p.issues,
        },
        llm_fallback: {
          called: !!item,
          pool_size: item ? item.pool.length : null,
          region_locked_pool: item ? !!res.region_id : null,
          expected_in_pool: expectedInPool,
        },
        outcome,
        region_ok: c.expect.regionSato
          ? (regionSatoById(p.region_id) ?? resolvedRegionSato) ===
            c.expect.regionSato
          : null,
        full: {
          district: resFull.district_name ?? null,
          district_sato: satoById(resFull.district_id),
          candidates: (resFull.candidates ?? []).map(
            (x) => `${nameBySato(satoById(x.id))} (${satoById(x.id)})`,
          ),
          reason: resFull.reason ?? null,
          outcome: classify(cFull, resFull),
        },
      });
    }

    // ── Viloyat aliaslari ──
    for (const c of REGION_CASES) {
      const got = regionAlias(c.input);
      regionResults.push({
        ...c,
        got,
        base: normGeo(c.input),
        outcome: got === c.expect ? 'PASS' : got === null ? 'NULL' : 'WRONG',
      });
    }

    // ── Telefon maskalash ──
    for (const c of PHONE_MASK_CASES) {
      const { masked, tokens } = maskPhones(c.text);
      const phones = [...tokens.values()];
      const keepOk = (c.keep ?? []).every((k) => masked.includes(k));
      const ok = JSON.stringify(phones) === JSON.stringify(c.phones) && keepOk;
      phoneMaskResults.push({
        id: c.id,
        note: c.note ?? '',
        tokens: tokens.size,
        phones_ok: JSON.stringify(phones) === JSON.stringify(c.phones),
        keep_ok: keepOk,
        // PII: haqiqiy matn chiqmaydi — sintetik; maskalangan ko'rinish.
        masked,
        outcome: ok ? 'PASS' : 'FAIL',
      });
    }
    // Model ikki tokenni bitta maydonga yozsa (unmask → normalize).
    {
      const { tokens } = maskPhones('90 123 45 67, 91 765 43 21');
      const restored = unmaskPhones(
        { phone_number: '[TEL_1], [TEL_2]' },
        tokens,
      ).phone_number;
      const { p } = await preview({ phone_number: restored });
      phoneNormResults.push({
        id: 'N09',
        note: 'model ikki tokenni bitta phone_number ga yozgan',
        input: '[TEL_1], [TEL_2] → unmask',
        got_preview_phone_valid: !p.issues.includes('phone_invalid'),
        issues: p.issues,
        outcome: p.issues.includes('phone_invalid') ? 'FLAGGED' : 'SILENT',
      });
    }
    for (const c of PHONE_NORM_CASES) {
      const got = normalizeUzPhone(c.input);
      phoneNormResults.push({
        ...c,
        got,
        outcome: got === c.expect ? 'PASS' : 'FAIL',
      });
    }

    // ── Narx: maskalash xavfsizligi ──
    for (const c of AMOUNT_MASK_CASES) {
      const { masked, tokens } = maskPhones(c.text);
      const keepOk = c.keep.every((k) => masked.includes(k));
      amountMaskResults.push({
        ...c,
        masked,
        tokens: tokens.size,
        outcome: keepOk && tokens.size === c.phones ? 'PASS' : 'FAIL',
      });
    }

    // ── Narx: model qiymati → sanitize → preview ──
    for (const c of AMOUNT_MODEL_CASES) {
      const { p } = await preview({
        region_name: 'Andijon',
        district_name: 'Asaka',
        total_price: c.model,
      });
      const flagged =
        p.issues.includes('price_confirm') ||
        p.issues.includes('price_missing');
      let outcome: string;
      if (c.intended === null) {
        outcome =
          p.total_price === null
            ? 'PASS'
            : flagged
              ? 'FLAGGED'
              : 'SILENT_WRONG';
      } else {
        outcome =
          p.total_price === c.intended
            ? 'PASS'
            : flagged
              ? 'FLAGGED'
              : 'SILENT_WRONG';
      }
      amountModelResults.push({
        ...c,
        preview_total: p.total_price,
        issues: p.issues.filter((i) => i.startsWith('price')),
        ready: p.ready,
        outcome,
      });
    }

    if (OUT) {
      mkdirSync(OUT, { recursive: true });
      writeFileSync(
        join(OUT, 'results.json'),
        JSON.stringify(
          {
            generated_at: new Date().toISOString(),
            snapshot: {
              source:
                'apps/logistics-service/src/data/regions-districts.data.ts',
              regions: SNAP.regions.length,
              districts: SNAP.districts.length,
            },
            districts: districtResults,
            regions: regionResults,
            phone_mask: phoneMaskResults,
            phone_norm: phoneNormResults,
            amount_mask: amountMaskResults,
            amount_model: amountModelResults,
          },
          null,
          2,
        ),
      );
    }
  });

  it("natijalar yig'ildi", () => {
    expect(districtResults.length).toBe(DISTRICT_CASES.length);
  });

  describe('regressiya (D2–D5)', () => {
    it.each(DISTRICT_CASES.map((c) => [c.id, c]))('tuman %s', (_id, c) => {
      const r = districtResults.find((x) => x.id === (c as DistrictCase).id)!;
      if (KNOWN_DATA_GAPS.has(r.id)) {
        expect(['PASS', 'ASK_SHOULD_AUTO']).toContain(r.outcome);
      } else {
        expect(r.outcome).toBe('PASS');
      }
      if (r.region_ok !== null) expect(r.region_ok).toBe(true);
    });
    it('“seed + rasmiy” snapshotda ham jimgina NOTO‘G‘RI tanlov yo‘q', () => {
      expect(
        districtResults
          .filter((r) => r.full.outcome === 'WRONG_AUTO')
          .map((r) => r.id),
      ).toEqual([]);
    });
    it.each(REGION_CASES.map((c) => [c.id, c]))('viloyat %s', (_id, c) => {
      expect(regionAlias((c as { input: string }).input)).toBe(
        (c as { expect: string | null }).expect,
      );
    });
  });
});
