import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';
import { Roles, Status } from '@app/common';

@Entity({ name: 'users' })
export class User extends BaseEntity {
  @Column({ type: 'varchar', length: 100, nullable: true })
  name!: string | null;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 50 })
  username!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 20, nullable: true })
  phone_number!: string | null;

  @Column({ type: 'varchar', length: 255 })
  password!: string;

  @Column({ type: 'enum', enum: Roles, default: Roles.CUSTOMER })
  role!: Roles;

  @Column({ type: 'enum', enum: Status, default: Status.ACTIVE })
  status!: Status;

  @Column({ type: 'boolean', default: false })
  is_deleted!: boolean;
}
