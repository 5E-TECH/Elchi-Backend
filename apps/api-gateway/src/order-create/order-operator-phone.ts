import { applyDecorators, BadRequestException } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches } from 'class-validator';
import { normalizeUzPhone, ORDER_CREATE_ERROR_CODES } from '@app/common';

/**
 * VRyloH62 — buyurtmadagi operator raqamlari (yorliq/chekdagi "Muammo
 * bo'lsa" qatori).
 *
 * Ilgari Elchi buyurtmasida operator faqat ISM edi va chekda doim marketning
 * umumiy raqami chiqardi. Endi market profilida:
 *   - `require_operator_phone` (sukut false) — har buyurtmada operator raqami
 *     majburiy;
 *   - `default_operator_phone` — marketning doimiy operator raqami;
 * buyurtmada esa `operator_phone` (1-raqam) va `secondary_operator_phone`
 * (2-raqam) saqlanadi.
 *
 * Qoida BeePost bilan AYNI (`server/src/api/order/order.service.ts`
 * :479-513):
 *   • majburiy EMAS        — 1-raqam = market default (bo'lsa), formadagi
 *                            raqam — 2-raqam;
 *   • majburiy + default   — 1-raqam = default, formadagi raqam — ixtiyoriy
 *                            2-raqam;
 *   • majburiy, default yo'q — formadagi raqam MAJBURIY va u 1-raqam
 *                            (2-raqam yo'q); raqam ham yo'q bo'lsa → 400.
 * Formadagi raqam default bilan bir xil bo'lsa — takrorlanmaydi (2-raqam yo'q).
 *
 * `strict: false` (Telegram bot yo'li — formada raqam maydoni yo'q,
 * BeePost `createOrderByBot` kabi) — 400 berilmaydi, qolgan qoida o'sha.
 */
export type OrderMarketPhonePolicy = {
  require_operator_phone?: boolean | null;
  default_operator_phone?: string | null;
};

export type OrderOperatorPhones = {
  operator_phone: string | null;
  secondary_operator_phone: string | null;
};

export const OPERATOR_PHONE_REQUIRED_MESSAGE =
  'Operator telefon raqami majburiy. Market profilida doimiy operator raqamini kiriting yoki buyurtmada raqam yuboring (operator_phone)';

export const OPERATOR_PHONE_FORMAT_MESSAGE =
  "Telefon raqam noto'g'ri — +998XXXXXXXXX formatidagi raqam kerak";

/**
 * Formadagi operator raqami maydonining DTO tekshiruvi — `POST /orders`
 * (`operator_phone`, `secondary_operator_phone`) va `POST /orders/ai-confirm`
 * (`orders[].operator_phone`) uchun AYNI qoida (bir joyda — DTO'lar ajralib
 * ketmasin). Swagger tavsifi har DTO'ning o'zida.
 *  • bo'sh satr/bo'shliq — yuborilmagan (`undefined`);
 *  • aks holda umumiy `normalizeUzPhone` bilan kanonik `+998XXXXXXXXX`
 *    ("90 123 45 67", "0901234567", "+998 90 …"); keltirib bo'lmasa qiymat
 *    o'zgarmaydi va 400.
 */
export function OptionalOperatorPhone(): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }): unknown =>
      typeof value === 'string' && value.trim() === ''
        ? undefined
        : (normalizeUzPhone(value) ?? value),
    ),
    IsOptional(),
    IsString(),
    Matches(/^\+998\d{9}$/, { message: OPERATOR_PHONE_FORMAT_MESSAGE }),
  );
}

function canonical(value: unknown): string {
  return normalizeUzPhone(value) ?? '';
}

export function resolveOrderOperatorPhones(params: {
  market: OrderMarketPhonePolicy | null | undefined;
  operatorPhone?: unknown;
  secondaryOperatorPhone?: unknown;
  strict: boolean;
}): OrderOperatorPhones {
  const formInput =
    canonical(params.operatorPhone) || canonical(params.secondaryOperatorPhone);
  const marketDefault = canonical(params.market?.default_operator_phone);

  if (params.market?.require_operator_phone === true && !marketDefault) {
    if (!formInput) {
      if (params.strict) {
        throw new BadRequestException({
          statusCode: 400,
          message: OPERATOR_PHONE_REQUIRED_MESSAGE,
          code: ORDER_CREATE_ERROR_CODES.OPERATOR_PHONE_REQUIRED,
        });
      }
      return { operator_phone: null, secondary_operator_phone: null };
    }
    return { operator_phone: formInput, secondary_operator_phone: null };
  }

  const first = marketDefault || null;
  return {
    operator_phone: first,
    secondary_operator_phone:
      formInput && formInput !== first ? formInput : null,
  };
}
