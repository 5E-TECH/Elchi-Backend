import * as Joi from 'joi';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiValidationSchema } from './index';

/** be-brief §7 — «AI kalit va modellar» env kalitlari. Hamma qiymat soxta. */
const OPTS: Joi.ValidationOptions = { abortEarly: false, allowUnknown: true };
const BASE = {
  POSTGRES_URI: 'postgres://x',
  RABBITMQ_URI: 'amqp://x',
  RABBITMQ_NOTIFICATION_QUEUE: 'n',
};
const validate = (env: Record<string, unknown>) => {
  const r = aiValidationSchema.validate({ ...BASE, ...env }, OPTS);
  return { error: r.error, value: r.value as Record<string, unknown> };
};

const dir = mkdtempSync(join(tmpdir(), 'ai-master-'));
const STRONG = 'Q7v9zK2pL4mX8nB1cR6tY3wE5uI0oP-aSdFgHjKl';
const goodFile = join(dir, 'good');
const shortFile = join(dir, 'short');
const weakFile = join(dir, 'weak');
writeFileSync(goodFile, `${STRONG}\n`);
writeFileSync(shortFile, 'Q7v9zK2pL4mX8nB1');
writeFileSync(weakFile, 'a'.repeat(48));

describe('aiValidationSchema — AI kalit/model sozlamasi', () => {
  it('sukutlar: UI o‘chiq, strict, step-up, ceiling 25, navbat nomi', () => {
    const { error, value } = validate({});
    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      AI_CONFIG_UI_ENABLED: false,
      AI_MODEL_POLICY_STRICT: true,
      AI_CONFIG_STEP_UP_REQUIRED: true,
      AI_CONFIG_WRITER_IDS: '',
      AI_UI_MAX_OUTPUT_PRICE_USD: 25,
      RABBITMQ_AI_CONFIG_QUEUE: 'ai_config_queue',
    });
  });

  it('staging: UI yoqiq, strict o‘chiq, step-up o‘chiq mumkin', () => {
    const { error, value } = validate({
      APP_ENV: 'staging',
      AI_CONFIG_UI_ENABLED: 'true',
      AI_MODEL_POLICY_STRICT: 'false',
      AI_CONFIG_STEP_UP_REQUIRED: 'false',
      AI_CONFIG_WRITER_IDS: '12, 34',
    });
    expect(error).toBeUndefined();
    expect(value.AI_CONFIG_UI_ENABLED).toBe(true);
    expect(value.AI_MODEL_POLICY_STRICT).toBe(false);
  });

  it('prod + UI yoqiq + step-up o‘chiq → boot yiqiladi (D14, AC17)', () => {
    const { error } = validate({
      APP_ENV: 'production',
      AI_CONFIG_UI_ENABLED: 'true',
      AI_CONFIG_STEP_UP_REQUIRED: 'false',
    });
    expect(error?.message).toContain('AI_CONFIG_STEP_UP_REQUIRED');
    // UI o'chiq bo'lsa prod'da ham false mumkin.
    expect(
      validate({
        APP_ENV: 'production',
        AI_CONFIG_STEP_UP_REQUIRED: 'false',
      }).error,
    ).toBeUndefined();
  });

  it('ANTHROPIC_BASE_URL berilsa — boot yiqiladi (AC17)', () => {
    const { error } = validate({ ANTHROPIC_BASE_URL: 'https://evil.example' });
    expect(error?.message).toContain('ANTHROPIC_BASE_URL');
    expect(error?.message).not.toContain('evil.example');
  });

  it('master sir fayli: yaxshi o‘tadi; yo‘q/qisqa/kuchsiz — xato, mazmun va yo‘l xabarda yo‘q', () => {
    expect(
      validate({ AI_KEY_ENCRYPTION_SECRET_FILE: goodFile }).error,
    ).toBeUndefined();
    for (const [file, re] of [
      [join(dir, 'missing'), /o'qib/],
      [shortFile, /qisqa/],
      [weakFile, /kuchsiz/],
    ] as const) {
      const { error } = validate({
        AI_KEY_ENCRYPTION_SECRET_PREVIOUS_FILE: file,
      });
      expect(error?.message).toMatch(re);
      expect(error?.message).toContain(
        'AI_KEY_ENCRYPTION_SECRET_PREVIOUS_FILE',
      );
      expect(error?.message).not.toContain(dir);
      expect(error?.message).not.toContain('Q7v9zK2pL4mX8nB1');
    }
  });

  it('oddiy env master sir faqat development’da', () => {
    expect(
      validate({ APP_ENV: 'development', AI_KEY_ENCRYPTION_SECRET: STRONG })
        .error,
    ).toBeUndefined();
    for (const appEnv of ['production', 'staging']) {
      const { error } = validate({
        APP_ENV: appEnv,
        AI_KEY_ENCRYPTION_SECRET: STRONG,
      });
      expect(error?.message).toContain('AI_KEY_ENCRYPTION_SECRET');
      expect(error?.message).not.toContain(STRONG);
    }
  });

  it('AI_CONFIG_WRITER_IDS formati', () => {
    expect(validate({ AI_CONFIG_WRITER_IDS: 'a1,b-2' }).error).toBeUndefined();
    expect(validate({ AI_CONFIG_WRITER_IDS: 'a; b' }).error).toBeDefined();
  });
});
