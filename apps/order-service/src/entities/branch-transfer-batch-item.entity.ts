import { BaseEntity } from '@app/common';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BranchTransferBatch } from './branch-transfer-batch.entity';
import { Order } from './order.entity';

@Entity({ name: 'branch_transfer_batch_items' })
@Index('IDX_BRANCH_TRANSFER_BATCH_ITEMS_BATCH_ID', ['batch_id'])
@Index('IDX_BRANCH_TRANSFER_BATCH_ITEMS_ORDER_ID', ['order_id'])
@Index('UQ_BRANCH_TRANSFER_BATCH_ITEMS_BATCH_ORDER', ['batch_id', 'order_id'], { unique: true })
export class BranchTransferBatchItem extends BaseEntity {
  @Column({ type: 'bigint' })
  batch_id!: string;

  @ManyToOne(() => BranchTransferBatch, (batch) => batch.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'batch_id' })
  batch!: BranchTransferBatch;

  @Column({ type: 'bigint' })
  order_id!: string;

  @ManyToOne(() => Order, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  @Column({ type: 'float' })
  snapshot_price!: number;

  @Column({ type: 'bigint' })
  snapshot_market_id!: string;
}
