import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

/**
 * Hamkorning mahsuloti (`external_product_id`) ↔ Elchi katalogidagi mahsulot
 * (`elchi_product_id`) bog'lanishi.
 *
 * NEGA ID BO'YICHA, NOM BO'YICHA EMAS. Nom o'zgaruvchan: hamkor uni tahrirlashi
 * mumkin, ikki xil mahsulot bir xil nomda bo'lishi mumkin, imlo farq qilishi
 * mumkin. Nom bo'yicha bog'lansak, hamkor mahsulot nomini tuzatgan zahoti
 * tizim uni YANGI mahsulot deb hisoblab, katalogda dublikat yasardi va
 * hisobotlar bitta mahsulotni ikkiga bo'lib ko'rsatardi.
 *
 * `external_product_id` esa hamkor tomonida barqaror. Shu bois bog'lanish
 * shunga tayanadi; nom faqat KO'RSATISH uchun (katalogdagi yozuvda saqlanadi
 * va UI o'shani chiqaradi).
 *
 * `partner_id` bilan birga noyob: ikki hamkor bir xil `external_product_id`
 * ishlatishi mumkin va ular ARALASHMASLIGI kerak.
 *
 * `elchi_product_id` — mantiqiy bog'lanish (bigint), fizik FK emas: mahsulot
 * boshqa servis (catalog) domenida. Bu `partner_market_refs` va
 * `partner_shipment_refs` bilan bir xil naqsh.
 */
@Entity({ name: 'partner_product_refs' })
@Index('IDX_PPR_PARTNER_EXTERNAL', ['partner_id', 'external_product_id'], {
  unique: true,
})
@Index('IDX_PPR_PRODUCT', ['elchi_product_id'])
export class PartnerProductRef extends BaseEntity {
  /** Qaysi hamkorga tegishli (partners.id). */
  @Column({ type: 'bigint' })
  partner_id!: string;

  /** Hamkor tomonidagi mahsulot id — bog'lanish kaliti. */
  @Column({ type: 'varchar' })
  external_product_id!: string;

  /** Elchi katalogidagi mahsulot id (products.id). */
  @Column({ type: 'bigint' })
  elchi_product_id!: string;

  /**
   * Mahsulot qaysi market katalogida yaratilgan.
   *
   * Katalogda mahsulot `(name, user_id)` bo'yicha noyob, ya'ni har market
   * o'z ro'yxatiga ega. Hamkor mahsulotlari o'sha hamkorning market
   * akkaunti ostida turadi — boshqa marketlarning katalogi bulg'anmaydi.
   */
  @Column({ type: 'bigint' })
  elchi_market_id!: string;
}
