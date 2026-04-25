import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';
import { BranchType, Status } from '@app/common';

@Entity({ name: 'branches' })
@Index('IDX_BRANCH_STATUS', ['status'])
@Index('IDX_BRANCH_REGION', ['region_id'])
@Index('IDX_BRANCH_PARENT', ['parent_id'])
@Index('IDX_BRANCH_CODE_UNIQUE', ['code'], { unique: true })
export class Branch extends BaseEntity {
  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'varchar', nullable: true })
  address!: string | null;

  @Column({ type: 'varchar', nullable: true })
  phone_number!: string | null;

  @Column({ type: 'bigint', nullable: true })
  region_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  district_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  parent_id!: string | null;

  @Column({ type: 'enum', enum: BranchType, default: BranchType.DISTRICT })
  type!: BranchType;

  @Column({ type: 'int', default: 0 })
  level!: number;

  @Column({ type: 'varchar', nullable: true })
  code!: string | null;

  @Column({ type: 'enum', enum: Status, default: Status.ACTIVE })
  status!: Status;

  @Column({ type: 'bigint', nullable: true })
  manager_id!: string | null;
}
