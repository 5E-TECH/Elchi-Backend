import * as Joi from 'joi';
import {
  aiValidationSchema,
  gatewayValidationSchema,
  orderValidationSchema,
} from './index';

/**
 * AI env kalitlari (Joi) — cSUBv0tY #11, wFSMEIIy #15, bVeyEuIR #1.
 *
 * ⚠️ Har bir `validate` ConfigModule'ning AYNAN o'sha opsiyalari bilan
 * chaqiriladi (`@nestjs/config` sukuti: `abortEarly:false, allowUnknown:true`).
 * Barcha servislar bitta `.env.production` ni o'qiydi, shuning uchun begona
 * kalitlar boot'ni yiqitmasligi kerak — test ham shu shartda ishlashi SHART.
 */
const CONFIG_MODULE_OPTIONS: Joi.ValidationOptions = {
  abortEarly: false,
  allowUnknown: true,
};

const validate = (
  schema: Joi.ObjectSchema,
  env: Record<string, unknown>,
): { error?: Joi.ValidationError; value: Record<string, unknown> } => {
  const result = schema.validate(env, CONFIG_MODULE_OPTIONS);
  return {
    error: result.error,
    value: result.value as Record<string, unknown>,
  };
};

/** ai-service'ning minimal majburiy kalitlari. */
const AI_REQUIRED = {
  POSTGRES_URI: 'postgres://x',
  RABBITMQ_URI: 'amqp://x',
  RABBITMQ_NOTIFICATION_QUEUE: 'n',
};

/**
 * Gateway'ning majburiy kalitlari — `scripts/generate-openapi.ts` ENV_DEFAULTS
 * bilan bir xil (AI kalitlarisiz). ACCESS_TOKEN_KEY `strongKey` dan o'tadi.
 */
const GATEWAY_REQUIRED = {
  ACCESS_TOKEN_KEY:
    'f1e2d3c4b5a6978869504132a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4',
  ACCESS_TOKEN_TIME: '15m',
  RABBITMQ_URI: 'amqp://guest:guest@localhost:5672',
  RABBITMQ_IDENTITY_QUEUE: 'identity_queue',
  RABBITMQ_ORDER_QUEUE: 'order_queue',
  RABBITMQ_CATALOG_QUEUE: 'catalog_queue',
  RABBITMQ_LOGISTICS_QUEUE: 'logistics_queue',
  RABBITMQ_FINANCE_QUEUE: 'finance_queue',
  RABBITMQ_NOTIFICATION_QUEUE: 'notification_queue',
  RABBITMQ_INTEGRATION_QUEUE: 'integration_queue',
  RABBITMQ_ANALYTICS_QUEUE: 'analytics_queue',
  RABBITMQ_BRANCH_QUEUE: 'branch_queue',
  RABBITMQ_INVESTOR_QUEUE: 'investor_queue',
  RABBITMQ_FILE_QUEUE: 'file_queue',
  RABBITMQ_C2C_QUEUE: 'c2c_queue',
  RABBITMQ_SEARCH_QUEUE: 'search_queue',
};

const ORDER_REQUIRED = {
  POSTGRES_URI: 'postgres://x',
  RABBITMQ_URI: 'amqp://x',
  RABBITMQ_ORDER_QUEUE: 'order_queue',
  RABBITMQ_SEARCH_QUEUE: 'search_queue',
  RABBITMQ_IDENTITY_QUEUE: 'identity_queue',
  RABBITMQ_LOGISTICS_QUEUE: 'logistics_queue',
  RABBITMQ_CATALOG_QUEUE: 'catalog_queue',
  RABBITMQ_FILE_QUEUE: 'file_queue',
};

const schemaKeys = (schema: Joi.ObjectSchema): string[] =>
  Object.keys(
    (schema.describe() as { keys?: Record<string, unknown> }).keys ?? {},
  );

