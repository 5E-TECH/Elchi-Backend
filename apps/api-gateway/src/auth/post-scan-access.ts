import { Roles as RoleEnum } from '@app/common';

/**
 * X4RzXk1H — pochta QR'ini skanerlay oladigan rollar. `GET /post/scan/:id`
 * `@Roles` ro'yxati bilan BIR XIL; `GET /scan/:token` (`POST-…` / `PST-…`)
 * ham shuni ishlatadi (u yo'lda faqat JwtAuthGuard bor edi — market ham
 * pochta qatorini to'liq olardi). Filial/kuryer doirasi logistics-service'da
 * (`logistics.post.find_by_scan`, `POST_SCAN_ROLES` — o'sha ro'yxat).
 */
export const POST_SCAN_ROLES: readonly string[] = [
  RoleEnum.SUPERADMIN,
  RoleEnum.ADMIN,
  RoleEnum.BRANCH,
  RoleEnum.MANAGER,
  RoleEnum.REGISTRATOR,
  RoleEnum.COURIER,
];

export const POST_SCAN_FORBIDDEN_MESSAGE = "Bu pochtani ko'rishga ruxsat yo'q";

export function canScanPost(roles?: string[]): boolean {
  return (roles ?? []).some((role) =>
    POST_SCAN_ROLES.includes(
      String(role ?? '')
        .trim()
        .toLowerCase(),
    ),
  );
}

/**
 * Pochta QR tokenimi? logistics `generateToken()` — `POST-<base36>-<rand>`;
 * `PST-` — eski (repoda yaratilmaydi) shakl, moslik uchun qoladi. Ilgari
 * resolver faqat birinchi 4 belgini (`POST`) solishtirardi va haqiqiy pochta
 * tokeni buyurtma tarmog'iga tushib 404 berardi.
 */
export function isPostScanToken(token: string): boolean {
  const upper = String(token ?? '').toUpperCase();
  return upper.startsWith('POST-') || upper.startsWith('PST-');
}
