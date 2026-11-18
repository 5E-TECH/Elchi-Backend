import { BadRequestException } from '@nestjs/common';
import { Roles as RoleEnum } from '@app/common';
import { INT8_MAX, OptionalPositiveInt8Id } from './positive-int8-id';

/**
 * Buyurtma formasidagi «Operator» tanlovi — `POST /orders` `operator_id`
 * (va AI panelidagi `POST /orders/ai-confirm` `orders[].operator_id` —
 * ayni `createOrderInternal` orqali, ayni qoida).
 *
 * Ilgari Elchi formasida operator faqat erkin matn edi: market o'z
 * operatorini tanlay olmasdi, buyurtmaga `operator_id` yozilmasdi va
 * operator komissiyasi (sotuvda `finance.operator.earning.record`)
 * hisoblanmasdi; chekda esa faqat market nomi chiqardi.
 *
 * Qoida BeePost bilan AYNI (`order.service.ts:464-485`,
 * `operator-assignment.util.ts:31-100`):
 *   • berilmasa — `null`, avvalgi xulq (matn; market operatori — o'zi;
 *     registrator — 2026-11-11 dan operatorsiz, o'zi YOZILMAYDI);
 *   • berilsa — buyurtmaning YAKUNIY marketi (market — o'zi, market
 *     operatori — biriktirilgan marketi, qolganlar — tanadagi `market_id`)
 *     operatorlari ichida faol va o'chirilmagan bo'lishi SHART. Tekshiruv —
 *     `identity.market_operator.selectable`, ya'ni formadagi ro'yxat
 *     (`GET /market-operators/selectable`) bilan AYNI so'rov. Aks holda 400;
 *   • market operatori faqat O'ZINI tanlay oladi (boshqasi — 400);
 *   • SUPERADMIN/ADMIN ham tekshiriladi (tekshiruvsiz o'tkazish yo'q).
 * To'g'ri bo'lsa buyurtmaga `operator_id` va `operator` = operator ismi
 * yoziladi (yozilgan matn e'tiborsiz).
 *
 * `operator_id` pulga ta'sir qiladi — identity javob bermasa xato yuqoriga
 * ketadi (fail-closed), buyurtma operatorsiz yaratilmaydi.
 */
export const CHOSEN_OPERATOR_NOT_SELECTABLE_MESSAGE =
  'Tanlangan operator bu marketga tegishli emas yoki faol emas';
export const CHOSEN_OPERATOR_SELF_ONLY_MESSAGE =
  "Market operatori faqat o'zini operator qilib tanlay oladi";

export const MARKET_OPERATOR_SELECTABLE_CMD =
  'identity.market_operator.selectable';

export type ChosenOrderOperator = { id: string; name: string };

export const CHOSEN_OPERATOR_ID_FORMAT_MESSAGE =
  "operator_id operator ID si (raqam) bo'lishi kerak";

/**
 * `operator_id` maydonining DTO tekshiruvi — `POST /orders`
 * (`CreateOrderRequestDto`) va `POST /orders/ai-confirm`
 * (`AiConfirmOrderDto`) uchun AYNI qoida (bir joyda — ikki DTO ajralib
 * ketmasin). Swagger tavsifi har DTO'ning o'zida (xato shakli farq qiladi).
 *  • xavfsiz butun son → satr; bo'sh satr — «tanlanmagan» (forma
 *    select'ining bo'sh qiymati) → `undefined`;
 *  • aks holda musbat int8 (boshida nolsiz, ≤ 9223372036854775807), bo'lmasa
 *    400 (`positive-int8-id.ts`).
 */
export function OptionalChosenOperatorId(): PropertyDecorator {
  return OptionalPositiveInt8Id(CHOSEN_OPERATOR_ID_FORMAT_MESSAGE);
}

const BIGINT_ID_RE = /^[0-9]{1,19}$/;

/** Ichki chaqiruvlar: boshida nol bo'lishi mumkin, lekin 0 va int8 dan katta — yo'q. */
const isInt8IdText = (value: string): boolean =>
  BIGINT_ID_RE.test(value) && BigInt(value) > 0n && BigInt(value) <= INT8_MAX;

const idText = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

const canonicalId = (value: string): string => BigInt(value).toString();

export async function resolveChosenOrderOperator(params: {
  operatorId: unknown;
  /** Normallashtirilgan (kichik harf) rollar. */
  roles: string[];
  requesterId: unknown;
  /** Buyurtmaning yakuniy marketi (`createOrderInternal` aniqlagan). */
  marketId: unknown;
  /** `identity.market_operator.selectable` chaqiruvi (`successRes({ items })`). */
  loadSelectable: (payload: {
    market_id: string;
    operator_id: string;
  }) => Promise<unknown>;
}): Promise<ChosenOrderOperator | null> {
  const operatorId = idText(params.operatorId);
  if (!operatorId) {
    return null;
  }
  // DTO tekshiradi; bu — DTO'dan o'tmaydigan ichki chaqiruvlar uchun.
  if (!isInt8IdText(operatorId)) {
    throw new BadRequestException(CHOSEN_OPERATOR_NOT_SELECTABLE_MESSAGE);
  }
  const chosenId = canonicalId(operatorId);

  // Market operatori (market roli bo'lmasa — `createOrderInternal` dagi
  // market aniqlash tartibi bilan bir xil) faqat o'zini.
  if (
    params.roles.includes(RoleEnum.MARKET_OPERATOR) &&
    !params.roles.includes(RoleEnum.MARKET)
  ) {
    const self = idText(params.requesterId);
    if (!BIGINT_ID_RE.test(self) || canonicalId(self) !== chosenId) {
      throw new BadRequestException(CHOSEN_OPERATOR_SELF_ONLY_MESSAGE);
    }
  }

  const marketId = idText(params.marketId);
  if (!BIGINT_ID_RE.test(marketId)) {
    throw new BadRequestException(CHOSEN_OPERATOR_NOT_SELECTABLE_MESSAGE);
  }
  const response = await params.loadSelectable({
    market_id: canonicalId(marketId),
    operator_id: chosenId,
  });
  const items = (response as { data?: { items?: unknown } } | null)?.data
    ?.items;
  const match = Array.isArray(items)
    ? (items as Array<{ id?: unknown; name?: unknown } | null>).find(
        (item) => idText(item?.id) === chosenId,
      )
    : undefined;
  if (!match) {
    throw new BadRequestException(CHOSEN_OPERATOR_NOT_SELECTABLE_MESSAGE);
  }
  return {
    id: chosenId,
    name: typeof match.name === 'string' ? match.name.trim() : '',
  };
}
