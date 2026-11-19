import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, numericTransformer } from '@app/common';

/**
 * 63HO6cBU (P0, PR-C) — filial X ning M marketga to'lovidan (X, M) daftar
 * qatorlariga TAQSIMLANMAY qolgan qism. Faqat barcha (X, M) qatorlari to'liq
 * to'langandan keyin paydo bo'ladi (parallel so'rov poygasi — gateway ulushni
 * oldindan tekshiradi). Ulushdan, «HQ ga berilishi kerak» dan va HQ'ning
 * marketga qarzidan ayiriladi; keyingi (X, M) qatorlariga qo'llanadi —
 * boshqa market / filial qatorlariga HECH QACHON o'tmaydi.
 */
@Entity({ name: 'order_settlement_branch_market_carry' })
@Index('UQ_settlement_branch_market_carry', ['branch_id', 'market_id'], {
  unique: true,
})
export class OrderSettlementBranchMarketCarry extends BaseEntity {
  @Column({ type: 'bigint' })
  branch_id!: string;

  @Column({ type: 'bigint' })
  market_id!: string;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  amount!: number;
}
