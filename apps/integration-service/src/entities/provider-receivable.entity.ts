import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

export enum ReceivableStatus {
  PENDING = 'pending',
  SETTLED = 'settled',
  CANCELLED = 'cancelled',
}

/**
 * COD receivable from an external provider.
 *
 * When a provider delivers (sells) an order it collects the cash-on-delivery
 * amount on Elchi's behalf — that money is now owed BACK to Elchi. Provider
 * delivery is status-only on the order side (no cashbox), so this row is the
 * single source of truth for "how much does provider X still owe us".
 *
 * One receivable per (integration, order) — recording is idempotent. The
 * lifecycle is PENDING → SETTLED (provider remitted) or → CANCELLED (the
 * delivery was reversed: cancel/return, so nothing is owed).
 */
@Entity({ name: 'provider_receivables' })
@Index('IDX_RECEIVABLE_ORDER_INTEGRATION', ['integration_id', 'order_id'], {
  unique: true,
  where: 'is_deleted = false',
})
@Index('IDX_RECEIVABLE_INTEGRATION', ['integration_id'])
@Index('IDX_RECEIVABLE_STATUS', ['status'])
export class ProviderReceivable extends BaseEntity {
  @Column({ type: 'bigint' })
  order_id!: string;

  @Column({ type: 'bigint' })
  integration_id!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  provider_slug!: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  external_ref!: string | null;

  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  amount!: string;

  @Column({
    type: 'enum',
    enum: ReceivableStatus,
    default: ReceivableStatus.PENDING,
  })
  status!: ReceivableStatus;

  @Column({ type: 'bigint', nullable: true })
  remittance_id!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  settled_at!: Date | null;
}
