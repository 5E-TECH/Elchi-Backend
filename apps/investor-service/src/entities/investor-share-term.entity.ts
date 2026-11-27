import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, numericTransformer } from '@app/common';
import type { ProfitBasis } from '@app/common';

/**
 * Versiyalangan ulush sharti (migratsiya 1716000000256, BeePost
 * `investor_ownership_stake` naqshi). Qator [effective_from, effective_to)
 * ISH KUNLARI oralig'ida amal qiladi; `effective_to` NULL — ochiq (hozirgi)
 * shart. Ulush yoki asos o'zgarsa ochiq qator yopiladi va yangisi ochiladi —
 * o'tgan kunlar hisobi qayta yozilmaydi. Har investorda ko'pi bilan bitta
 * ochiq qator (`UQ_INVESTOR_SHARE_TERMS_OPEN`).
 *
 * Sanalar — `YYYY-MM-DD` (Toshkent ish kuni), vaqt yo'q.
 */
@Entity({ name: 'investor_share_terms' })
@Index('IDX_INVESTOR_SHARE_TERMS_FROM', ['investor_id', 'effective_from'])
export class InvestorShareTerm extends BaseEntity {
  @Column({ type: 'bigint' })
  investor_id!: string;

  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    transformer: numericTransformer,
  })
  share_percent!: number;

  @Column({ type: 'varchar', length: 8, default: 'net' })
  profit_basis!: ProfitBasis;

  @Column({ type: 'date' })
  effective_from!: string;

  @Column({ type: 'date', nullable: true })
  effective_to!: string | null;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'bigint', nullable: true })
  created_by!: string | null;
}
