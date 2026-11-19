import {
  AI_KEY_SCRUB_REPLACEMENT,
  checkAiFreeText,
  checkAiKeyFormat,
  fingerprintOf,
  formatAiKeyHint,
  hintOf,
  keyTailOf,
  looksLikeAiKey,
  scrubAiKeys,
  scrubAiKeysDeep,
} from './ai-key-format';
import { defaultAnthropicClientFactory } from './claude.service';

/**
 * be-brief D8/D9, spec §4.1/§4.6. ⚠️ Shu jadval FE
 * (`src/entities/ai-config/validation.ts` testi) bilan AYNAN bir xil
 * bo'lishi kerak. Hamma kalit soxta.
 */
const X40 = 'x'.repeat(40);
export const AI_KEY_FORMAT_TABLE: Array<[string, string, string | null]> = [
  ['oddiy api03', `sk-ant-api03-${X40}`, null],
  ['boshi/oxiri bo‘shliq trim', `  sk-ant-api03-${X40}\n`, null],
  ['_ va - ruxsat', `sk-ant-api03-ab_cd-${X40}`, null],
  ['api03 shart emas', `sk-ant-zz99-${X40}`, null],
  ['admin', `sk-ant-admin01-${X40}`, 'AI_KEY_ADMIN_KEY'],
  ['oat', `sk-ant-oat01-${X40}`, 'AI_KEY_OAUTH_TOKEN'],
  ['ort', `sk-ant-ort01-${X40}`, 'AI_KEY_OAUTH_TOKEN'],
  ['prefikssiz', `sk-proj-${X40}`, 'AI_KEY_FORMAT'],
  ['katta harf prefiks', `SK-ANT-api03-${X40}`, 'AI_KEY_FORMAT'],
  ['qisqa (39)', 'sk-ant-' + 'a'.repeat(32), 'AI_KEY_FORMAT'],
  ['aynan 40', 'sk-ant-' + 'a'.repeat(33), null],
  ['aynan 256', 'sk-ant-' + 'a'.repeat(249), null],
  ['257', 'sk-ant-' + 'a'.repeat(250), 'AI_KEY_FORMAT'],
  ['kirill o‘xshash harf', `sk-ant-api03-${'x'.repeat(39)}х`, 'AI_KEY_FORMAT'],
  ['ichida bo‘shliq', `sk-ant-api03-${X40} x`, 'AI_KEY_FORMAT'],
  ['ichida yangi qator', `sk-ant-api03-${X40}\nx`, 'AI_KEY_FORMAT'],
  ['nuqta', `sk-ant-api03.${X40}`, 'AI_KEY_FORMAT'],
  ['bo‘sh', '', 'AI_KEY_FORMAT'],
];

describe('checkAiKeyFormat (D8)', () => {
  it.each(AI_KEY_FORMAT_TABLE)('%s', (_name, input, code) => {
    const r = checkAiKeyFormat(input);
    if (code === null) {
      expect(r).toEqual({ ok: true, key: input.trim() });
    } else {
      expect(r).toEqual({ ok: false, code });
    }
  });

  it('satr bo‘lmagan qiymat — AI_KEY_FORMAT', () => {
    expect(checkAiKeyFormat(undefined)).toEqual({
      ok: false,
      code: 'AI_KEY_FORMAT',
    });
    expect(checkAiKeyFormat(123)).toEqual({ ok: false, code: 'AI_KEY_FORMAT' });
  });

  it('xato natijasida kalit qiymati yo‘q', () => {
    const r = checkAiKeyFormat(`sk-ant-admin01-${X40}`);
    expect(JSON.stringify(r)).not.toContain(X40);
  });
});

describe('hint / fingerprint (FE bilan bir xil vektorlar)', () => {
  const key = `sk-ant-api03-${X40}`;
  it('hint: sk-ant-…<oxirgi 4>', () => {
    expect(keyTailOf(key)).toBe('xxxx');
    expect(hintOf(key)).toBe('sk-ant-…xxxx');
    expect(hintOf(`sk-ant-api03-${'x'.repeat(36)}4f2a`)).toBe('sk-ant-…4f2a');
    expect(formatAiKeyHint('4f2a')).toBe('sk-ant-…4f2a');
  });
  it('fingerprint: SHA-256 12 hex, 4 tadan guruh, trim', () => {
    // sha256("sk-ant-api03-" + "x"*40) — FE testida ham shu qiymat.
    const fp = fingerprintOf(key);
    expect(fp).toMatch(/^[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}$/);
    expect(fingerprintOf(`  ${key}\n`)).toBe(fp);
    expect(fingerprintOf('abc')).toBe('ba78 16bf 8f01');
    expect(fp.length).toBeLessThanOrEqual(16);
  });
});

