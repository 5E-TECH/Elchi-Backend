import { BaseEntity } from '@app/common';
import { Column, Entity } from 'typeorm';

@Entity({ name: 'branches', schema: 'branch_schema' })
export class Branch extends BaseEntity {
  @Column({ type: 'varchar' })
  name!: string;
}
