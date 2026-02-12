import { Column, Entity, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@app/common';
import { Branch } from './branch.entity';

@Entity({ name: 'branch_configs' })
@Index('IDX_BRANCH_CONFIG_BRANCH', ['branch_id'])
@Index('IDX_BRANCH_CONFIG_KEY', ['branch_id', 'config_key'], { unique: true })
export class BranchConfig extends BaseEntity {
  @Column({ type: 'uuid' })
  branch_id!: string;

  @Column({ type: 'varchar' })
  config_key!: string;

  @Column({ type: 'jsonb', nullable: true })
  config_value!: Record<string, any> | null;

  @ManyToOne(() => Branch, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'branch_id' })
  branch!: Branch;
}
