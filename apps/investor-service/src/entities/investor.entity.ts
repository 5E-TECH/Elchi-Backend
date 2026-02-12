import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';
import { Status } from '@app/common';

@Entity({ name: 'investors' })
@Index('IDX_INVESTOR_USER', ['user_id'])
@Index('IDX_INVESTOR_STATUS', ['status'])
export class Investor extends BaseEntity {
  @Column({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'varchar', nullable: true })
  phone_number!: string | null;

  @Column({ type: 'enum', enum: Status, default: Status.ACTIVE })
  status!: Status;

  @Column({ type: 'text', nullable: true })
  description!: string | null;
}
