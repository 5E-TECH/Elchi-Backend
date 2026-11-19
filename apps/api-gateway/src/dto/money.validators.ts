import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, Max, Min, ValidateBy } from 'class-validator';
import {
  MONEY_MAX,
  MONEY_MAX_NUMERIC_14_2,
  formatMoneyLimit,
  isExactCents,
} from '@app/common/finance/money';

export { MONEY_MAX, MONEY_MAX_NUMERIC_14_2 };

/**
 * PR-D (A-5) — pul summalari: son, ANIQ tiyinda (ko'pi bilan 2 kasr xonasi),
 * yuqori chegara bilan.
 *
 * Kasr tekshiruvi class-validator `maxDecimalPlaces` EMAS: u
 * `value.toString().split('.')[1]` qiladi va `1e-7` kabi qiymatlarda
 * TypeError → 500 beradi. O'rniga `isExactCents` (`Math.round(v*100)/100 ===
 * v`) — 1e13 gacha parse qilingan «x.yz» qiymatlarda soxta rad yo'q.
 *
 * Har dekorator Swagger'ga `minimum` / `maximum` / `multipleOf: 0.01` ham
 * yozadi (maydondagi `@ApiProperty` qolgan kalitlarni o'zgarishsiz qoldiradi).
 */
export interface MoneyOptions {
  /** Satrni songa aylantirish (`@Type(() => Number)`); JSON son kutadigan DTO'larda `false`. */
  coerce?: boolean;
  /** Yuqori chegara (sukut `MONEY_MAX`; `numeric(14,2)` ustunlar — `MONEY_MAX_NUMERIC_14_2`). */
  max?: number;
}

function IsExactCents(field: string) {
  return ValidateBy({
    name: 'isExactCents',
    // Son bo'lmagan qiymat — `IsNumber` xabari yetarli (ikki xabar chiqmasin).
    validator: {
      validate: (value: unknown) =>
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        isExactCents(value),
      defaultMessage: () =>
        `${field} — ko'pi bilan 2 xonali kasr (tiyin) bo'lishi kerak`,
    },
  });
}

function money(field: string, min: number | null, options: MoneyOptions) {
  const max = options.max ?? MONEY_MAX;
  const limit = formatMoneyLimit(max);
  return applyDecorators(
    ...(options.coerce === false ? [] : [Type(() => Number)]),
    ApiProperty({
      ...(min === null ? { minimum: -max } : { minimum: min }),
      maximum: max,
      multipleOf: 0.01,
    }),
    IsNumber(
      { allowNaN: false, allowInfinity: false },
      { message: `${field} son bo'lishi kerak` },
    ),
    IsExactCents(field),
    min === null
      ? Min(-max, {
          message: `${field} −${limit} so'mdan kam bo'lmasligi kerak`,
        })
      : Min(min, {
          message:
            min > 0
              ? `${field} 0 dan katta bo'lishi kerak`
              : `${field} manfiy bo'lmasligi kerak`,
        }),
    Max(max, { message: `${field} ${limit} so'mdan oshmasligi kerak` }),
  );
}

/** Musbat pul summasi: 0,01 ≤ x ≤ max. (Ilgari `@Min(0.0000001)` — 0,005 so'm tiyin «yaratardi».) */
export function IsMoneyAmount(field = 'amount', options: MoneyOptions = {}) {
  return money(field, 0.01, options);
}

/** Manfiy bo'lmagan pul qiymati (sanalgan qoldiq va h.k.): 0 ≤ x ≤ max. */
export function IsMoneyNonNegative(
  field = 'amount',
  options: MoneyOptions = {},
) {
  return money(field, 0, options);
}

/** Ishorali pul qiymati (qoldiq, tuzatish): −max ≤ x ≤ max. */
export function IsMoneySigned(field = 'amount', options: MoneyOptions = {}) {
  return money(field, null, options);
}
