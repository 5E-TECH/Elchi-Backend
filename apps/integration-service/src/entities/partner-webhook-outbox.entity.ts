import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

/**
 * C2.3 — Elchi → hamkor (marketplace) chiquvchi webhook outbox'i.
 *
 * Elchi order statusi o'zgarganda (partner_shipment_ref bor bo'lsa) shu jadvalga
 * bitta qator yoziladi va scheduler uni hamkorning `webhook_url`'iga HMAC-imzoli
 * (`X-Elchi-Signature`) POST qiladi. Xatoda backoff (1m/5m/15m) bilan qayta
 * uriniladi; muvaffaqiyatda `completed` bo'lib qayta yuborilmaydi (dedup).
 *
 * Dedup: `(partner_id, order_id, new_status)` UNIQUE, lekin **QISMAN** —
 * faqat `status IN ('pending','processing')` qatorlar ustida (G2 tuzatishi).
 *
 * NEGA QISMAN. Avval indeks TO'LIQ unique edi va bu jimgina ma'lumot yo'qotishga
 * olib kelardi: buyurtma `sold` → operator rollback qildi → `waiting` → kuryer
 * qayta sotdi → `sold`. Ikkinchi `sold` allaqachon yetkazilgan (`completed`)
 * qatorga urilib, "dublikat" deb TASHLAB YUBORILARDI — hamkor tomonda buyurtma
 * abadiy sotilmagan holatda qolardi (pul desinxroni).
 *
 * Qisman indeks ikki maqsadni ham bajaradi:
 *   - takroriy EMIT (RMQ redelivery, ikki marta chaqiruv) — hamon to'siladi,
 *     chunki uchuvchi (`pending`/`processing`) qator bor;
 *   - takroriy HODISA (status haqiqatan qayta yuz berdi) — endi o'tadi, chunki
 *     oldingi qator `completed`/`permanently_failed` bo'lib indeksdan chiqadi.
 *
 * Qoldiq poyga: status yetkazilish jarayonida (odatda <1s) qayta yuz bersa,
 * ikkinchisi dedupga tushishi mumkin. Shu bois payloadda `event_id` bor —
 * qabul qiluvchi takrorni o'zi ham ajrata oladi.
 *
 * Ataylab ExternalIntegration `sync_queue`'dan AJRATILGAN — u ExternalIntegration
 * `integration_id`'ga (NOT NULL + FK) bog'langan; hamkor webhook'lari esa
 * `partner_id`'ga bog'lanadi. Kontrakt: docs/PARTNER_API.md §4.
 */
export type PartnerWebhookStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  /**
   * Hamkorda `webhook_url` SOZLANMAGAN — yuborishga manzil yo'q.
   *
   * ⚠️ ILGARI BU HOLAT `completed` DEB YOPILARDI. Ya'ni sozlama yo'qligi
   * jimgina "muvaffaqiyat" deb hisoblanardi va hodisa BUTUNLAY YO'QOLARDI:
   * keyinroq `webhook_url` qo'yilganda ham hech narsa yetkazilmasdi va
   * nosozlik hech qaysi ekranda ko'rinmasdi.
   *
   * Endi alohida holat: urinish HISOBLANMAYDI (yuborishga harakat ham
   * qilinmadi), ishchi so'rovga tushmaydi, lekin `webhook_url` qo'yilgan
   * zahoti `pending`ga qaytariladi va yetkaziladi.
   */
  | 'awaiting_config'
  | 'permanently_failed';

@Entity({ name: 'partner_webhook_outbox' })
@Index('IDX_PWO_STATUS_RETRY', ['status', 'next_retry_at'])
@Index('IDX_PWO_DEDUP', ['partner_id', 'order_id', 'new_status'], {
  unique: true,
  // Faqat uchuvchi qatorlar ustida — sababi yuqorida (G2).
  where: `status IN ('pending', 'processing')`,
})
export class PartnerWebhookOutbox extends BaseEntity {
  /** Qaysi hamkorga yuboriladi (partners.id). */
  @Column({ type: 'bigint' })
  partner_id!: string;

  /** Elchi ichki buyurtma id (order.id) = hamkordagi shipment_id. */
  @Column({ type: 'bigint' })
  order_id!: string;

  /** Hamkor tomonidagi buyurtma id (idempotency/teskari qidiruv). */
  @Column({ type: 'varchar' })
  external_order_id!: string;

  /** Hodisa turi — hozircha `shipment.status_changed`. */
  @Column({ type: 'varchar' })
  event_type!: string;

  /** Elchi Order_status (sold | cancelled | ...) — dedup kaliti qismi. */
  @Column({ type: 'varchar', nullable: true })
  new_status!: string | null;

  /** Yuboriladigan JSON tanasi (imzo aynan shu ustidan hisoblanadi). */
  @Column({ type: 'jsonb' })
  payload!: Record<string, any>;

  @Column({ type: 'varchar', default: 'pending' })
  status!: PartnerWebhookStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'int', default: 4 })
  max_attempts!: number;

  @Column({ type: 'text', nullable: true })
  last_error!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  last_response!: Record<string, any> | null;

  @Column({ type: 'timestamptz', nullable: true })
  next_retry_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  delivered_at!: Date | null;

  /**
   * Oxirgi urinishning HTTP javob vaqti (ms).
   *
   * NEGA KERAK. Integratsiya panelida "o'rtacha javob vaqti" ko'rsatiladi va
   * u sekinlashuvni ERTA aniqlashning yagona belgisi: hamkor hali 200
   * qaytarib turadi-yu, javob vaqti 200 ms dan 8 s ga o'sgan bo'lsa,
   * keyingi qadam — timeout va yo'qolgan hodisa.
   *
   * Ilgari hech qayerda o'lchanmasdi, ya'ni bu metrikani ko'rsatishning
   * imkoni yo'q edi (uydirma raqam ko'rsatishdan ko'ra o'lchash to'g'ri).
   *
   * `null` — hali urinish bo'lmagan yoki tarmoq xatosi (javob kelmagan).
   */
  @Column({ type: 'int', nullable: true })
  duration_ms!: number | null;
}
