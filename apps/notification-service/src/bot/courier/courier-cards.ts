import { escapeTelegramHtml } from '@app/common';
import type { InlineKeyboardButton } from '../telegram.types';
import { STATUS_EMOJI } from '../handlers/market.handler';

/** Kuryer amallari (callback payload `op`). `partly-sell` — kabinetda. */
export type CourierOp = 'sell' | 'cancel' | 'cnd' | 'rollback';

export const COURIER_ACTIONS = {
  op: 'c.op',
  reason: 'c.reason',
  confirm: 'c.ok',
  back: 'c.back',
  page: 'c.page',
  /** (BOT-3d) /ishim ro'yxatidan bitta buyurtma kartasini ochish. */
  open: 'c.open',
  proofDone: 'c.pdone',
  proofStop: 'c.pstop',
} as const;

/** (Pq2dFj8A TC) Muddati o'tgan ro'yxat tugmasi. */
export const COURIER_LIST_EXPIRED_TEXT =
  "⌛ Bu ro'yxat eskirgan, /ishim ni qayta yuboring";

export const STATUS_LABEL_UZ: Record<string, string> = {
  created: 'Yaratildi',
  new: 'Yangi',
  received: 'Qabul qilindi',
  'on the road': "Yo'lda",
  waiting: 'Kutilmoqda',
  waiting_customer: 'Mijoz kutilmoqda',
  sold: 'Sotildi',
  partly_paid: 'Qisman sotildi',
  paid: "To'langan",
  cancelled: 'Bekor qilindi',
  'cancelled (sent)': 'Bekor (jo‘natilgan)',
  returned_to_market: 'Marketga qaytdi',
  closed: 'Yopildi',
};

export const OP_LABEL: Record<CourierOp, string> = {
  sell: '✅ Sotildi',
  cancel: '❌ Bekor',
  cnd: "🕗 Yetkazib bo'lmadi",
  rollback: '↩️ Ortga qaytarish',
};

/**
 * (MO2MLPGo #3) Sabablar — YOPIQ ro'yxat (erkin matn yo'q).
 * Bekor: gateway `CancelReason` enumi (OTHER — izoh talab qiladi, shuning
 * uchun botda yo'q). Yetkazib bo'lmadi: `reason` ≥10 belgi.
 */
export const CANCEL_REASONS: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'CUSTOMER_NO_ANSWER', label: '📵 Mijoz javob bermadi' },
  { code: 'CUSTOMER_REFUSED', label: '🙅 Mijoz rad etdi' },
  { code: 'WRONG_ADDRESS', label: "📍 Manzil noto'g'ri" },
  { code: 'DEFECTIVE_PRODUCT', label: '🧩 Mahsulot nuqsonli' },
  { code: 'PRICE_DISPUTE', label: "💸 Narx bo'yicha kelishmovchilik" },
];

export const CND_REASONS: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'no_answer', label: "📵 Mijoz telefonni ko'tarmadi" },
  { code: 'not_home', label: "🏠 Mijoz manzilda yo'q" },
  { code: 'reschedule', label: "📅 Mijoz boshqa kunga ko'chirdi" },
  { code: 'no_address', label: '🧭 Manzil topilmadi' },
];

/** Yetkazib bo'lmadi sababi → gateway `reason` (≥10 belgi). */
export function cndReasonText(code: string): string | null {
  const reason = CND_REASONS.find((item) => item.code === code);
  return reason ? reason.label.replace(/^\S+\s/, '') : null;
}

export function cancelReasonValid(code: string): boolean {
  return CANCEL_REASONS.some((item) => item.code === code);
}

/**
 * (h9newLsd #4) Faqat shu holatdan MUMKIN bo'lgan amallar (aks holda kuryer
 * bosadi va 400 oladi) — order-status.machine + gateway tekshiruvlari:
 * sell/cancel — faqat WAITING; yetkazib bo'lmadi — faqat ON_THE_ROAD;
 * kuryer rollback — SOLD / CANCELLED.
 */
