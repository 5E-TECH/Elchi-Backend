import {
  CANCEL_RETURN_STAGES,
  parseCancelReturnStages,
  type CancelReturnStage,
} from '@app/common';

/**
 * BEKOR HOLATLARI — bekor qilingan / qaytgan posilka QAYERDA va marketga QANDAY
 * topshirildi (ega qarori 2026-10-19; Trello BG1–BG3: 5Yy6r6UI, fL79tFbs,
 * M0EPcJVf).
 *
 * Bu faylda faqat sof qoidalar (DB/RPC yo'q) — order-service ro'yxat/detal
 * boyitishi, topshirish yo'llari va filtrlar shu yerdagi YAGONA ta'rifni
 * ishlatadi.
 */

/**
 * fL79tFbs (BG2) — marketga topshirish USULI (`orders.market_handover_method`,
 * tracking `metadata.method`):
 *   - `qr`     — market QR'i skan qilingan ruxsat (MHA) bilan;
 *   - `manual` — market QR sessiyasi ichida, posilka yorlig'i shikastlangani
 *                sabab qo'lda tasdiq (`manual_overrides`);
 *   - `no_qr`  — QR talab qilinmasdan (eski market sozlamasi; hozir yo'l yopiq,
 *                faqat eski yozuvlar);
 *   - `pin`    — zaxira PIN (BG6, keyingi karta).
 * Migratsiya 1716000000154 CHECK cheklovi aynan shu ro'yxat.
 */
export const CANCEL_HANDOVER_METHODS = [
  'qr',
  'manual',
  'no_qr',
  'pin',
] as const;
export type CancelHandoverMethod = (typeof CANCEL_HANDOVER_METHODS)[number];

/** Topshirish tracking hodisasi `action` lari (frontend `actionLabelMap` bilan bir xil). */
export const CANCEL_HANDOVER_TRACKING_ACTION: Readonly<
  Record<'qr' | 'manual', string>
> = {
  qr: 'returned_to_market',
  manual: 'cancelled_market_handover_manual',
};

/**
 * 5Yy6r6UI (BG1) — bekor qilingan posilkaning JOY BOSQICHI (`return_stage`,
 * `cancel_return.stage`). Buyurtma holati va holat mashinasi o'zgarmaydi —
 * bosqich holat + `holder_*` + `post_id` / `canceled_post_id` dan HOSILA
 * (BeePost `return_stage` naqshi). Elchi-Frontend
 * `entities/order/model/cancelReturnStage.ts` dagi zaxira hisob bilan AYNAN
 * bir xil qoida (FE backend qiymatini o'qiydi, o'zinikini — faqat zaxira):
 *
 *   courier    «Bekor · kuryerda»      status=cancelled, holder COURIER
 *   in_transit «Bekor · yo'lda»        status=cancelled (sent) — jo'natishda
 *                                      holder allaqachon MAQSAD (joy — maqsad)
 *   branch     «Bekor · filialda»      status=cancelled, holder BRANCH, `post_id`
 *                                      bor, `canceled_post_id` yo'q
 *   hq         «Bekor · HQ'da»         status=cancelled, holder HQ, `post_id`
 *                                      (yoki `canceled_post_id`) bor
 *   market     «Marketga topshirildi»  status=returned_to_market, yoki holder
 *                                      MARKET (F4 dan oldingi `closed` ham)
 *
 * Qabulgacha bekor qilingan (`created`/`new` → `cancelled`) buyurtmada `post_id`
 * bo'sh — posilka marketdan chiqmagan: bosqich `null` (taxmin qilinmaydi).
 */
export { CANCEL_RETURN_STAGES, parseCancelReturnStages };
export type { CancelReturnStage };

const STATUS_CANCELLED = 'cancelled';
const STATUS_CANCELLED_SENT = 'cancelled (sent)';
const STATUS_RETURNED_TO_MARKET = 'returned_to_market';
const STATUS_CLOSED = 'closed';

/** Bosqich hisobiga kerak bo'lgan buyurtma maydonlari (entity yoki xom qator). */
export interface CancelReturnStageInput {
  status?: unknown;
  holder_type?: unknown;
  holder_courier_id?: unknown;
  post_id?: unknown;
  canceled_post_id?: unknown;
}

const text = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

/** `'0'` — tayinlanmagan pochta sentineli, kuryer emas. */
const realId = (value: unknown): string | null => {
  const id = text(value);
  return /^\d+$/.test(id) && id !== '0' ? id : null;
};

