import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, numericTransformer } from '@app/common';

export type ExtraCostApprovalAction = 'sell' | 'cancel' | 'partly_sell';
export type ExtraCostApprovalStatus = 'pending' | 'approved' | 'rejected';

@Entity({ name: 'order_extra_cost_approvals' })
@Index('IDX_ORDER_EXTRA_COST_APPROVAL_MARKET_STATUS', [
  'market_id',
  'status',
  'createdAt',
])
@Index('IDX_ORDER_EXTRA_COST_APPROVAL_ORDER_STATUS', ['order_id', 'status'])
export class OrderExtraCostApproval extends BaseEntity {
  @Column({ type: 'bigint' })
  order_id!: string;

  @Column({ type: 'bigint' })
  market_id!: string;

  @Column({ type: 'bigint' })
  requested_by_user_id!: string;

  @Column({ type: 'varchar', length: 40, nullable: true })
  requested_by_role!: string | null;

  @Column({ type: 'bigint', nullable: true })
  requester_branch_id!: string | null;

  @Column({ type: 'varchar', length: 20 })
  action!: ExtraCostApprovalAction;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  amount!: number;

  @Column({ type: 'jsonb', nullable: true })
  proof_file_keys!: string[] | null;

  @Column({ type: 'jsonb' })
  operation_payload!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: ExtraCostApprovalStatus;

  @Column({ type: 'bigint', nullable: true })
  decided_by_user_id!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  decided_at!: Date | null;

  @Column({ type: 'text', nullable: true })
  decision_comment!: string | null;
}
