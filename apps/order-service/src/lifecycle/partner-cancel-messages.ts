import { RpcException } from '@nestjs/microservices';
import { PARTNER_REQUESTER_PREFIX } from './order-create-content';

/**
 * (ZDweRm02) Hamkor API matni — tashqi shartnoma.
 *
 * `POST /partner/shipments/:id/cancel` qabul qilingan posilka uchun
 * `order.cancel` ni chaqiradi (`requester.id = partner:<id>`) va
 * `rmqRequestStrict` xabarni hamkorga O'ZGARISHSIZ uzatadi. Shu xabarlar
 * Elchi foydalanuvchilari uchun o'zbekchaga o'tdi, hamkorga esa eski matn
 * chiqishda davom etadi. Kalit — `cancelOrder` dagi o'zbekcha matn, qiymat —
 * hamkor ko'rib kelgan matn (spec ikkalasini qulflaydi).
 */
export const PARTNER_CANCEL_LEGACY_MESSAGES: Readonly<Record<string, string>> =
  {
    'Buyurtma topilmadi yoki kutilmoqda (waiting) holatida emas':
      'Order not found or not in waiting status',
    'Buyurtma hech qaysi pochtada emas': 'Order has no post',
    'Buyurtmaga kuryer biriktirilmagan': 'Order has no courier assigned',
    'Market topilmadi': 'Market not found',
  };

/** Hamkor nomidan `order.cancel` — ro'yxatdagi xato eski matni bilan chiqadi. */
export async function keepPartnerCancelMessage<T>(
  requester: { id?: string | number | null } | null | undefined,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const isPartner = String(requester?.id ?? '').startsWith(
      PARTNER_REQUESTER_PREFIX,
    );
    if (!isPartner || !(error instanceof RpcException)) {
      throw error;
    }
    const payload = error.getError();
    if (typeof payload !== 'object' || payload === null) {
      throw error;
    }
    const legacy =
      PARTNER_CANCEL_LEGACY_MESSAGES[
        String((payload as { message?: unknown }).message)
      ];
    if (!legacy) {
      throw error;
    }
    throw new RpcException({ ...payload, message: legacy });
  }
}
