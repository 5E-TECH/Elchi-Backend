import { orderExportStatusLabel } from './orders-xlsx.export';

/**
 * 9Bp7VtVj (2-tur, tester 2026-10-25): ro'yxatdagi bekor buyurtma belgisi
 * bosqichni ko'rsatadi (FE `OrderStatusBadge`, `status.json` → `cancelStage.*`),
 * eksport ham shuni yozsin. Bosqich order-service `return_stage` (BG1) dan.
 */
describe('9Bp7VtVj — eksport «Holati»: bekor bosqichi va omborga qaytish = ekran', () => {
  it.each<[string, Record<string, unknown>, string]>([
    [
      'kuryerda',
      { status: 'cancelled', return_stage: 'courier' },
      'Bekor · kuryerda',
    ],
    [
      "yo'lda (jo'natilgan)",
      {
        status: 'cancelled',
        transport_status: 'cancelled (sent)',
        return_stage: 'in_transit',
      },
      "Bekor · yo'lda",
    ],
    [
      'filialda',
      { status: 'cancelled', return_stage: 'branch' },
      'Bekor · filialda',
    ],
    ["HQ'da", { status: 'cancelled', return_stage: 'hq' }, "Bekor · HQ'da"],
    [
      'marketga topshirilgan',
      { status: 'returned_to_market', return_stage: 'market' },
      'Marketga topshirildi',
    ],
    [
      'cancel_return.stage ham o`qiladi',
      { status: 'cancelled', cancel_return: { stage: 'courier' } },
      'Bekor · kuryerda',
    ],
    [
      'ombor buyurtmasi omborga qaytgan (backend bosqichi null)',
      {
        status: 'returned_to_market',
        fulfillment_source: 'WAREHOUSE',
        return_stage: null,
      },
      'Omborga qaytdi',
    ],
    [
      'ombor buyurtmasi «market» bosqichida (FE isWarehouseReturn)',
      {
        status: 'returned_to_market',
        fulfillment_source: 'WAREHOUSE',
        return_stage: 'market',
      },
      'Omborga qaytdi',
    ],
    [
      'bosqichsiz bekor (qabulgacha) — holat nomi',
      { status: 'cancelled', return_stage: null },
      'Bekor qilingan',
    ],
    [
      'bekor emas — holat nomi',
      { status: 'sold', return_stage: null },
      'Sotilgan',
    ],
    [
      'HQ buyurtmasi, ombor emas — marketga topshirildi',
      {
        status: 'returned_to_market',
        fulfillment_source: 'HQ',
        return_stage: 'market',
      },
      'Marketga topshirildi',
    ],
  ])('%s', (_name, order, label) => {
    expect(orderExportStatusLabel(order)).toBe(label);
  });
});
