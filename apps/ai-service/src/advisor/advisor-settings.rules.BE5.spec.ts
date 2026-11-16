import { RpcException } from '@nestjs/microservices';
import {
  AI_ADVISOR_RULE_KEYS,
  AI_ADVISOR_RULE_LIMITS,
  aiAdvisorDefaultRules,
  publicErrorFields,
} from '@app/common';
import {
  changesToAudit,
  effectiveRules,
  parseSettingsPatch,
} from './advisor-settings.rules';

/** RpcException → gateway filtri ko'radigan ochiq maydonlar. */
function errorOf(fn: () => unknown): Record<string, unknown> {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(RpcException);
    const body = (err as RpcException).getError() as Record<string, unknown>;
    return { statusCode: body.statusCode, ...publicErrorFields(body) };
  }
  throw new Error('xato kutilgan edi');
}

describe('BE-5 advisor settings rules (sof mantiq)', () => {
  const defaults = aiAdvisorDefaultRules();

  it('sukutlar: shartnoma §7.6 + ega javoblari (Q1 severity, Q2 R7 telegram=false)', () => {
    expect(defaults.R1).toEqual({
      enabled: true,
      severity: 'warning',
      telegram: true,
      shortage_uzs: 50000,
      consecutive_negative: 3,
    });
    expect(defaults.R2).toMatchObject({
      severity: 'critical',
      balance_uzs: 2_000_000,
      growth_days: 3,
      no_handover_days: 3,
    });
    expect(defaults.R3).toMatchObject({
      severity: 'warning',
      mad_multiplier: 3,
    });
    expect(defaults.R4).toMatchObject({ days_without_payout: 7 });
    expect(defaults.R5).toMatchObject({
      balance_uzs: 5_000_000,
      days_without_transfer: 3,
    });
    expect(defaults.R6).toEqual({
      enabled: true,
      severity: 'critical',
      telegram: true,
    });
    expect(defaults.R7).toEqual({
      enabled: true,
      severity: 'critical',
      telegram: false,
    });
    expect(defaults.R8).toMatchObject({ severity: 'warning', ratio: 2 });
    const critical = AI_ADVISOR_RULE_KEYS.filter(
      (k) => defaults[k].severity === 'critical',
    );
    expect(critical).toEqual(['R2', 'R6', 'R7']);
  });

  it('limits: openapi misolidagi jadval bilan aynan', () => {
    expect(AI_ADVISOR_RULE_LIMITS.R1.consecutive_negative).toEqual({
      min: 2,
      max: 30,
      step: 1,
      unit: 'count',
      default: 3,
    });
    expect(AI_ADVISOR_RULE_LIMITS.R8.ratio).toEqual({
      min: 1.1,
      max: 10,
      step: 0.1,
      unit: 'multiplier',
      default: 2,
    });
    expect(AI_ADVISOR_RULE_LIMITS.R6).toEqual({});
    expect(AI_ADVISOR_RULE_LIMITS.R7).toEqual({});
  });

  it('effectiveRules: eski/buzuq saqlangan qiymat sukut bilan to‘ldiriladi, severity doim qotirilgan', () => {
    const rules = effectiveRules({
      R1: { shortage_uzs: 200000, severity: 'critical', junk: 1 },
      R2: { growth_days: 999 },
      R7: { telegram: true, enabled: 'yes' },
      R9: { enabled: false },
    });
    expect(rules.R1).toEqual({ ...defaults.R1, shortage_uzs: 200000 });
    expect(rules.R2.growth_days).toBe(3);
    expect(rules.R7).toEqual({
      enabled: true,
      severity: 'critical',
      telegram: true,
    });
    expect(effectiveRules(null)).toEqual(defaults);
  });

  it('to‘g‘ri PATCH: qisman, faqat o‘zgarganlar changes ga', () => {
    const out = parseSettingsPatch(
      {
        version: 4,
        rules: {
          R1: { shortage_uzs: 30000, consecutive_negative: 3 },
          R8: { enabled: false },
          R3: { mad_multiplier: 2.5 },
        },
      },
      defaults,
    );
    expect(out.version).toBe(4);
    expect(out.rules.R1.shortage_uzs).toBe(30000);
    expect(out.rules.R8.enabled).toBe(false);
    expect(out.rules.R3.mad_multiplier).toBe(2.5);
    expect(out.changes).toEqual([
      { field: 'rules.R1.shortage_uzs', old: 50000, new: 30000 },
      { field: 'rules.R8.enabled', old: true, new: false },
      { field: 'rules.R3.mad_multiplier', old: 3, new: 2.5 },
    ]);
    expect(defaults.R1.shortage_uzs).toBe(50000); // kirish o'zgarmaydi
    expect(changesToAudit(out.changes)).toEqual({
      old_value: {
        R1: { shortage_uzs: 50000 },
        R8: { enabled: true },
        R3: { mad_multiplier: 3 },
      },
      new_value: {
        R1: { shortage_uzs: 30000 },
        R8: { enabled: false },
        R3: { mad_multiplier: 2.5 },
      },
    });
  });

  it('R7 telegram o‘zgartiriladi (Q2 c)', () => {
    const out = parseSettingsPatch(
      { version: 1, rules: { R7: { telegram: true } } },
      defaults,
    );
    expect(out.changes).toEqual([
      { field: 'rules.R7.telegram', old: false, new: true },
    ]);
  });

  it.each([
    [{}, 'version'],
    [{ version: '4' }, 'version'],
    [{ version: 1.5 }, 'version'],
    [{ version: 0 }, 'version'],
    [null, 'version'],
    [{ version: 1, foo: 1 }, 'foo'],
    [{ version: 1, telegram: { enabled: false } }, 'telegram'],
    [{ version: 1, budget: { monthly_usd: 100 } }, 'budget'],
    [{ version: 1, schedule: { daily_time: '09:00' } }, 'schedule'],
    [{ version: 1, rules: [] }, 'rules'],
    [{ version: 1, rules: { R9: {} } }, 'rules.R9'],
    [{ version: 1, rules: { R1: 5 } }, 'rules.R1'],
    [
      { version: 1, rules: { R1: { severity: 'warning' } } },
      'rules.R1.severity',
    ],
    [
      { version: 1, rules: { R6: { shortage_uzs: 1 } } },
      'rules.R6.shortage_uzs',
    ],
    [{ version: 1, rules: { R2: { enabled: 'false' } } }, 'rules.R2.enabled'],
    [{ version: 1, rules: { R1: { toString: 5 } } }, 'rules.R1.toString'],
    [
      { version: 1, rules: JSON.parse('{"R1": {"__proto__": 5}}') as unknown },
      'rules.R1.__proto__',
    ],
    [
      { version: 1, rules: JSON.parse('{"__proto__": {}}') as unknown },
      'rules.__proto__',
    ],
  ])('400 AI_ADVISOR_INVALID_SETTING: %j → field %s', (patch, field) => {
    expect(errorOf(() => parseSettingsPatch(patch, defaults))).toEqual({
      statusCode: 400,
      code: 'AI_ADVISOR_INVALID_SETTING',
      field,
    });
  });

  it.each([
    [
      { R1: { consecutive_negative: 1 } },
      'rules.R1.consecutive_negative',
      2,
      30,
    ],
    [
      { R1: { consecutive_negative: 31 } },
      'rules.R1.consecutive_negative',
      2,
      30,
    ],
    [
      { R1: { consecutive_negative: 2.5 } },
      'rules.R1.consecutive_negative',
      2,
      30,
    ],
    [
      { R1: { shortage_uzs: '50000' } },
      'rules.R1.shortage_uzs',
      1,
      1_000_000_000,
    ],
    [{ R1: { shortage_uzs: 0 } }, 'rules.R1.shortage_uzs', 1, 1_000_000_000],
    [{ R2: { growth_days: 61 } }, 'rules.R2.growth_days', 1, 60],
    [{ R3: { mad_multiplier: 2.55 } }, 'rules.R3.mad_multiplier', 1, 10],
    [{ R8: { ratio: 1 } }, 'rules.R8.ratio', 1.1, 10],
    [{ R8: { ratio: null } }, 'rules.R8.ratio', 1.1, 10],
  ])('400 AI_ADVISOR_INVALID_RULE: %j', (rules, field, min, max) => {
    expect(
      errorOf(() => parseSettingsPatch({ version: 1, rules }, defaults)),
    ).toEqual({
      statusCode: 400,
      code: 'AI_ADVISOR_INVALID_RULE',
      field,
      min,
      max,
    });
  });

  it('hammasi yoki hech narsa: birinchi xatoda natija yo‘q', () => {
    expect(() =>
      parseSettingsPatch(
        {
          version: 1,
          rules: { R1: { shortage_uzs: 1000 }, R2: { growth_days: 0 } },
        },
        defaults,
      ),
    ).toThrow(RpcException);
    expect(defaults.R1.shortage_uzs).toBe(50000);
  });

  it('0.1 qadam: 1.1, 2.3, 9.9 qabul; float xatosi yutiladi', () => {
    for (const ratio of [1.1, 2.3, 9.9, 10]) {
      expect(
        parseSettingsPatch({ version: 1, rules: { R8: { ratio } } }, defaults)
          .rules.R8.ratio,
      ).toBe(ratio);
    }
  });

  it('telegram/budget/schedule: null — yo‘q deb qaraladi (400 emas)', () => {
    expect(
      parseSettingsPatch(
        { version: 2, telegram: null, budget: null, schedule: null },
        defaults,
      ).changes,
    ).toEqual([]);
  });
});
