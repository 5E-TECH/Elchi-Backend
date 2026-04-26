import { BaseEntity, BranchTransferBatchStatus, BranchTransferDirection } from '@app/common';
import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BranchTransferBatchHistory } from './branch-transfer-batch-history.entity';
import { BranchTransferBatchItem } from './branch-transfer-batch-item.entity';

@Entity({ name: 'branch_transfer_batches' })
@Index('IDX_BRANCH_TRANSFER_BATCHES_SOURCE_BRANCH_ID', ['source_branch_id'])
@Index('IDX_BRANCH_TRANSFER_BATCHES_DESTINATION_BRANCH_ID', ['destination_branch_id'])
@Index('IDX_BRANCH_TRANSFER_BATCHES_TARGET_REGION_ID', ['target_region_id'])
@Index('IDX_BRANCH_TRANSFER_BATCHES_STATUS', ['status'])
@Index('IDX_BRANCH_TRANSFER_BATCHES_DIRECTION', ['direction'])
@Index('UQ_BRANCH_TRANSFER_BATCHES_QR_CODE_TOKEN', ['qr_code_token'], { unique: true })
export class BranchTransferBatch extends BaseEntity {
  @Column({ type: 'varchar', length: 32, unique: true })
  qr_code_token!: string;

  @Column({ type: 'bigint' })
  source_branch_id!: string;

  @Column({ type: 'bigint' })
  destination_branch_id!: string;

  @Column({
    type: 'enum',
    enum: BranchTransferDirection,
    enumName: 'branch_transfer_batch_direction_enum',
  })
  direction!: BranchTransferDirection;

  @Column({ type: 'bigint' })
  target_region_id!: string;

  @Column({
    type: 'enum',
    enum: BranchTransferBatchStatus,
    enumName: 'branch_transfer_batch_status_enum',
    default: BranchTransferBatchStatus.PENDING,
  })
  status!: BranchTransferBatchStatus;

  @Column({ type: 'int', default: 0 })
  order_count!: number;

  @Column({ type: 'float', default: 0 })
  total_price!: number;

  @Column({ type: 'varchar', length: 32, nullable: true })
  vehicle_plate!: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  driver_name!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  driver_phone!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  sent_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  received_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  cancelled_at!: Date | null;

  @OneToMany(() => BranchTransferBatchItem, (item) => item.batch)
  items!: BranchTransferBatchItem[];

  @OneToMany(() => BranchTransferBatchHistory, (history) => history.batch)
  history!: BranchTransferBatchHistory[];
}
