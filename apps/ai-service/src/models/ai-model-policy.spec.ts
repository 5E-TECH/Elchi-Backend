import { AI_MODEL_DEFAULTS, aiValidationSchema } from '@app/common';
import {
  AI_MODEL_PRICES,
  normalizeModelId,
  priceFor,
} from '../usage/ai-pricing';
import {
  AI_STRONG_EXTRACTION_MODELS,
  evaluateModelPolicy,
  modelPolicyProblems,
} from './ai-model-policy';

/**
 * LP3RKvXY — model konfiguratsiyasi qulfi.
 * TC3 (zaif model → ERROR + status belgisi), TC4 (classify sukuti arzon),
 * TC12 (narx jadvali har sukut/ruxsat etilgan modelni taniydi).
 */
describe('evaluateModelPolicy (LP3RKvXY TC3)', () => {
  const ok = {
    order: 'claude-sonnet-5',
    vision: 'claude-sonnet-5',
    classify: 'claude-haiku-4-5',
  };

  it("sukut modellar → ok:true, ERROR yo'q", () => {
    const policy = evaluateModelPolicy(ok);
    expect(policy).toEqual({
      ok: true,
      order: 'ok',
      vision: 'ok',
      classify: 'ok',
    });
    expect(modelPolicyProblems(ok, policy)).toEqual([]);
  });

  it.each(['claude-opus-5', 'claude-fable-5', 'claude-sonnet-5-20260801'])(
    '%s — kuchli ekstraksiya modeli (ok)',
    (model) => {
      expect(evaluateModelPolicy({ ...ok, order: model }).order).toBe('ok');
    },
  );

  it("AI_ORDER_MODEL=haiku → order:'weak', ok:false, ERROR matnida env nomi", () => {
    const models = { ...ok, order: 'claude-haiku-4-5' };
    const policy = evaluateModelPolicy(models);
    expect(policy.ok).toBe(false);
    expect(policy.order).toBe('weak');
    const problems = modelPolicyProblems(models, policy);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('ai_model_downgrade');
    expect(problems[0]).toContain('AI_ORDER_MODEL=claude-haiku-4-5');
  });

  it("prod'dagi claude-sonnet-4-6 → narx jadvalida bor, lekin 'weak' (ok:false, ERROR)", () => {
    const models = { ...ok, order: 'claude-sonnet-4-6' };
    const policy = evaluateModelPolicy(models);
    expect(policy).toMatchObject({ ok: false, order: 'weak' });
    expect(modelPolicyProblems(models, policy)[0]).toContain(
      'AI_ORDER_MODEL=claude-sonnet-4-6',
    );
  });

  it("AI_ORDER_VISION_MODEL=haiku ham ushlanadi (rasm yo'li)", () => {
    const models = { ...ok, vision: 'claude-haiku-4-5-20251001' };
    const policy = evaluateModelPolicy(models);
    expect(policy).toMatchObject({ ok: false, vision: 'weak' });
    expect(modelPolicyProblems(models, policy)[0]).toContain(
      'AI_ORDER_VISION_MODEL',
    );
  });

  it("xato yozilgan nom → 'unknown' (narx jadvalida yo'q)", () => {
    const models = {
      ...ok,
      order: 'claude-sonet-5',
      classify: 'claude-haiku-45',
    };
    const policy = evaluateModelPolicy(models);
    expect(policy).toEqual({
      ok: false,
      order: 'unknown',
      vision: 'ok',
      classify: 'unknown',
    });
    const problems = modelPolicyProblems(models, policy);
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toContain('ai_model_unknown');
  });

  it('classify uchun arzon model QONUNIY (weak emas)', () => {
    expect(evaluateModelPolicy(ok).classify).toBe('ok');
  });
});

describe('model sukutlari va narx jadvali (LP3RKvXY TC4, TC12)', () => {
  const env = {
    POSTGRES_URI: 'postgres://x',
    RABBITMQ_URI: 'amqp://x',
    RABBITMQ_NOTIFICATION_QUEUE: 'n',
  };

  it('TC4: AI_CLASSIFY_MODEL sukuti — arzon model (haiku), ekstraksiya — kuchli', () => {
    const { value } = aiValidationSchema.validate(env, { allowUnknown: true });
    const v = value as Record<string, string>;
    expect(normalizeModelId(v.AI_CLASSIFY_MODEL)).toBe('haiku-4-5');
    expect(
      AI_STRONG_EXTRACTION_MODELS.has(normalizeModelId(v.AI_ORDER_MODEL)),
    ).toBe(true);
    expect(
      AI_STRONG_EXTRACTION_MODELS.has(
        normalizeModelId(v.AI_ORDER_VISION_MODEL),
      ),
    ).toBe(true);
    // classify ekstraksiyadan ARZON (kirish narxi bo'yicha).
    expect(priceFor(v.AI_CLASSIFY_MODEL).in).toBeLessThan(
      priceFor(v.AI_ORDER_MODEL).in,
    );
  });

  it('TC12: har sukut va har ruxsat etilgan model narx jadvalida BOR (noma’lum emas)', () => {
    const names = [
      ...Object.values(AI_MODEL_DEFAULTS),
      ...[...AI_STRONG_EXTRACTION_MODELS].map((k) => `claude-${k}`),
    ];
    for (const name of names) {
      expect(
        Object.prototype.hasOwnProperty.call(
          AI_MODEL_PRICES,
          normalizeModelId(name),
        ),
      ).toBe(true);
    }
  });

  it('TC12: Joi sukutlari AI_MODEL_DEFAULTS bilan bir xil (ikki manba ajralmasin)', () => {
    const { value } = aiValidationSchema.validate(env, { allowUnknown: true });
    const v = value as Record<string, string>;
    expect(v.AI_ORDER_MODEL).toBe(AI_MODEL_DEFAULTS.order);
    expect(v.AI_ORDER_VISION_MODEL).toBe(AI_MODEL_DEFAULTS.vision);
    expect(v.AI_CLASSIFY_MODEL).toBe(AI_MODEL_DEFAULTS.classify);
  });
});
