import { applyDecorators } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsNumber, Max, Min } from 'class-validator';

/**
 * PR-D (A-5) — pul summalarining yuqori chegarasi (so'm).
 *
 * 1e13 (10 trillion so'm) — real summalardan ancha katta, lekin JS double
 * tiyingacha ANIQ bo'lgan oraliqda (≈ 9e13 gacha `x * 100` butun son bo'lib
 * qoladi). 1e15 da allaqachon tiyin siljiydi (`1e15 − 0.01` → `1e15`), 1e19
 * esa `numeric(20,2)` ni to'ldirib 500 berardi.
 */
export const MONEY_MAX = 1e13;

/*
 * Hamma dekoratorlarda `coerce` — satrni songa aylantirish
 * (`@Type(() => Number)`); JSON son kutadigan DTO'larda (investor,
 * settlement) `false` — avvalgi xulq.
 */
const NUMBER_OPTIONS = {
  maxDecimalPlaces: 2,
  allowNaN: false,
  allowInfinity: false,
} as const;

const decimalsMessage = (field: string) =>
  `${field} — ko'pi bilan 2 xonali kasr (tiyin) bo'lishi kerak`;
const maxMessage = (field: string) =>
  `${field} ${MONEY_MAX} so'mdan oshmasligi kerak`;

/**
 * Musbat pul summasi: son, ≤ 2 kasr xonasi, 0,01 ≤ x ≤ MONEY_MAX.
 * (Ilgari `@Min(0.0000001)` — 0,005 so'm o'tib, yaxlitlashda tiyin
 * «yaratilardi».)
 */
export function IsMoneyAmount(field = 'amount', coerce = true) {
  return applyDecorators(
    ...(coerce ? [Type(() => Number)] : []),
    IsNumber(NUMBER_OPTIONS, { message: decimalsMessage(field) }),
    Min(0.01, { message: `${field} 0 dan katta bo'lishi kerak` }),
    Max(MONEY_MAX, { message: maxMessage(field) }),
  );
}

/** Manfiy bo'lmagan pul qiymati (sanalgan qoldiq va h.k.): 0 ≤ x ≤ MONEY_MAX. */
export function IsMoneyNonNegative(field = 'amount', coerce = true) {
  return applyDecorators(
    ...(coerce ? [Type(() => Number)] : []),
    IsNumber(NUMBER_OPTIONS, { message: decimalsMessage(field) }),
    Min(0, { message: `${field} manfiy bo'lmasligi kerak` }),
    Max(MONEY_MAX, { message: maxMessage(field) }),
  );
}

/** Ishorali pul qiymati (qoldiq, tuzatish): −MONEY_MAX ≤ x ≤ MONEY_MAX. */
export function IsMoneySigned(field = 'amount', coerce = true) {
  return applyDecorators(
    ...(coerce ? [Type(() => Number)] : []),
    IsNumber(NUMBER_OPTIONS, { message: decimalsMessage(field) }),
    Min(-MONEY_MAX, { message: maxMessage(field) }),
    Max(MONEY_MAX, { message: maxMessage(field) }),
  );
}
