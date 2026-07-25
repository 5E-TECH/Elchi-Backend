import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

/**
 * Hamkorning tashqi buyurtma id'si (`external_order_id`) bilan Elchi ichki
 * `order_id`'si o'rtasidagi bog'lanish. Ikki vazifasi bor:
 *  1. Idempotentlik — bir xil (partner_id, external_order_id) ikki marta
 *     shipment yaratmaydi (mavjud order_id qaytariladi).
 *  2. Teskari qidiruv — Elchi order statusi o'zgarganda qaysi hamkorga va qaysi
 *     `external_order_id`'ga webhook yuborishni topish.
 *
 * `partner_id` va `order_id` — mantiqiy bog'lanish (bigint), fizik FK emas.
 * Batafsil: docs/PARTNER_API.md.
 */
@Entity({ name: 'partner_shipment_refs' })
@Index('IDX_PSR_PARTNER_EXTERNAL', ['partner_id', 'external_order_id'], {
  unique: true,
})
@Index('IDX_PSR_ORDER', ['order_id'])
export class PartnerShipmentRef extends BaseEntity {
  /** Qaysi hamkorga tegishli (partners.id). */
  @Column({ type: 'bigint' })
  partner_id!: string;

  /** Hamkor tomonidagi buyurtma id (marketplace sales_order_seller id) — idempotency kaliti. */
  @Column({ type: 'varchar' })
  external_order_id!: string;

  /** Elchi ichki buyurtma id (order.id). */
  @Column({ type: 'bigint' })
  order_id!: string;
}