describe('aiValidationSchema', () => {
  it("faqat majburiy kalitlar bilan xatosiz o'tadi va barcha sukutlar qo'yiladi", () => {
    const { error, value } = validate(aiValidationSchema, AI_REQUIRED);

    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      DB_SCHEMA: 'ai_schema',
      RABBITMQ_AI_QUEUE: 'ai_queue',
      AI_ORDER_MODEL: 'claude-sonnet-5',
      AI_ORDER_VISION_MODEL: 'claude-sonnet-5',
      AI_CLASSIFY_MODEL: 'claude-haiku-4-5',
      AI_USD_UZS_RATE: 12800,
      AI_ORDER_PRICE_UZS: 300,
      AI_DAILY_USD_CAP: 50,
      AI_CAP_WARN_RATIO: 0.8,
      AI_CAP_RAISE_MAX_USD: 50,
      AI_RMQ_PREFETCH: 8,
    });
  });

  describe('ANTHROPIC_API_KEY (cSUBv0tY #11, bVeyEuIR #1)', () => {
    it("berilmasa boot muvaffaqiyatli (AI o'chiq)", () => {
      const { error, value } = validate(aiValidationSchema, AI_REQUIRED);
      expect(error).toBeUndefined();
      expect(value.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it.each([
      ['', ''],
      ['   ', ''],
      ['sk-ant-api03-abc', 'sk-ant-api03-abc'],
      ['  sk-ant-api03-abc  ', 'sk-ant-api03-abc'],
    ])("%j o'tadi → %j", (input, expected) => {
      const { error, value } = validate(aiValidationSchema, {
        ...AI_REQUIRED,
        ANTHROPIC_API_KEY: input,
      });
      expect(error).toBeUndefined();
      expect(value.ANTHROPIC_API_KEY).toBe(expected);
    });

    it.each(['abc', 'sk-foo', 'sk-proj-SECRETVALUE123', 'SK-ANT-abc'])(
      '%j — boot yiqiladi',
      (input) => {
        const { error } = validate(aiValidationSchema, {
          ...AI_REQUIRED,
          ANTHROPIC_API_KEY: input,
        });
        expect(error).toBeDefined();
        expect(error!.message).toContain('ANTHROPIC_API_KEY');
      },
    );

    it('xato xabarida kalit QIYMATI chiqmaydi (boot logi / Sentry)', () => {
      const secret = 'sk-proj-SECRETVALUE123';
      const { error } = validate(aiValidationSchema, {
        ...AI_REQUIRED,
        ANTHROPIC_API_KEY: secret,
      });
      expect(error).toBeDefined();
      expect(error!.message).not.toContain(secret);
      expect(error!.message).not.toContain('SECRETVALUE');
    });
  });

  describe('AI_DAILY_USD_CAP (wFSMEIIy #15)', () => {
    it("env orqali sozlanadi: '5' → 5", () => {
      const { error, value } = validate(aiValidationSchema, {
        ...AI_REQUIRED,
        AI_DAILY_USD_CAP: '5',
      });
      expect(error).toBeUndefined();
      expect(value.AI_DAILY_USD_CAP).toBe(5);
    });

    it.each(['0', '-1', 'abc'])('%j — xato', (input) => {
      const { error } = validate(aiValidationSchema, {
        ...AI_REQUIRED,
        AI_DAILY_USD_CAP: input,
      });
      expect(error).toBeDefined();
      expect(error!.message).toContain('AI_DAILY_USD_CAP');
    });
  });

  it.each([
    ['AI_RMQ_PREFETCH', '0'],
    ['AI_RMQ_PREFETCH', '51'],
    ['AI_RMQ_PREFETCH', '2.5'],
    ['AI_CAP_WARN_RATIO', '0.05'],
    ['AI_CAP_WARN_RATIO', '1'],
    ['AI_USD_UZS_RATE', '0'],
    ['AI_CAP_RAISE_MAX_USD', '0'],
    ['AI_ORDER_PRICE_UZS', '-1'],
  ])('%s=%j chegaradan tashqarida — xato', (key, input) => {
    const { error } = validate(aiValidationSchema, {
      ...AI_REQUIRED,
      [key]: input,
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain(key);
  });

  it('AI_ORDER_PRICE_UZS=0 ruxsat (bepul), env qiymatlari songa aylanadi', () => {
    const { error, value } = validate(aiValidationSchema, {
      ...AI_REQUIRED,
      AI_ORDER_PRICE_UZS: '0',
      AI_RMQ_PREFETCH: '4',
      AI_CAP_WARN_RATIO: '0.9',
    });
    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      AI_ORDER_PRICE_UZS: 0,
      AI_RMQ_PREFETCH: 4,
      AI_CAP_WARN_RATIO: 0.9,
    });
  });

  it.each(['POSTGRES_URI', 'RABBITMQ_URI', 'RABBITMQ_NOTIFICATION_QUEUE'])(
    '%s majburiy',
    (key) => {
      const env: Record<string, unknown> = { ...AI_REQUIRED };
      delete env[key];
      const { error } = validate(aiValidationSchema, env);
      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it("unknown(false) YO'Q: boshqa servislarning kalitlari boot'ni yiqitmaydi", () => {
    const { error } = validate(aiValidationSchema, {
      ...AI_REQUIRED,
      ...GATEWAY_REQUIRED,
      ANTROPIC_API_KEY: 'sk-ant-misnamed',
      INTEGRATION_CREDENTIAL_SECRET: 'x',
    });
    expect(error).toBeUndefined();
  });

  it("oylik shift va retention kalitlari yo'q (ega qarori)", () => {
    const keys = schemaKeys(aiValidationSchema);
    expect(keys).not.toContain('AI_MONTHLY_USD_CAP');
    expect(keys).not.toContain('AI_USAGE_RETENTION_DAYS');
    expect(keys).not.toContain('RMQ_RPC_TTL_MS');
  });
});

describe('gatewayValidationSchema — AI kalitlari', () => {
  it("AI kalitlarisiz ham o'tadi (openapi ENV_DEFAULTS) va sukutlar qo'yiladi", () => {
    const { error, value } = validate(
      gatewayValidationSchema,
      GATEWAY_REQUIRED,
    );

    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      RABBITMQ_AI_QUEUE: 'ai_queue',
      AI_ORDER_ENABLED: false,
      AI_PARSE_THROTTLE_LIMIT: 10,
      AI_PARSE_THROTTLE_TTL_MS: 60_000,
    });
  });

  it.each([
    ['true', true],
    ['1', true],
    ['yes', true],
    ['false', false],
    ['0', false],
    ['no', false],
  ])('AI_ORDER_ENABLED=%j → %j', (input, expected) => {
    const { error, value } = validate(gatewayValidationSchema, {
      ...GATEWAY_REQUIRED,
      AI_ORDER_ENABLED: input,
    });
    expect(error).toBeUndefined();
    expect(value.AI_ORDER_ENABLED).toBe(expected);
  });

  it.each([
    ['AI_ORDER_ENABLED', 'maybe'],
    ['AI_PARSE_THROTTLE_LIMIT', '0'],
    ['AI_PARSE_THROTTLE_TTL_MS', '999'],
  ])('%s=%j — xato', (key, input) => {
    const { error } = validate(gatewayValidationSchema, {
      ...GATEWAY_REQUIRED,
      [key]: input,
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain(key);
  });

  it("ANTHROPIC_API_KEY gateway sxemasida YO'Q — noto'g'ri kalit butun API'ni yiqitmaydi", () => {
    expect(schemaKeys(gatewayValidationSchema)).not.toContain(
      'ANTHROPIC_API_KEY',
    );
    const { error } = validate(gatewayValidationSchema, {
      ...GATEWAY_REQUIRED,
      ANTHROPIC_API_KEY: 'garbage',
    });
    expect(error).toBeUndefined();
  });
});

describe("AI kalitlari bo'sh qiymat bilan (`KEY=`)", () => {
  it("gateway: bo'sh AI kalitlari boot'ni yiqitmaydi va sukutga tushadi", () => {
    const { error, value } = validate(gatewayValidationSchema, {
      ...GATEWAY_REQUIRED,
      RABBITMQ_AI_QUEUE: '',
      AI_ORDER_ENABLED: '',
      AI_PARSE_THROTTLE_LIMIT: '',
      AI_PARSE_THROTTLE_TTL_MS: '',
    });
    expect(error).toBeUndefined();
    expect(value.RABBITMQ_AI_QUEUE).toBe('ai_queue');
    expect(value.AI_ORDER_ENABLED).toBe(false);
    expect(value.AI_PARSE_THROTTLE_LIMIT).toBe(10);
    expect(value.AI_PARSE_THROTTLE_TTL_MS).toBe(60_000);
  });

  it("ai-service: bo'sh model/narx/shift kalitlari sukutga tushadi", () => {
    const { error, value } = validate(aiValidationSchema, {
      POSTGRES_URI: 'postgres://x',
      RABBITMQ_URI: 'amqp://x',
      RABBITMQ_NOTIFICATION_QUEUE: 'n',
      AI_ORDER_MODEL: '',
      AI_DAILY_USD_CAP: '',
      AI_USD_UZS_RATE: '',
      AI_RMQ_PREFETCH: '',
    });
    expect(error).toBeUndefined();
    expect(value.AI_ORDER_MODEL).toBe('claude-sonnet-5');
    expect(value.AI_DAILY_USD_CAP).toBe(50);
    expect(value.AI_USD_UZS_RATE).toBe(12800);
    expect(value.AI_RMQ_PREFETCH).toBe(8);
  });
});

describe('orderValidationSchema — AI navbati', () => {
  it('RABBITMQ_AI_QUEUE berilmasa sukut ai_queue; ANTHROPIC_API_KEY tekshirilmaydi', () => {
    const { error, value } = validate(orderValidationSchema, {
      ...ORDER_REQUIRED,
      ANTHROPIC_API_KEY: 'garbage',
    });
    expect(error).toBeUndefined();
    expect(value.RABBITMQ_AI_QUEUE).toBe('ai_queue');
    expect(schemaKeys(orderValidationSchema)).not.toContain(
      'ANTHROPIC_API_KEY',
    );
  });
});
