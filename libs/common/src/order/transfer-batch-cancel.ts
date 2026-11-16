import { BranchTransferBatchStatus } from '../../enums';

/**
 * oP02jE2P — filial paketini bekor qilish qoidasi (`POST /transfer-batches/:id/cancel`).
 *
 * Bekor qilish paketdagi buyurtmalarni paketdan yechadi va FORWARD paketda
 * ularni `new` holatiga (manba filialda) qaytaradi. Yo'ldagi (`SENT`) paketni
 * bekor qilish posilkalarni tizimda «filialda» qoldirardi, aslida esa ular
 * yo'lda yoki manzil filialda bo'lardi. Shuning uchun:
 *
 *  - faqat hali jo'natilmagan (`PENDING`) paket bekor qilinadi;
 *  - `SENT` (yo'lda, qisman qabul qilingani ham) — HECH KIMGA ruxsat yo'q,
 *    superadmin va admin ham emas: 409 `data.reason = batch_in_transit`.
 *    Paketni manzil filial qabul qiladi, keraksiz buyurtmalar qaytarish paketi
 *    bilan qaytariladi;
 *  - `RECEIVED` — 400 `batch_received`, `CANCELLED` — 400
 *    `batch_already_cancelled` (status kodi avvalgidek, faqat `reason` qo'shildi).
 *
 * Kim bekor qila oladi — o'zgarmagan (wLNccBkX): superadmin, admin va paketni
 * yig'gan (manba) filialning registratori yoki menejeri (yoki menejer daraxti).
 *
 * Tekshiruv ikki joyda: branch-service (`order.transfer_batch.find_by_id`
 * natijasi bo'yicha — gateway javobiga `data.reason` shu yerdan boradi) va
 * order-service tranzaksiyasida (qator qulflangan holda — oraliqda jo'natilgan
 * paket ham bekor bo'lmaydi).
 */
export const TRANSFER_BATCH_CANCEL_REASONS = {
  /** Paket jo'natilgan (yo'lda) — 409. */
  IN_TRANSIT: 'batch_in_transit',
  /** Paket manzil filialda qabul qilingan — 400. */
  RECEIVED: 'batch_received',
  /** Paket allaqachon bekor qilingan — 400. */
  ALREADY_CANCELLED: 'batch_already_cancelled',
  /** Boshqa (noma'lum) holat — 400. */
  NOT_CANCELLABLE: 'batch_not_cancellable',
} as const;

export type TransferBatchCancelReason =
  (typeof TRANSFER_BATCH_CANCEL_REASONS)[keyof typeof TRANSFER_BATCH_CANCEL_REASONS];

export const TRANSFER_BATCH_IN_TRANSIT_MESSAGE =
  "Paket yo'lda — jo'natilgan paketni bekor qilib bo'lmaydi. Uni manzil filial qabul qiladi, keraksiz buyurtmalar qaytarish paketi bilan qaytariladi";
export const TRANSFER_BATCH_RECEIVED_MESSAGE =
  "Qabul qilingan paketni bekor qilib bo'lmaydi";
export const TRANSFER_BATCH_ALREADY_CANCELLED_MESSAGE =
  'Paket allaqachon bekor qilingan';
export const TRANSFER_BATCH_NOT_CANCELLABLE_MESSAGE =
  "Paketni bu holatda bekor qilib bo'lmaydi";

export interface TransferBatchCancelBlock {
  statusCode: 400 | 409;
  message: string;
  reason: TransferBatchCancelReason;
}

const CANCEL_BLOCKS: Readonly<Record<string, TransferBatchCancelBlock | null>> =
  {
    [BranchTransferBatchStatus.PENDING]: null,
    [BranchTransferBatchStatus.SENT]: {
      statusCode: 409,
      message: TRANSFER_BATCH_IN_TRANSIT_MESSAGE,
      reason: TRANSFER_BATCH_CANCEL_REASONS.IN_TRANSIT,
    },
    [BranchTransferBatchStatus.RECEIVED]: {
      statusCode: 400,
      message: TRANSFER_BATCH_RECEIVED_MESSAGE,
      reason: TRANSFER_BATCH_CANCEL_REASONS.RECEIVED,
    },
    [BranchTransferBatchStatus.CANCELLED]: {
      statusCode: 400,
      message: TRANSFER_BATCH_ALREADY_CANCELLED_MESSAGE,
      reason: TRANSFER_BATCH_CANCEL_REASONS.ALREADY_CANCELLED,
    },
  };

const NOT_CANCELLABLE_BLOCK: TransferBatchCancelBlock = {
  statusCode: 400,
  message: TRANSFER_BATCH_NOT_CANCELLABLE_MESSAGE,
  reason: TRANSFER_BATCH_CANCEL_REASONS.NOT_CANCELLABLE,
};

/**
 * Paket holati bekor qilishga ruxsat beradimi. `null` — ruxsat (faqat
 * `PENDING`), aks holda xato tafsiloti (status kodi, o'zbekcha matn, kod).
 */
export function transferBatchCancelBlock(
  status: unknown,
): TransferBatchCancelBlock | null {
  const normalized = (typeof status === 'string' ? status : '')
    .trim()
    .toUpperCase();
  return Object.prototype.hasOwnProperty.call(CANCEL_BLOCKS, normalized)
    ? CANCEL_BLOCKS[normalized]
    : NOT_CANCELLABLE_BLOCK;
}
