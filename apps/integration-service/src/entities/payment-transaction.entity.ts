import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, numericTransformer } from '@app/common';

/**
 * ONLAYN TO'LOV TRANZAKSIYASI — to'lov tizimidan kelgan hodisa yozuvi.
 *
 * ⚠️ NEGA `provider_shipments` GA YOZILMAYDI. U jadvalda `order_id` UNIQUE
 * (`provider-shipment.entity.ts`) — ya'ni to'lov yozuvi kargo posilkasining
 * qatorini ustiga yozib ketardi. To'lov va posilka bir buyurtmada BIRGA
 * bo'lishi mumkin (mijoz onlayn to'ladi, posilkani kargo olib ketdi).
 *
 * ⚠️ UNIQUE `(integration_id, provider_transaction_id, status)` —
 * DUBLIKATNING QAT'IY TO'SIG'I. To'lov tizimlari hodisani qayta-qayta
 * yuboradi (bu ularning normal xatti-harakati) va pulni ikki marta qo'llash
 * eng qimmat xato bo'lardi.
 *
 * ⚠️ NEGA KALITGA `status` HAM KIRADI. To'lov tizimi BITTA tranzaksiya
 * uchun BIR NECHTA hodisa yuboradi va hammasi AYNI id bilan keladi:
 *
 *   CreateTransaction   → pending
 *   PerformTransaction  → succeeded     ← ASOSIY hodisa, pul aynan shunda keladi
 *   CancelTransaction   → refunded
 *
 * Kalit faqat tranzaksiya id'si bo'lsa, birinchi hodisa (`pending`) qatorni
 * band qilib qo'yardi va `succeeded` "dublikat" deb TASHLANARDI — ya'ni pul
 * kelib, buyurtmaga hech qachon yozilmasdi. Qaytarish ham xuddi shunday
 * yo'qolardi. Bu eng qimmat turdagi xato: hech narsa xato chiqmaydi.
 *
 * ⚠️ CHEKLOV. Bir tranzaksiyaning IKKI QISMIY QAYTARISHI (ayni id, ayni
 * `refunded`) ikkinchisi tashlanadi. Bu ATAYLAB tanlangan: takroriy
 * yetkazishni yo'qotish — qaytarishni ikki marta qo'llashdan xavfsizroq.
 * Provayderlar odatda har qaytarishga alohida id beradi.
 *
 * ISHLASH TARTIBI (6-bosqichdagi `inbound_deal_refs` naqshi): avval shu
 * yerga yoziladi (unique buzilsa — dublikat, to'xtaymiz), keyin buyurtma
 * yangilanadi.
 *
 * ⚠️ QATOR O'CHIRILMAYDI — `inbound_deal_refs` dan FARQLI. CRM bitimida
 * yaratish yiqilsa band qilishni bo'shatish xavfsiz (buyurtma yaratilmagan
 * bo'lsa qayta urinish kerak). Pulda esa teskari: "yiqildi" javobi
 * buyurtma yangilanMAGANINI kafolatlamaydi (timeout, tarmoq uzilishi), va
 * bo'shatish ikkinchi nusxaga pulni QAYTA qo'llash yo'lini ochardi.
 * `apply_outcome` shuning uchun bor — qo'llanmagan to'lov ko'rinadi va
 * qo'lda hal qilinadi.
 */
@Entity({ name: 'payment_transactions' })
@Index(
  'IDX_PTX_INTEGRATION_TXN',
  ['integration_id', 'provider_transaction_id', 'status'],
  { unique: true },
)
@Index('IDX_PTX_ORDER', ['order_id'])
export class PaymentTransaction extends BaseEntity {
  /** Qaysi to'lov tizimidan keldi (external_integrations.id). */
  @Column({ type: 'bigint' })
  integration_id!: string;

  /** To'lov tizimi tomonidagi tranzaksiya id — idempotentlik kaliti. */
  @Column({ type: 'varchar' })
  provider_transaction_id!: string;

  /**
   * Bizning buyurtma (order.id).
   *
   * `NULL` bo'lishi mumkin: to'lov keldi, lekin buyurtma topilmadi.
   * ⚠️ Bunday yozuv O'CHIRILMAYDI — pul kelgan, uni kuzatish SHART.
   * Operator keyin qo'lda bog'laydi.
   */
  @Column({ type: 'bigint', nullable: true })
  order_id!: string | null;

  /** To'lov tizimi yuborgan buyurtma havolasi (raqam, external id, token). */
  @Column({ type: 'varchar', nullable: true })
  order_ref!: string | null;

  /** `total_price` bilan bir xil tip — tiyin yumaloqlanmasin. */
  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  amount!: number;

  @Column({ type: 'varchar', length: 8, default: 'UZS' })
  currency!: string;

  /**
   * BIZNING holatimiz: `succeeded` | `failed` | `refunded` | `pending`.
   *
   * Provayderning xom holati `provider_status` da saqlanadi — u yerdagi
   * qiymatlar har tizimda boshqacha va ularni bizning qaror mantiqiga
   * to'g'ridan-to'g'ri bog'lash mumkin emas.
   */
  @Column({ type: 'varchar', length: 24 })
  status!: string;

  @Column({ type: 'varchar', nullable: true })
  provider_status!: string | null;

  /**
   * Buyurtmaga qo'llanish natijasi — `recorded`, `order_not_found`,
   * `amount_mismatch` va h.k. Diagnostika uchun: "pul keldi, lekin
   * buyurtmaga tegmadi" holatini KO'RINADIGAN qiladi.
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  apply_outcome!: string | null;

  /** Xom hodisa jurnalidagi qator (provider_webhook_logs.id). */
  @Column({ type: 'bigint', nullable: true })
  webhook_log_id!: string | null;
}
