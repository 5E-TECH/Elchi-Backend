import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

/**
 * Hamkorning tashqi sotuvchisi (`external_seller_id`) ↔ Elchi market akkaunti
 * (`elchi_market_id`) bog'lanishi. Ikki vazifa:
 *  1. Idempotentlik — bir (partner_id, external_seller_id) uchun ikkinchi marta
 *     market yaratilmaydi (mavjud elchi_market_id qaytariladi).
 *  2. Egalik — qaysi market qaysi hamkorники (COD settlement, xavfsizlik).
 *
 * `partner_id` va `elchi_market_id` — mantiqiy bog'lanish (bigint), fizik FK emas
 * (market boshqa servis — identity — domenida). Kontrakt: docs/PARTNER_API.md §3.2.
 */
@Entity({ name: 'partner_market_refs' })
@Index('IDX_PMR_PARTNER_EXTERNAL', ['partner_id', 'external_seller_id'], {
  unique: true,
})
@Index('IDX_PMR_MARKET', ['elchi_market_id'])
export class PartnerMarketRef extends BaseEntity {
  /** Qaysi hamkorга tegishli (partners.id). */
  @Column({ type: 'bigint' })
  partner_id!: string;

  /** Hamkor tomonidagi sotuvchi id (marketplace shop id) — idempotency kaliti. */
  @Column({ type: 'varchar' })
  external_seller_id!: string;

  /** Elchi market akkaunti id (identity market/user id). */
  @Column({ type: 'bigint' })
  elchi_market_id!: string;
}
