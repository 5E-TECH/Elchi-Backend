import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { Roles, Status } from '@app/common';

@Entity({ name: 'admins', schema: 'identity_schema' })
export class MarketEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'enum', enum: Roles })
  role!: Roles;

  @Column({ type: 'enum', enum: Status })
  status!: Status;

  @Column({ type: 'boolean', default: false })
  is_deleted!: boolean;
}
