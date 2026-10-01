import { ForbiddenException } from '@nestjs/common';
import { Roles as RoleEnum } from '@app/common';

/**
 * `GET /orders/qr-code/:token` ruxsat etilgan rollari — `GET /scan/:token`
 * (buyurtma tokeni) ham AYNI ro'yxatdan foydalanadi (fix3 C11, CODE-04).
 */
export const ORDER_QR_LOOKUP_ROLES: readonly string[] = [
  RoleEnum.SUPERADMIN,
  RoleEnum.ADMIN,
  RoleEnum.BRANCH,
  RoleEnum.MANAGER,
  RoleEnum.COURIER,
  RoleEnum.MARKET,
  RoleEnum.REGISTRATOR,
];

const normalizeRoles = (roles?: string[]): string[] =>
  (roles ?? []).map((role) =>
    String(role ?? '')
      .trim()
      .toLowerCase(),
  );

/** So'rovchida QR orqali buyurtma qidirish huquqi bormi (rol bo'yicha). */
export function canLookupOrderByQr(roles?: string[]): boolean {
  return normalizeRoles(roles).some((role) =>
    ORDER_QR_LOOKUP_ROLES.includes(role),
  );
}

/**
 * QR orqali topilgan buyurtmani ko'rish (fix3 C11, CODE-04).
 *
 * QR yorlig'i JISMONIY posilkada: skaner oqimlari (kuryer "O'zimga olish",
 * HQ/filial qabuli) hali o'ziga tegishli bo'lmagan buyurtmani ham ko'rishi
 * kerak, shuning uchun xodim rollari bu yerda cheklanmaydi. MARKET esa boshqa
 * market posilkasini qo'lida tutmaydi — u faqat o'z buyurtmasini ko'radi.
 * Buyurtma yo'q (topilmadi) bo'lsa — hech narsa qilinmaydi.
 */
export function assertQrOrderVisible(
  user: { sub?: string; roles?: string[] } | undefined,
  order: unknown,
): void {
  if (!order || typeof order !== 'object') {
    return;
  }
  const roles = normalizeRoles(user?.roles);
  if (
    !roles.includes(RoleEnum.MARKET) ||
    roles.includes(RoleEnum.SUPERADMIN) ||
    roles.includes(RoleEnum.ADMIN)
  ) {
    return;
  }
  const row = order as Record<string, unknown>;
  const rawMarketId = row.market_id ?? row.marketId;
  const marketId =
    typeof rawMarketId === 'string' || typeof rawMarketId === 'number'
      ? String(rawMarketId).trim()
      : '';
  const sub = String(user?.sub ?? '').trim();
  if (!sub || marketId !== sub) {
    throw new ForbiddenException("Bu buyurtmani ko'rishga ruxsat yo'q");
  }
}
