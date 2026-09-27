import { Logger } from '@nestjs/common';
import {
  AI_MODEL_PRICES,
  computeCacheSavedUsd,
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

  it('narx map aynan kartadagi: opus-5 5/25, sonnet-5 3/15, haiku-4-5 1/5, fable-5 10/50', () => {
    expect(AI_MODEL_PRICES).toEqual({
      'opus-5': { in: 5, out: 25 },
      'sonnet-5': { in: 3, out: 15 },
      'haiku-4-5': { in: 1, out: 5 },
      'fable-5': { in: 10, out: 50 },
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
