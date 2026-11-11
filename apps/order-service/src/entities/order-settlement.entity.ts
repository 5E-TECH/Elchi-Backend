import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, numericTransformer, SettlementStatus } from '@app/common';

/**
 * Per-order settlement state along the COD chain courier → branch → HQ → market.
 *
 * One row per sold order, created (PENDING) at sale time. Lump-sum settlement
 * payments are FIFO-allocated to the oldest unsettled orders, advancing each
 * order through the legs and stamping who/when. Rollback is allowed only while
 * an order has not yet reached BRANCH_SETTLED (HQ not yet paid).
 *
 * Amounts are snapshotted from the sale so settlement and rollback stay exact
 * even if tariffs/shares later change:
 *   courier_amount = total − courierShare           (courier owes the branch)
 *   branch_amount  = total − courierShare − branchShare (branch owes HQ)
 *   market_amount  = total − marketTariff            (HQ owes the market)
 */
/**
 * (SPEC v2, migratsiya 219) Qator turi: `sale` — sotuv/bekor qatori (eski
 * qatorlarning hammasi); `extra_cost_chain` — kechiktirilgan qo'shimcha
 * xarajatning kuryer/filial oyoqlari (−E, market 0); `extra_cost_market` —
 * uning market oyog'i (0/0/−E, BRANCH_SETTLED dan boshlanadi);
 * `extra_cost_reversal` — rollback'da market qatori boshqa buyurtmaning
 * HQ→market FIFO'sida ishlatib bo'lingan bo'lsa, uning o'rniga yoziladigan
 * +E kompensatsiya (0/0/+E, BRANCH_SETTLED; ishlatilgan qator joyida qoladi).
 */
export type OrderSettlementKind =
  'sale' | 'extra_cost_chain' | 'extra_cost_market' | 'extra_cost_reversal';

export const ORDER_SETTLEMENT_SALE_KIND: OrderSettlementKind = 'sale';

@Entity({ name: 'order_settlement' })
// (SPEC v2) Buyurtma bo'yicha bitta qator faqat `sale` uchun; E qatorlari
// so'rov+tur bo'yicha yagona (migratsiya 219).
@Index('UQ_order_settlement_sale_order', ['order_id'], {
  unique: true,
  where: `"kind" = 'sale'`,
})
@Index('IDX_order_settlement_order', ['order_id'])
@Index(
  'UQ_order_settlement_extra_cost_kind',
  ['extra_cost_approval_id', 'kind'],
  {
    unique: true,
    where: `"extra_cost_approval_id" IS NOT NULL`,
  },
)
@Index('IDX_order_settlement_status', ['status'])
@Index('IDX_order_settlement_courier', ['courier_id'])
@Index('IDX_order_settlement_branch', ['branch_id'])
@Index('IDX_order_settlement_market', ['market_id'])
export class OrderSettlement extends BaseEntity {
  @Column({ type: 'bigint' })
  order_id!: string;

  @Column({ type: 'varchar', length: 24, default: 'sale' })
  kind!: OrderSettlementKind;

  @Column({ type: 'bigint', nullable: true })
  extra_cost_approval_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  courier_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  branch_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  market_id!: string | null;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  courier_amount!: number;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  branch_amount!: number;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  market_amount!: number;

  @Column({
    type: 'enum',
    enum: SettlementStatus,
    default: SettlementStatus.PENDING,
  })
  status!: SettlementStatus;

  @Column({ type: 'timestamptz', nullable: true })
  courier_to_branch_at!: Date | null;

  @Column({ type: 'bigint', nullable: true })
  courier_to_branch_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  branch_to_hq_at!: Date | null;

  @Column({ type: 'bigint', nullable: true })
  branch_to_hq_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  hq_to_market_at!: Date | null;

  @Column({ type: 'bigint', nullable: true })
  hq_to_market_by!: string | null;
}
