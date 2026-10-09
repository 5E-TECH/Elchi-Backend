import { Order_status } from '../../enums';

/**
 * HAMKORGA PUL MAYDONLARI — YAGONA MANBA (audit M2, Lx5oONlP).
 *
 * `GET /partner/shipments/:id` (integration-service) va chiquvchi
 * `shipment.status_changed` webhooki (order-service `queueExternalStatusSync`)
 * ikkalasi SHU funksiyadan o'qiydi. Ikki raqam ajralsa hamkor (BeePost)
 * solishtiruvi har safar "nomuvofiqlik" chiqaradi — ilgari formula ikki
 * joyda alohida yozilgan edi.
 *
 *   `collected_from_customer` — sotuvda kuryer mijozdan yig'gan naqd;
 *   `elchi_fee`               — sotuvda ishlatilgan tarif (`market_tariff`);
 *   `market_amount`           — Elchi hamkorga qarzi: yig'ilgan − tarif.
 *
 * ⚠️ `null` MA'NOLI: "hali sotilmagan / hisoblanmagan". 0 ga aylantirilmaydi,
 * aks holda hamkor uni qarz hisobiga qo'shardi.
 */

/**
 * Sotish amalidan o'tgan holatlar. `CLOSED` ATAYLAB YO'Q: u asosan bekor
 * qilingan molning yakuniy holati — "pul yig'ildi" deb taxmin qilib bo'lmaydi.
 */
const PARTNER_SOLD_STATUSES: ReadonlySet<string> = new Set<string>([
  Order_status.SOLD,
  Order_status.PAID,
  Order_status.PARTLY_PAID,
]);

export interface PartnerMoneySource {
  status?: unknown;
  sold_at?: unknown;
  sale_collectible_amount?: unknown;
  total_price?: unknown;
  paid_online_amount?: unknown;
  market_tariff?: unknown;
}

export interface PartnerMoneyFields {
  collected_from_customer: number | null;
  elchi_fee: number | null;
  market_amount: number | null;
}

/** `null`/`undefined`/son emas → `null`; aks holda son (0 ham HAQIQIY qiymat). */
const nullableMoney = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Kuryer mijozdan yig'gan naqd.
 *
 * 1) Snapshot (`sale_collectible_amount`) bor — u USTUN. Qayta
 *    hisoblanmaydi: sotuvdan keyin `paid_online_amount` (qaytarish webhooki)
 *    o'zgarishi mumkin, qayta hisob esa hamkorga BOSHQA raqam yuborardi.
 *
 * 2) Lx5oONlP — snapshot `null`, lekin buyurtma HAQIQATAN sotilgan (sotuv
 *    holati + `sold_at`). Bular ESKI sotuvlar:
 *      • ustun (migratsiya 045) qo'shilishidan OLDIN sotilganlar —
 *        `paid_online_amount` ustuni ham o'sha kuni (038) sukut 0 bilan
 *        qo'shilgan, ya'ni natija `total_price` = o'sha paytdagi naqd oyoqlari;
 *      • 2026-09-14..09-24 sotuvlari — `updateFull` snapshotni jimgina
 *        tashlab yuborardi (2093e41), naqd oyoqlari esa allaqachon
 *        `total_price − paid_online_amount` bilan yozilgan.
 *    Ilgari ular uchun hamkorga ABADIY `null` borardi (#122, #123) va
 *    BeePostdagi "Elchi yig'gan (net)" ustuni bo'sh qolardi. Endi qiymat
 *    sotuv oqimining O'Z formulasi bilan tiklanadi:
 *    `max(total_price − paid_online_amount, 0)` — order-service
 *    `resolveCollectibleAmount` bilan AYNI (spec qulflaydi).
 *    Kartadagi `total_price + extra_cost` varianti OLINMADI: xarajat
 *    kuryerning chiqimi, mijozdan yig'ilgan naqd emas — u alohida
 *    `extra_cost` maydonida boradi.
 *
 * 3) Sotilmagan (yoki `sold_at` siz — RBAC-05: kassa oyoqlari umuman
 *    yozilmagan) buyurtma — `null`.
 */
export function resolvePartnerCollectedFromCustomer(
  order: PartnerMoneySource | null | undefined,
): number | null {
  const snapshot = nullableMoney(order?.sale_collectible_amount);
  if (snapshot != null) return snapshot;

  const status = typeof order?.status === 'string' ? order.status : '';
  const soldAt =
    typeof order?.sold_at === 'string' || typeof order?.sold_at === 'number'
      ? String(order.sold_at).trim()
      : '';
  if (!PARTNER_SOLD_STATUSES.has(status) || !soldAt) return null;

  const total = nullableMoney(order?.total_price);
  if (total == null) return null;
  const online = nullableMoney(order?.paid_online_amount) ?? 0;
  // Snapshot `numeric(14,2)` da saqlanadi — zaxira ham tiyingacha yaxlitlanadi.
  return Math.round(Math.max(total - online, 0) * 100) / 100;
}

export function resolvePartnerMoneyFields(
  order: PartnerMoneySource | null | undefined,
): PartnerMoneyFields {
  const collected = resolvePartnerCollectedFromCustomer(order);
  const fee = nullableMoney(order?.market_tariff);
  return {
    collected_from_customer: collected,
    elchi_fee: fee,
    market_amount: collected != null && fee != null ? collected - fee : null,
  };
}
