import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';
import { Status } from '@app/common';

@Entity({ name: 'branches' })
@Index('IDX_BRANCH_STATUS', ['status'])
@Index('IDX_BRANCH_REGION', ['region_id'])
export class Branch extends BaseEntity {
  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'varchar', nullable: true })
  address!: string | null;

  @Column({ type: 'varchar', nullable: true })
  phone_number!: string | null;

  @Column({ type: 'uuid', nullable: true })
  region_id!: string | null;

  @Column({ type: 'uuid', nullable: true })
  district_id!: string | null;

  @Column({ type: 'enum', enum: Status, default: Status.ACTIVE })
  status!: Status;

  @Column({ type: 'uuid', nullable: true })
  manager_id!: string | null;
}