describe('erkin matn (D9)', () => {
  it.each([
    ['label', 'Staging, 2026-noyabr', true],
    ['label', "O'zbek ʻ ʼ (test) _ .", true],
    ['label', 'Кирилл 123', true],
    ['label', '', true],
    ['label', 'ab '.repeat(20), true], // 60 belgi
    ['label', 'ab '.repeat(20) + 'c', false], // 61
    ['label', '<b>x</b>', false],
    ['label', 'kalit sk-ant-abc', false],
    ['label', 'SK-ANT-', false],
    ['label', 'z'.repeat(40), false],
    ['reason', 'Narx arzonroq model', true],
    ['reason', 'ab', false],
    ['reason', `paste ${'A'.repeat(40)}`, false],
    ['reason', 'Sk-Ant- yozildi', false],
  ] as const)('%s %j → %s', (field, value, ok) => {
    const r = checkAiFreeText(field, value);
    expect(r.ok).toBe(ok);
    if (!r.ok) {
      expect(r).toEqual({ ok: false, field });
    }
  });

  it('label null/undefined — ok (sukut nom), reason null — xato', () => {
    expect(checkAiFreeText('label', undefined)).toEqual({
      ok: true,
      value: null,
    });
    expect(checkAiFreeText('reason', null)).toEqual({
      ok: false,
      field: 'reason',
    });
  });

  it('looksLikeAiKey: 39 belgi o‘tadi, 40 — yo‘q', () => {
    expect(looksLikeAiKey('a'.repeat(39))).toBe(false);
    expect(looksLikeAiKey('a'.repeat(40))).toBe(true);
  });
});

describe('scrubAiKeys / scrubAiKeysDeep', () => {
  const key = `sk-ant-api03-${X40}`;

  it('satr', () => {
    expect(scrubAiKeys(`a ${key} b`)).toBe(`a ${AI_KEY_SCRUB_REPLACEMENT} b`);
    expect(scrubAiKeys('sk-ant-short')).toBe('sk-ant-short');
  });

  it('kalit bo‘lmasa — aynan o‘sha obyekt (nusxa yo‘q)', () => {
    const o = { a: { b: ['x', 1, null] } };
    expect(scrubAiKeysDeep(o)).toBe(o);
  });

  it('chuqur ichki, massiv, Error, kiritma o‘zgarmaydi', () => {
    const err = new TypeError(`bad ${key}`);
    (err as unknown as { detail: string }).detail = key;
    const input = { l1: { l2: { l3: [{ v: key }] } }, err, n: 5 };
    const out = scrubAiKeysDeep(input);
    expect(JSON.stringify(out)).not.toContain(key);
    expect(out.l1.l2.l3[0].v).toBe(AI_KEY_SCRUB_REPLACEMENT);
    expect(out.err).toBeInstanceOf(TypeError);
    expect(out.err.message).toBe(`bad ${AI_KEY_SCRUB_REPLACEMENT}`);
    expect(String(out.err.stack)).not.toContain(key);
    expect((out.err as unknown as { detail: string }).detail).toBe(
      AI_KEY_SCRUB_REPLACEMENT,
    );
    expect(input.l1.l2.l3[0].v).toBe(key);
    expect(err.message).toContain(key);
  });

  it('siklik havola yiqitmaydi', () => {
    const a: Record<string, unknown> = { k: key };
    a.self = a;
    const out = scrubAiKeysDeep<Record<string, unknown>>(a);
    expect(out.k).toBe(AI_KEY_SCRUB_REPLACEMENT);
  });
});

describe('defaultAnthropicClientFactory (be-brief §7)', () => {
  it('baseURL mahkam, logLevel warn — ANTHROPIC_BASE_URL env e’tiborsiz', () => {
    const prev = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = 'https://evil.example';
    try {
      const c = defaultAnthropicClientFactory({
        apiKey: 'sk-ant-api03-' + 'x'.repeat(40),
        timeout: 1000,
        maxRetries: 0,
      }) as unknown as {
        baseURL: string;
        logLevel: string;
        maxRetries: number;
      };
      expect(c.baseURL).toBe('https://api.anthropic.com');
      expect(c.logLevel).toBe('warn');
      expect(c.maxRetries).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = prev;
    }
  });
});
