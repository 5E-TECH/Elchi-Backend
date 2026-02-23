import { Column, Entity, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@app/common';
import { Branch } from './branch.entity';

@Entity({ name: 'branch_users' })
@Index('IDX_BRANCH_USER_BRANCH', ['branch_id'])
@Index('IDX_BRANCH_USER_USER', ['user_id'])
@Index('IDX_BRANCH_USER_UNIQUE', ['branch_id', 'user_id'], { unique: true })
export class BranchUser extends BaseEntity {
  @Column({ type: 'bigint' })
  branch_id!: string;

  @Column({ type: 'bigint' })
  user_id!: string;

  @Column({ type: 'varchar', nullable: true })
  role!: string | null;

  @ManyToOne(() => Branch, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'branch_id' })
  branch!: Branch;
}
