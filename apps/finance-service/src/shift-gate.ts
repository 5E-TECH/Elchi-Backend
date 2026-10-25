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

/** Darvoza rad javobining kodi (frontend matni emas — kuzatuv uchun). */
export type ShiftGateBlockCode = 'SHIFT_REQUIRED' | 'BRANCH_SHIFT_REQUIRED';

/**
 * (32Sw3DfC) Kuzatuv: darvoza pul amalini 400 bilan rad etganda bitta WARN
 * qatori. `all` yoqilgandan keyingi kunlarda nechta amal smenasiz qolgani
 * shu teg bo'yicha sanaladi:
 *   docker logs <finance-service> --since 24h 2>&1 | grep -c shift_gate_blocked
 * (kassa bo'yicha: `| grep -o 'cashbox_user_id=[0-9]*' | sort | uniq -c`).
 */
export function shiftGateBlockedLogLine(
  code: ShiftGateBlockCode,
  target: { cashbox_type?: Cashbox_type | null; user_id?: string | null },
): string {
  return [
    'shift_gate_blocked',
    `code=${code}`,
    `cashbox_type=${String(target.cashbox_type ?? Cashbox_type.MAIN)}`,
    `cashbox_user_id=${String(target.user_id ?? '0')}`,
    `scope=${shiftGateScope()}`,
  ].join(' ');
}
