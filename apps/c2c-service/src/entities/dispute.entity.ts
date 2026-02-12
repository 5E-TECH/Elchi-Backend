import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

export enum DisputeStatus {
  OPEN = 'open',
  IN_REVIEW = 'in_review',
  RESOLVED = 'resolved',
  CLOSED = 'closed',
}

@Entity({ name: 'disputes' })
@Index('IDX_DISPUTE_ORDER', ['order_id'])
@Index('IDX_DISPUTE_STATUS', ['status'])
export class Dispute extends BaseEntity {
  @Column({ type: 'uuid' })
  order_id!: string;

  @Column({ type: 'uuid' })
  opened_by!: string;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ type: 'enum', enum: DisputeStatus, default: DisputeStatus.OPEN })
  status!: DisputeStatus;

  @Column({ type: 'text', nullable: true })
  resolution!: string | null;

  @Column({ type: 'uuid', nullable: true })
  resolved_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolved_at!: Date | null;
}
