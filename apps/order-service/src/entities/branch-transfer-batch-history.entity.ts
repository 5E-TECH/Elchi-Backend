import { BranchTransferBatchAction } from '@app/common';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { BranchTransferBatch } from './branch-transfer-batch.entity';

@Entity({ name: 'branch_transfer_batch_history' })
@Index('IDX_BRANCH_TRANSFER_BATCH_HISTORY_BATCH_ID_CREATED_AT', ['batch_id', 'created_at'])
export class BranchTransferBatchHistory {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'bigint' })
  batch_id!: string;

  @ManyToOne(() => BranchTransferBatch, (batch) => batch.history, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'batch_id' })
  batch!: BranchTransferBatch;

  @Column({ type: 'bigint' })
  user_id!: string;

  @Column({
    type: 'enum',
    enum: BranchTransferBatchAction,
    enumName: 'branch_transfer_batch_action_enum',
  })
  action!: BranchTransferBatchAction;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;
}