export function resolveCancelReturnStage(
  order: CancelReturnStageInput | null | undefined,
): CancelReturnStage | null {
  if (!order) return null;
  const status = text(order.status).toLowerCase();
  const holder = text(order.holder_type).toUpperCase();

  if (status === STATUS_RETURNED_TO_MARKET) return 'market';
  if (status === STATUS_CLOSED && holder === 'MARKET') return 'market';
  if (status !== STATUS_CANCELLED && status !== STATUS_CANCELLED_SENT) {
    return null;
  }
  if (holder === 'MARKET') return 'market';
  if (status === STATUS_CANCELLED_SENT) return 'in_transit';

  const cancelledPostId = text(order.canceled_post_id);
  const received = Boolean(text(order.post_id) || cancelledPostId);
  switch (holder) {
    case 'HQ':
      return received ? 'hq' : null;
    case 'BRANCH':
      return received && !cancelledPostId ? 'branch' : null;
    case 'COURIER':
      return 'courier';
    default:
      // Eski yozuvlar: holder bo'sh, lekin ushlab turgan kuryer bor.
      return realId(order.holder_courier_id) ? 'courier' : null;
  }
}

/** Joy turi: kuryer, filial yoki HQ (HQ ham filial jadvalida). */
export type CancelReturnPlaceType = 'COURIER' | 'BRANCH' | 'HQ';

/**
 * 5Yy6r6UI (BG1) — javobdagi `cancel_return` obyekti (bekor bo'lmagan
 * buyurtmada `null`). Pul maydonlari yo'q — hamma rolga bir xil.
 *
 *   - `place_*` — posilka HOZIR qayerda: kuryer (ism), filial yoki HQ (nom);
 *     `in_transit` da — qayerga ketyapti (maqsad), `market` da — qayerda
 *     topshirilgan;
 *   - `received_at` — `branch` / `hq`: shu joyda qachondan beri (oxirgi bekor
 *     pochta qabuli, bo'lmasa custody o'tgan vaqt) — «N kun» va BG7 eslatmasi
 *     shundan;
 *   - `sent_at` — `in_transit`: jo'natilgan vaqt;
 *   - `handed_over_at`, `handover_method` — `market`: topshirilgan vaqt va usul
 *     (BG2 ustunlari; eski yozuvda usul `null` bo'lishi mumkin).
 */
export interface CancelReturnView {
  stage: CancelReturnStage;
  place_type: CancelReturnPlaceType | null;
  place_id: string | null;
  place_name: string | null;
  received_at: string | null;
  sent_at: string | null;
  handed_over_at: string | null;
  handover_method: CancelHandoverMethod | null;
}

export interface CancelReturnViewInput extends CancelReturnStageInput {
  id?: unknown;
  courier_id?: unknown;
  branch_id?: unknown;
  holder_branch_id?: unknown;
  last_handover_at?: unknown;
  market_handover_at?: unknown;
  market_handover_method?: unknown;
  market_handover_branch_id?: unknown;
}

export interface CancelReturnContext {
  hqBranchId: string | null;
  /** Filial (HQ ham) id → nom. */
  branchNames: ReadonlyMap<string, string>;
  /** Kuryer id → ism. */
  courierNames: ReadonlyMap<string, string | null>;
  /** Buyurtma id → oxirgi `cancelled_post_received` hodisasi vaqti. */
  receivedAt: ReadonlyMap<string, Date>;
}

const toDate = (value: unknown): Date | null => {
  if (value === null || value === undefined || value === '') return null;
  const date =
    value instanceof Date
      ? value
      : new Date(
          typeof value === 'string' && /^\d+$/.test(value.trim())
            ? Number(value)
            : (value as string | number),
        );
  return Number.isFinite(date.getTime()) ? date : null;
};

const iso = (value: unknown): string | null =>
  toDate(value)?.toISOString() ?? null;

const isHandoverMethod = (value: unknown): value is CancelHandoverMethod =>
  (CANCEL_HANDOVER_METHODS as readonly unknown[]).includes(value);

/** Bosqich uchun kerakli kuryer id'si (ism yuklash uchun ham). */
export function cancelReturnCourierId(
  order: CancelReturnViewInput,
): string | null {
  return realId(order.holder_courier_id) ?? realId(order.courier_id);
}