export function opsForStatus(status: string): CourierOp[] {
  switch (status) {
    case 'waiting':
      return ['sell', 'cancel'];
    case 'on the road':
      return ['cnd'];
    case 'sold':
    case 'cancelled':
      return ['rollback'];
    default:
      return [];
  }
}

/** Pul — `numeric` satr bo'lib kelishi mumkin: avval Number(). */
export function formatSum(value: unknown): string {
  const amount = Number(
    typeof value === 'string' || typeof value === 'number' ? value : 0,
  );
  const safe = Number.isFinite(amount) ? Math.round(amount) : 0;
  const sign = safe < 0 ? '-' : '';
  return `${sign}${String(Math.abs(safe)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so'm`;
}

export interface CourierOrderView {
  id: string;
  status: string;
  total_price: unknown;
  district: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  market_id: string | null;
  proof_conditions: string[];
}

const text = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

/** Gateway buyurtma qatori (enrichOrders) → kartaga kerakli maydonlar. */
export function toCourierOrderView(row: unknown): CourierOrderView | null {
  if (!row || typeof row !== 'object') return null;
  const order = row as Record<string, unknown>;
  const id = text(order.id);
  if (!id) return null;
  const district = order.district as { name?: unknown } | null | undefined;
  const customer = order.customer as
    { name?: unknown; phone_number?: unknown } | null | undefined;
  const market = order.market as
    { id?: unknown; expense_proof_conditions?: unknown } | null | undefined;
  const conditions = Array.isArray(market?.expense_proof_conditions)
    ? (market.expense_proof_conditions as unknown[]).map((item) => text(item))
    : [];
  return {
    id,
    status: text(order.status),
    total_price: order.total_price,
    district: text(district?.name) || null,
    customer_name: text(customer?.name) || null,
    customer_phone: text(customer?.phone_number) || null,
    market_id: text(order.market_id ?? market?.id) || null,
    proof_conditions: conditions,
  };
}

/**
 * Karta matni (FAQAT shaxsiy chat — mijoz ismi va telefoni bor; 10-karta
 * siyosati: guruhga hech qachon). 4096 belgidan oshmaydi.
 */
export function courierCardText(
  order: CourierOrderView,
  note?: string,
): string {
  const emoji = STATUS_EMOJI[order.status] ?? '•';
  const lines = [
    `${emoji} <b>#${escapeTelegramHtml(order.id)}</b> — ${escapeTelegramHtml(STATUS_LABEL_UZ[order.status] ?? order.status)}`,
    `📍 ${escapeTelegramHtml(order.district ?? "Tuman ko'rsatilmagan")}`,
    `💰 ${formatSum(order.total_price)}`,
  ];
  if (order.customer_name) {
    lines.push(`👤 ${escapeTelegramHtml(order.customer_name.slice(0, 120))}`);
  }
  if (order.customer_phone) {
    lines.push(`📞 ${escapeTelegramHtml(order.customer_phone.slice(0, 32))}`);
  }
  if (note) lines.push('', note);
  return lines.join('\n').slice(0, 4000);
}

/** Kabinet havolasi (partly-sell va katta isbot — brauzerda). */
export function cabinetOrderUrl(base: string, orderId: string): string {
  return `${base.replace(/\/+$/, '')}/orders?search=${encodeURIComponent(orderId)}`;
}

export function cabinetButton(
  base: string,
  orderId: string,
): InlineKeyboardButton {
  return { text: '🌐 Kabinetda ochish', url: cabinetOrderUrl(base, orderId) };
}

/** Isbot talab qilinadimi (bot extraCost yubormaydi — faqat *_any / *_zero_total). */
export function proofRequired(order: CourierOrderView, op: CourierOp): boolean {
  if (op !== 'sell' && op !== 'cancel') return false;
  const zeroTotal = Number(order.total_price) <= 0;
  const conditions = new Set(order.proof_conditions);
  if (op === 'sell') {
    return (
      conditions.has('sell_any') ||
      (zeroTotal && conditions.has('sell_zero_total'))
    );
  }
  return (
    conditions.has('cancel_any') ||
    (zeroTotal && conditions.has('cancel_zero_total'))
  );
}
