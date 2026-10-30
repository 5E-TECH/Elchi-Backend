import { Order_status } from '@app/common';
import { Repository } from 'typeorm';
import { Order, Order_source } from '../entities/order.entity';

/**
 * QOP BO'YICHA SONLAR (Sm3LZ6EN) — «Hamkor 3 ta dedi, 2 tasi keldi».
 *
 * ⚠️ NEGA BACKEND SANAYDI. Frontend faqat joriy sahifadagi NEW buyurtmalarni
 * ko'radi va «1/3» yoki «3/3» chiqarardi: ilgari qabul qilingan a'zo ham,
 * boshqa sahifadagi a'zo ham unga ko'rinmaydi. Har qop uchun alohida
 * `GET /scan/:token` esa N+1 bo'lardi. Shuning uchun bitta GROUP BY.
 *
 * «Keldi» soni = `received_count + pending_count`; `external_batch_size` esa
 * hamkor AYTGAN son (order.entity izohi), ikkisi farq qilsa qop chala.
 */
export interface ExternalBatchCount {
  external_batch_token: string;
  external_batch_ref: string | null;
  external_batch_size: number | null;
  /** NEW dan keyingi holatdagi (qabul qilingan) a'zolar. */
  received_count: number;
  /** Hali NEW a'zolar. */
  pending_count: number;
}

/** Qop QR'i skanerlanganda javobdagi `batch` (Sm3LZ6EN, S5). */
export interface ScannedExternalBatch {
  external_batch_token: string;
  size: number | null;
  received_count: number;
  pending_count: number;
  /**
   * Shu skan qamragan a'zolar: `receive-by-scan` — shu so'rovda qabul
   * qilinganlari (`received_count` ichida), `/scan/:token` — qabulni
   * kutayotganlari (`pending_count` bilan teng, hech narsa qabul qilinmagan).
   */
  scanned_count: number;
}

/**
 * Son doirasi — `findAllExternal` ga gateway uzatadigan AYNI ikki maydon.
 *
 * ⚠️ `market_id` SHART: `external_batch_token` bazada noyob emas (hamkor o'zi
 * beradi), ya'ni ikki hamkorning qopi bir xil tokenli bo'lishi mumkin. Doirasiz
 * sanalsa market BEGONA qop sonini ko'rardi.
 */
export interface ExternalBatchScope {
  market_id?: string;
  branch_id?: string;
}

/** Sahifadagi noyob qop tokenlari, ro'yxat tartibida. */
export const uniqueBatchTokens = (
  rows: ReadonlyArray<{ external_batch_token?: string | null }>,
): string[] => [
  ...new Set(
    rows
      .map((row) => String(row.external_batch_token ?? ''))
      .filter((token) => token.length > 0),
  ),
];

export const toScannedBatch = (
  count: ExternalBatchCount,
  scanned_count: number,
): ScannedExternalBatch => ({
  external_batch_token: count.external_batch_token,
  size: count.external_batch_size,
  received_count: count.received_count,
  pending_count: count.pending_count,
  scanned_count,
});

/**
 * Berilgan qoplar uchun bitta GROUP BY: sahifa/limit, status va sana bilan
 * kesilmaydi, faqat o'chirilmagan buyurtmalar. Filial sharti va manba sharti
 * `buildOrderListQuery` dagi bilan AYNI — son ro'yxat doirasidan chiqmaydi.
 *
 * ⚠️ QABUL QILINGAN = `created`/`new` dan keyingi holat, LEKIN pochtasiz
 * `cancelled` EMAS. Hamkor posilkani qabuldan oldin bekor qila oladi
 * (`cancelPreDeliveryOrder`: NEW -> CANCELLED, `post_id` yo'q) — u Elchiga
 * umuman yetib kelmagan. Qabul qilinganini bekor qilish esa pochtasiz
 * bo'lmaydi (`cancelOrder` `post_id` talab qiladi, `receiveNewOrders` yozadi).
 */
export async function countExternalBatches(
  orderRepo: Repository<Order>,
  tokens: readonly string[],
  scope: ExternalBatchScope,
): Promise<ExternalBatchCount[]> {
  if (!tokens.length) return [];

  const qb = orderRepo
    .createQueryBuilder('order')
    .select('order.external_batch_token', 'external_batch_token')
    .addSelect('MAX(order.external_batch_ref)', 'external_batch_ref')
    .addSelect('MAX(order.external_batch_size)', 'external_batch_size')
    .addSelect(
      `COUNT(*) FILTER (WHERE order.status NOT IN (:...batch_before_receive)
        AND NOT (order.status = :batch_cancelled AND order.post_id IS NULL))`,
      'received_count',
    )
    .addSelect(
      'COUNT(*) FILTER (WHERE order.status = :batch_pending)',
      'pending_count',
    )
    // Literal `false` — qisman indeks IDX_ORDER_EXTERNAL_BATCH_TOKEN sharti.
    .where('order.isDeleted = false')
    .andWhere('order.external_batch_token IN (:...batch_tokens)', {
      batch_tokens: [...tokens],
    })
    .andWhere(
      '(order.source = :batch_source OR order.external_id IS NOT NULL)',
      { batch_source: Order_source.EXTERNAL },
    )
    .setParameters({
      batch_before_receive: [Order_status.CREATED, Order_status.NEW],
      batch_cancelled: Order_status.CANCELLED,
      batch_pending: Order_status.NEW,
    })
    .groupBy('order.external_batch_token');

  if (scope.market_id) {
    qb.andWhere('order.market_id = :batch_market_id', {
      batch_market_id: scope.market_id,
    });
  }
  if (scope.branch_id) {
    qb.andWhere(
      `(order.branch_id = :batch_branch_id
        OR order.holder_branch_id = :batch_branch_id
        OR order.home_branch_id = :batch_branch_id)`,
      { batch_branch_id: scope.branch_id },
    );
  }

  const rows = await qb.getRawMany<{
    external_batch_token: string;
    external_batch_ref: string | null;
    external_batch_size: number | null;
    received_count: string;
    pending_count: string;
  }>();

  const byToken = new Map(rows.map((row) => [row.external_batch_token, row]));
  return tokens.flatMap((token) => {
    const row = byToken.get(token);
    if (!row) return [];
    return [
      {
        external_batch_token: row.external_batch_token,
        external_batch_ref: row.external_batch_ref ?? null,
        external_batch_size:
          row.external_batch_size === null ||
          row.external_batch_size === undefined
            ? null
            : Number(row.external_batch_size),
        received_count: Number(row.received_count),
        pending_count: Number(row.pending_count),
      },
    ];
  });
}
