import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

/**
 * CRM BITIMI ↔ BUYURTMA bog'lanishi — DUBLIKATNING QAT'IY TO'SIG'I.
 *
 * MUAMMO (adversarial tekshiruv, kritik). `receiveExternalOrders` dublikatni
 * `(external_id, operator)` bo'yicha O'QIB tekshiradi, keyin buyurtma
 * YARATADI — ikkisi orasida tuman aniqlash va mijoz yaratish uchun bir
 * nechta RMQ borish-kelishi bor, ya'ni poyga oynasi yuzlab millisekund.
 *
 * CRM esa bitta harakat uchun bir nechta webhook yuboradi (bosqich o'zgardi
 * + mas'ul o'zgardi + maydon o'zgardi) va hammasi AYNI bosqichni tashiydi,
 * ya'ni hammasi darvozadan o'tadi. Ikkisi bir vaqtda kelsa: A o'qiydi —
 * topmaydi, B o'qiydi — topmaydi, keyin IKKISI HAM yaratadi. Natija: bitta
 * bitimdan ikki buyurtma, ikki `order_number`, ikki COD qarzi.
 *
 * NEGA `orders` ustiga UNIQUE indeks QO'YILMADI: `external_id` NULL
 * bo'lishi mumkin va mavjud ma'lumotda dublikat bo'lsa migratsiya deploy'ni
 * yiqitardi (`order.entity.ts` dagi izoh shuni aytadi). Bu jadval esa YANGI
 * — eski ma'lumot yo'q, shuning uchun UNIQUE xavfsiz.
 *
 * ISHLASH TARTIBI: avval shu yerga yozamiz (unique buzilsa — dublikat,
 * to'xtaymiz), keyin buyurtma yaratamiz. Yaratish yiqilsa qator
 * O'CHIRILADI — aks holda ref qolib, buyurtma esa hech qachon
 * yaratilmasdi ("dublikat" deb abadiy to'silardi).
 */
@Entity({ name: 'inbound_deal_refs' })
@Index('IDX_IDR_INTEGRATION_DEAL', ['integration_id', 'deal_id'], {
  unique: true,
})
export class InboundDealRef extends BaseEntity {
  /** Qaysi ulanishdan keldi (external_integrations.id). */
  @Column({ type: 'bigint' })
  integration_id!: string;

  /** CRM tomonidagi bitim id'si — idempotentlik kaliti. */
  @Column({ type: 'varchar' })
  deal_id!: string;

  /**
   * Yaratilgan buyurtma (order.id).
   *
   * `NULL` bo'lishi mumkin: bitim eski yo'l orqali allaqachon buyurtmaga
   * aylangan bo'lsa (`already_exists`), id bizga qaytmaydi. Bog'lanish
   * o'zi muhim, id esa qo'shimcha ma'lumot.
   */
  @Column({ type: 'bigint', nullable: true })
  order_id!: string | null;

  /** Qaysi bosqich buyurtmani tug'dirdi — diagnostika uchun. */
  @Column({ type: 'varchar', nullable: true })
  stage!: string | null;
}
