import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Joi from 'joi';
import * as schemas from './index';
import {
  aiValidationSchema,
  financeValidationSchema,
  notificationValidationSchema,
  orderValidationSchema,
} from './index';

/**
 * `cp .env.example .env` — yangi muhitda (yangi dasturchi, yangi staging
 * server) BIRINCHI qadam. `.env.example` da qiymatsiz qoldirilgan
 * (`KEY=`, izohda «bo'sh — o'chiq») son kalitlari Joi'da `.empty('')` yoki
 * `.allow('')` siz bo'lsa, servis «Config validation error: "KEY" must be a
 * number» bilan YIQILADI.
 *
 * 2026-10-29: order-service aynan shunday yiqildi —
 * `EXTRA_COST_AUTO_APPROVE_MINUTES=` (`Joi.number().integer().min(1)
 * .optional()` bo'sh satrni rad etadi). Prod'da kalit yozilmagan yoki to'ldirilgan,
 * shuning uchun xato faqat noldan sozlangan muhitda chiqardi.
 *
 * ConfigModule opsiyalari bilan (`abortEarly:false, allowUnknown:true`).
 */
const CONFIG_MODULE_OPTIONS: Joi.ValidationOptions = {
  abortEarly: false,
  allowUnknown: true,
};

const ROOT = join(__dirname, '../../../..');
const EXAMPLE_FILES = ['.env.example', '.env.staging.example'];

/** Faylda izohsiz, QIYMATSIZ yozilgan kalitlar (`KEY=`). */
const emptyKeysOf = (file: string): string[] =>
  readFileSync(join(ROOT, file), 'utf8')
    .split('\n')
    .map((line) => /^([A-Z0-9_]+)=\s*$/.exec(line)?.[1])
    .filter((key): key is string => Boolean(key));

const SCHEMAS = Object.entries(schemas).filter(
  (entry): entry is [string, Joi.ObjectSchema] =>
    entry[0].endsWith('ValidationSchema') && Joi.isSchema(entry[1]),
);

const numberKeysOf = (schema: Joi.ObjectSchema): Set<string> => {
  const keys = (schema.describe().keys ?? {}) as Record<
    string,
    { type?: string }
  >;
  return new Set(
    Object.entries(keys)
      .filter(([, d]) => d.type === 'number')
      .map(([key]) => key),
  );
};

/** Faqat SHU kalitga tegishli xatolar — boshqa majburiy kalitlar e'tiborsiz. */
const errorsFor = (
  schema: Joi.ObjectSchema,
  env: Record<string, unknown>,
  key: string,
) =>
  (schema.validate(env, CONFIG_MODULE_OPTIONS).error?.details ?? []).filter(
    (d) => d.path[0] === key,
  );

const valueOf = (
  schema: Joi.ObjectSchema,
  env: Record<string, unknown>,
  key: string,
) =>
  (
    schema.validate(env, CONFIG_MODULE_OPTIONS).value as Record<string, unknown>
  )[key];

describe(".env.example — qiymatsiz son kalitlari boot'ni yiqitmaydi", () => {
  it.each(EXAMPLE_FILES)(
    "%s: har bir `KEY=` son kaliti bo'sh satrni qabul qiladi",
    (file) => {
      const empty = emptyKeysOf(file);
      // Parser ishlayaptimi — ma'lum bo'sh kalit topilishi SHART.
      expect(empty).toContain('EXTRA_COST_AUTO_APPROVE_MINUTES');

      const failures: string[] = [];
      let checked = 0;
      for (const [name, schema] of SCHEMAS) {
        const numberKeys = numberKeysOf(schema);
        for (const key of empty.filter((k) => numberKeys.has(k))) {
          checked += 1;
          const errors = errorsFor(schema, { [key]: '' }, key);
          if (errors.length) {
            failures.push(`${name}.${key}: ${errors[0].message}`);
          }
        }
      }

      expect(checked).toBeGreaterThan(0);
      expect(failures).toEqual([]);
    },
  );
});

/**
 * Har bir bo'sh son kaliti alohida: bo'sh — o'chiq (xatosiz), aniq qiymat
 * songa aylanadi, noto'g'ri qiymat esa AVVALGIDEK rad etiladi (`.empty('')`
 * tekshiruvni bo'shashtirmasin).
 */
describe("bo'sh = o'chiq son kalitlari", () => {
  const CASES: Array<{
    key: string;
    service: string;
    schema: Joi.ObjectSchema;
    valid: [string, number];
    invalid: string[];
  }> = [
    {
      key: 'EXTRA_COST_AUTO_APPROVE_MINUTES',
      service: 'order',
      schema: orderValidationSchema,
      valid: ['30', 30],
      invalid: ['0', '1.5', 'abc'],
    },
    {
      key: 'COURIER_CASH_REMINDER_THRESHOLD',
      service: 'finance',
      schema: financeValidationSchema,
      valid: ['500000', 500_000],
      invalid: ['-1', 'abc'],
    },
    {
      key: 'SMS_TARIFF_TRANSACTIONAL',
      service: 'notification',
      schema: notificationValidationSchema,
      valid: ['75', 75],
      invalid: ['-1', 'abc'],
    },
    {
      key: 'SMS_TARIFF_PROMO',
      service: 'notification',
      schema: notificationValidationSchema,
      valid: ['90', 90],
      invalid: ['-1', 'abc'],
    },
    {
      key: 'SMS_BALANCE_ALERT_THRESHOLD',
      service: 'notification',
      schema: notificationValidationSchema,
      valid: ['100000', 100_000],
      invalid: ['-1', 'abc'],
    },
    {
      key: 'AI_PRICE_PER_ORDER',
      service: 'ai',
      schema: aiValidationSchema,
      valid: ['0', 0],
      invalid: ['-1', 'abc'],
    },
    {
      key: 'STAGING_AI_DAILY_USD_CAP',
      service: 'appEnvKeys — hamma servisda',
      schema: orderValidationSchema,
      valid: ['2', 2],
      invalid: ['0', 'abc'],
    },
  ];

  describe.each(CASES)('$key ($service)', ({ key, schema, valid, invalid }) => {
    it("`KEY=` (bo'sh) — xatosiz, qiymat yo'q (o'chiq)", () => {
      expect(errorsFor(schema, { [key]: '' }, key)).toEqual([]);
      expect([undefined, '']).toContain(valueOf(schema, { [key]: '' }, key));
    });

    it('kalit umuman yozilmagan — xatosiz', () => {
      expect(errorsFor(schema, {}, key)).toEqual([]);
      expect(valueOf(schema, {}, key)).toBeUndefined();
    });

    it('aniq qiymat songa aylanadi', () => {
      const [raw, parsed] = valid;
      expect(errorsFor(schema, { [key]: raw }, key)).toEqual([]);
      expect(valueOf(schema, { [key]: raw }, key)).toBe(parsed);
    });

    it.each(invalid)('noto`g`ri qiymat %p — avvalgidek rad etiladi', (raw) => {
      expect(errorsFor(schema, { [key]: raw }, key)).not.toEqual([]);
    });
  });
});
