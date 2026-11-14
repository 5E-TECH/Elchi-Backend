import { Logger } from '@nestjs/common';
import {
  AI_MODEL_CACHE_MIN_TOKENS,
  AI_MODEL_PRICES,
  cacheMinTokensFor,
  cacheReadMultiplierFor,
  computeCacheSavedUsd,
  assistantEffortParam,
  effortParam,
  supportsEffort,
  computeCostUsd,
  normalizeModelId,
  priceFor,
  roundMoney2,
  roundUsd,
  type AiTokenUsage,
} from './ai-pricing';

const M = 1_000_000;

function usage(over: Partial<AiTokenUsage> = {}): AiTokenUsage {
  return {
    model: 'claude-sonnet-5',
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    ...over,
  };
}

describe('ai-pricing (lYVuADRE 5-band)', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('narx map kartadagi (opus-5 5/25, sonnet-5 3/15, haiku-4-5 1/5, fable-5 10/50) + prod modeli sonnet-4-6 3/15', () => {
    expect(AI_MODEL_PRICES).toEqual({
      'opus-5-5': { in: 4, out: 20 },
      'sonnet-5-5': { in: 2, out: 10 },
      'haiku-5-5': { in: 0.1, out: 0.5 },
      'opus-5': { in: 5, out: 25 },
      'sonnet-5': { in: 3, out: 15 },
      'sonnet-4-6': { in: 3, out: 15 },
      'haiku-4-5': { in: 1, out: 5 },
      'fable-5': { in: 10, out: 50 },
    });
  });

  it('5Z1ZvvzE: minimal kesh prefiksi — har narxli model uchun bor (haiku-4-5 4096, sonnet 1024, opus/fable 512)', () => {
    expect(Object.keys(AI_MODEL_CACHE_MIN_TOKENS).sort()).toEqual(
      Object.keys(AI_MODEL_PRICES).sort(),
    );
    expect(AI_MODEL_CACHE_MIN_TOKENS).toEqual({
      'opus-5-5': 512,
      'sonnet-5-5': 512,
      'haiku-5-5': 512,
      'opus-5': 512,
      'sonnet-5': 1024,
      'sonnet-4-6': 1024,
      'haiku-4-5': 4096,
      'fable-5': 512,
    });
    expect(cacheMinTokensFor('claude-haiku-4-5-20251001')).toBe(4096);
    expect(cacheMinTokensFor('claude-sonnet-5')).toBe(1024);
    expect(cacheMinTokensFor('claude-sonet-5')).toBeNull();
  });

  describe('M1: 5.5 avlodi', () => {
    it("noma'lum model tarifiga TUSHMAYDI (eng qimmat 10/50 emas)", () => {
      expect(priceFor('claude-sonnet-5-5')).toEqual({ in: 2, out: 10 });
      expect(priceFor('claude-opus-5-5')).toEqual({ in: 4, out: 20 });
      expect(priceFor('claude-haiku-5-5')).toEqual({ in: 0.1, out: 0.5 });
    });

    it("kesh o'qish: sonnet/opus 5.5 — 0.05×, qolganlar 0.1×", () => {
      expect(cacheReadMultiplierFor('claude-sonnet-5-5')).toBe(0.05);
      expect(cacheReadMultiplierFor('claude-opus-5-5')).toBe(0.05);
      expect(cacheReadMultiplierFor('claude-haiku-5-5')).toBe(0.1);
      expect(cacheReadMultiplierFor('claude-sonnet-5')).toBe(0.1);
      expect(cacheReadMultiplierFor('constructor')).toBe(0.1);
    });

    it('sonnet-5-5 xarajati: 1M in + 1M out + 1M write + 1M read = 2+10+2.5+0.1', () => {
      const u = usage({
        model: 'claude-sonnet-5-5',
        inputTokens: M,
        outputTokens: M,
        cacheCreationTokens: M,
        cacheReadTokens: M,
      });
      expect(computeCostUsd(u)).toBeCloseTo(14.6, 9);
      expect(computeCacheSavedUsd(u)).toBeCloseTo(1.9, 9);
    });

    it("haiku-5-5: 100K gacha 0.10/0.50; 100K dan oshsa BUTUN so'rov 0.50/2.50", () => {
      const small = usage({
        model: 'claude-haiku-5-5',
        inputTokens: 100_000,
        outputTokens: 1_000,
      });
      expect(computeCostUsd(small)).toBeCloseTo(
        (100_000 * 0.1 + 1_000 * 0.5) / M,
        12,
      );
      const big = usage({
        model: 'claude-haiku-5-5',
        inputTokens: 60_000,
        cacheReadTokens: 50_000,
        outputTokens: 1_000,
      });
      expect(computeCostUsd(big)).toBeCloseTo(
        (60_000 * 0.5 + 50_000 * 0.5 * 0.1 + 1_000 * 2.5) / M,
        12,
      );
      // Tejash ham uzun so'rov tarifida (0.10 emas, 0.50).
      expect(computeCacheSavedUsd(big)).toBeCloseTo(
        (50_000 * 0.5 * 0.9) / M,
        12,
      );
    });

    it("M2: effort 5.5 avlodiga va 5-avlodga yuboriladi, Haiku 4.5 / Sonnet 4.6 / noma'lumga yo'q", () => {
      for (const m of [
        'claude-sonnet-5-5',
        'claude-opus-5-5',
        'claude-haiku-5-5',
        'claude-sonnet-5',
        'claude-opus-5',
        'claude-fable-5',
      ]) {
        expect(supportsEffort(m)).toBe(true);
        expect(effortParam(m, 'low')).toEqual({ effort: 'low' });
      }
      for (const m of ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-x']) {
        expect(effortParam(m, 'low')).toEqual({});
      }
      // Yordamchi: dev xulqi — rad etmaydigan har modelga (Sonnet 4.6,
      // Opus 4.x, noma'lum ham) yuboriladi; faqat Haiku 4.5 ga yo'q.
      for (const m of [
        'claude-sonnet-4-6',
        'claude-opus-4-8',
        'claude-sonnet-5-5',
      ]) {
        expect(assistantEffortParam(m, 'medium')).toEqual({ effort: 'medium' });
      }
      expect(assistantEffortParam('claude-haiku-4-5-20251001', 'low')).toEqual(
        {},
      );
    });
  });

  describe('normalizeModelId', () => {
    it.each([
      ['claude-sonnet-5', 'sonnet-5'],
      ['claude-haiku-4-5', 'haiku-4-5'],
      ['claude-haiku-4-5-20251001', 'haiku-4-5'],
      ['claude-opus-5-20260101', 'opus-5'],
      ['  Claude-Fable-5 ', 'fable-5'],
      ['sonnet-5', 'sonnet-5'],
    ])('%s → %s', (input, expected) => {
      expect(normalizeModelId(input)).toBe(expected);
    });
  });

  it('#6: haiku-4-5 uchun 1M input = $1 (1M output = $5)', () => {
    expect(
      computeCostUsd(usage({ model: 'claude-haiku-4-5', inputTokens: M })),
    ).toBe(1);
    expect(
      computeCostUsd(usage({ model: 'claude-haiku-4-5', outputTokens: M })),
    ).toBe(5);
    expect(
      computeCostUsd(
        usage({ model: 'claude-haiku-4-5-20251001', inputTokens: M }),
      ),
    ).toBe(1);
  });

  it('#6/#20: noma`lum model — ENG QIMMAT tarif (10/50) va WARN (bir marta)', () => {
    const model = 'claude-mystery-9-test-a';
    expect(priceFor(model)).toEqual({ in: 10, out: 50 });
    expect(computeCostUsd(usage({ model, inputTokens: M }))).toBe(10);
    expect(computeCostUsd(usage({ model, outputTokens: M }))).toBe(50);

    const warnings = (warn.mock.calls as unknown[][])
      .map((c) => String(c[0]))
      .filter((m) => m.includes('mystery-9-test-a'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('ai_unknown_model_price');
  });

  it('noma`lum model opus narxida EMAS (BeePost xatosi: fable-5 kam hisoblanardi)', () => {
    const cost = computeCostUsd(
      usage({ model: 'claude-unknown-x-test-b', inputTokens: M }),
    );
    expect(cost).toBeGreaterThan(AI_MODEL_PRICES['opus-5'].in);
  });

  it('ma`lum model WARN bermaydi', () => {
    computeCostUsd(usage({ model: 'claude-sonnet-5', inputTokens: 10 }));
    expect(warn).not.toHaveBeenCalled();
  });

  it('#7/#19: cache_read 0.1× input narxida — keshsiz variantdan 10 barobar arzon', () => {
    const uncached = computeCostUsd(usage({ inputTokens: M }));
    const cached = computeCostUsd(usage({ cacheReadTokens: M }));
    expect(uncached).toBe(3);
    expect(cached).toBeCloseTo(0.3, 10);
    expect(cached).toBeLessThan(uncached / 5);
  });

  it('cache write 1.25× input narxida', () => {
    expect(computeCostUsd(usage({ cacheCreationTokens: M }))).toBeCloseTo(
      3.75,
      10,
    );
  });

  it('aralash tokenlar: in×input + out×output + 1.25×write + 0.1×read', () => {
    const cost = computeCostUsd(
      usage({
        inputTokens: 1234,
        outputTokens: 567,
        cacheCreationTokens: 4072,
        cacheReadTokens: 89,
      }),
    );
    const expected =
      (1234 * 3 + 567 * 15 + 4072 * 3 * 1.25 + 89 * 3 * 0.1) / 1e6;
    expect(cost).toBeCloseTo(expected, 12);
  });

  it('manfiy/NaN tokenlar 0 deb hisoblanadi', () => {
    expect(
      computeCostUsd(
        usage({
          inputTokens: -5,
          outputTokens: Number.NaN,
          cacheReadTokens: 0,
        }),
      ),
    ).toBe(0);
  });

  it('computeCacheSavedUsd = cache_read × in × 0.9 / 1M', () => {
    expect(
      computeCacheSavedUsd({ model: 'claude-sonnet-5', cacheReadTokens: M }),
    ).toBeCloseTo(2.7, 10);
    expect(
      computeCacheSavedUsd({ model: 'claude-haiku-4-5', cacheReadTokens: 0 }),
    ).toBe(0);
  });

  it('yaxlitlash: USD 6 kasr, so`m 2 kasr', () => {
    expect(roundUsd(0.0166984999)).toBe(0.016698);
    expect(roundMoney2(213.7344)).toBe(213.73);
    expect(roundUsd(Number.NaN)).toBe(0);
  });
});