/** Bosqich joyining filial id'si (HQ — `hqBranchId`), ism yuklash uchun ham. */
export function cancelReturnBranchId(
  order: CancelReturnViewInput,
  stage: CancelReturnStage,
  hqBranchId: string | null,
): string | null {
  const holder = text(order.holder_type).toUpperCase();
  switch (stage) {
    case 'courier':
      return null;
    case 'hq':
      return (
        hqBranchId ?? realId(order.holder_branch_id) ?? realId(order.branch_id)
      );
    case 'in_transit':
      return holder === 'HQ'
        ? (hqBranchId ?? realId(order.branch_id))
        : (realId(order.holder_branch_id) ?? realId(order.branch_id));
    case 'branch':
      return realId(order.holder_branch_id) ?? realId(order.branch_id);
    case 'market':
      return realId(order.market_handover_branch_id) ?? realId(order.branch_id);
  }
}

export function buildCancelReturnView(
  order: CancelReturnViewInput,
  ctx: CancelReturnContext,
): CancelReturnView | null {
  const stage = resolveCancelReturnStage(order);
  if (!stage) return null;

  const view: CancelReturnView = {
    stage,
    place_type: null,
    place_id: null,
    place_name: null,
    received_at: null,
    sent_at: null,
    handed_over_at: null,
    handover_method: null,
  };

  if (stage === 'courier') {
    const courierId = cancelReturnCourierId(order);
    view.place_type = courierId ? 'COURIER' : null;
    view.place_id = courierId;
    view.place_name = courierId
      ? (ctx.courierNames.get(courierId) ?? null)
      : null;
    return view;
  }

  const branchId = cancelReturnBranchId(order, stage, ctx.hqBranchId);
  view.place_id = branchId;
  view.place_name = branchId ? (ctx.branchNames.get(branchId) ?? null) : null;
  view.place_type = branchId
    ? stage === 'hq' || (ctx.hqBranchId !== null && branchId === ctx.hqBranchId)
      ? 'HQ'
      : 'BRANCH'
    : null;

  if (stage === 'in_transit') {
    view.sent_at = iso(order.last_handover_at);
  } else if (stage === 'branch' || stage === 'hq') {
    // Jo'natishda custody allaqachon maqsadga o'tadi (`last_handover_at` —
    // jo'natish vaqti); haqiqiy qabul — `cancelled_post_received` hodisasi.
    const custodyAt = toDate(order.last_handover_at);
    const receivedAt = ctx.receivedAt.get(text(order.id)) ?? null;
    view.received_at = iso(
      receivedAt && (!custodyAt || receivedAt >= custodyAt)
        ? receivedAt
        : custodyAt,
    );
  } else {
    view.handed_over_at = iso(
      order.market_handover_at ?? order.last_handover_at,
    );
    view.handover_method = isHandoverMethod(order.market_handover_method)
      ? order.market_handover_method
      : null;
  }
  return view;
}

/**
 * M0EPcJVf (BG3) — bosqichning SQL sharti (`resolveCancelReturnStage` bilan
 * AYNAN bir xil; pg spec ikkalasini bir xil qatorlarda solishtiradi). `alias` —
 * TypeORM so'rov aliasi (`order`). Qiymatlar o'zgarmas — parametr kerak emas.
 */
export function cancelReturnStageSql(
  stage: CancelReturnStage,
  alias = 'order',
): string {
  const a = alias;
  switch (stage) {
    case 'courier':
      return `(${a}.status = 'cancelled' AND (${a}.holder_type = 'COURIER' OR (${a}.holder_type IS NULL AND ${a}.holder_courier_id IS NOT NULL AND ${a}.holder_courier_id <> 0)))`;
    case 'in_transit':
      return `(${a}.status = 'cancelled (sent)' AND ${a}.holder_type IS DISTINCT FROM 'MARKET')`;
    case 'branch':
      return `(${a}.status = 'cancelled' AND ${a}.holder_type = 'BRANCH' AND ${a}.post_id IS NOT NULL AND ${a}.canceled_post_id IS NULL)`;
    case 'hq':
      return `(${a}.status = 'cancelled' AND ${a}.holder_type = 'HQ' AND (${a}.post_id IS NOT NULL OR ${a}.canceled_post_id IS NOT NULL))`;
    case 'market':
      return `(${a}.status = 'returned_to_market' OR (${a}.status IN ('closed', 'cancelled', 'cancelled (sent)') AND ${a}.holder_type = 'MARKET'))`;
  }
}

/**
 * M0EPcJVf (BG3) — «Marketga topshirildi» vaqti SQL ifodasi (sana oralig'i
 * filtri uchun): BG2 ustuni, eski yozuvda — custody vaqti
 * (`buildCancelReturnView.handed_over_at` bilan bir xil).
 */
export const cancelReturnHandoverAtSql = (alias = 'order'): string =>
  `COALESCE(${alias}.market_handover_at, ${alias}.last_handover_at)`;
