import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsOptional, ValidateBy } from 'class-validator';

/**
 * Elchi ID'lari Postgres `bigint` (int8). Musbat, boshida nolsiz va
 * `9223372036854775807` dan oshmaydigan raqam satri.
 *
 * Nega: oddiy `^\d{1,19}$` '9999999999999999999' ni o'tkazardi — Postgres
 * 22003 (out of range) → Sentry va RMQ nack; '0120' esa market yo'lida
 * satr solishtiruvida rad, admin yo'lida 120 bo'lib saqlanardi. JSON son
 * 2^53 dan katta bo'lsa aniqligini yo'qotadi — bunday son qabul
 * qilinmaydi (satr yuborilsin).
 */
export const INT8_MAX = 9223372036854775807n;
const POSITIVE_INT8_TEXT_RE = /^[1-9]\d{0,18}$/;

export function isPositiveInt8Id(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    POSITIVE_INT8_TEXT_RE.test(value) &&
    BigInt(value) <= INT8_MAX
  );
}

/**
 * Ixtiyoriy ID maydoni (DTO): xavfsiz butun son → satr (xavfsiz bo'lmagan
 * son o'zgarmaydi va rad etiladi); bo'sh satr/bo'shliq — berilmagan
 * (`undefined`); satr chetidagi bo'shliq olib tashlanadi; qolgani
 * `isPositiveInt8Id` bo'lishi SHART, aks holda 400 `message`.
 */
export function OptionalPositiveInt8Id(message: string): PropertyDecorator {
  return applyDecorators(
    IsOptional(),
    Transform(({ value }: { value: unknown }): unknown => {
      if (typeof value === 'number') {
        return Number.isSafeInteger(value) ? String(value) : value;
      }
      if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed === '' ? undefined : trimmed;
      }
      return value;
    }),
    ValidateBy(
      {
        name: 'isPositiveInt8Id',
        validator: { validate: (value: unknown) => isPositiveInt8Id(value) },
      },
      { message },
    ),
  );
}
