import { Cashbox_type } from '@app/common';

/**
 * (QTCUUgjA) Smena darvozasi qamrovi — env `FINANCE_REQUIRE_OPEN_SHIFT`:
 *   • bo'sh / boshqa qiymat — `off` (SUKUT);
 *   • `true` / `1` / `on` / `yes` / `main` — `main`: faqat markaziy MAIN
 *     kassa (2026-10-14 xatti-harakati, o'zgarmagan);
 *   • `all` — MAIN + filial (BRANCH) kassalari (R6, 2026-10-15): kartadagi
 *     "shu kassaga biriktirilgan ochiq smena" to'liq — menejer operatsiyalari
 *     ham o'z filiali smenasi ichida bo'ladi.
 * Har chaqiruvda o'qiladi — env'ni o'zgartirib servisni qayta ishga tushirish
 * kifoya. `FinanceServiceService` va `CashboxCardService` umumiy manbasi.
 */
export function shiftGateScope(): 'off' | 'main' | 'all' {
  const raw = String(process.env.FINANCE_REQUIRE_OPEN_SHIFT ?? '')
    .trim()
    .toLowerCase();
  if (raw === 'all') {
    return 'all';
  }
  if (
    raw === 'true' ||
    raw === '1' ||
    raw === 'on' ||
    raw === 'yes' ||
    raw === 'main'
  ) {
    return 'main';
  }
  return 'off';
}

/**
 * Shu turdagi kassa darvozalanadimi: MAIN — `main`/`all`, BRANCH — faqat
 * `all`. Kuryer/market kassalarida smena yo'q — hech qachon.
 */
export function isShiftRequiredFor(
  cashboxType: Cashbox_type | null | undefined,
): boolean {
  const scope = shiftGateScope();
  const type = cashboxType ?? Cashbox_type.MAIN;
  if (type === Cashbox_type.MAIN) {
    return scope !== 'off';
  }
  if (type === Cashbox_type.BRANCH) {
    return scope === 'all';
  }
  return false;
}

export const SHIFT_REQUIRED_MESSAGE =
  'Smena ochilmagan! Bu operatsiyani bajarish uchun avval asosiy kassada smenani oching.';

export const BRANCH_SHIFT_REQUIRED_MESSAGE =
  'Smena ochilmagan! Bu operatsiyani bajarish uchun avval filial kassasida smenani oching.';
