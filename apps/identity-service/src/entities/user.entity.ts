import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Roles, Status, Where_deliver } from '@app/common';

@Entity({ name: 'admins', schema: 'identity_schema' }) // Schema nomini o'zingizga moslang
export class UserAdminEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 20, unique: true })
  phone_number: string;

  @Column({ type: 'varchar', length: 60, unique: true, nullable: true })
  username: string | null;

  @Column({ type: 'varchar', length: 255 }) // Bcrypt hash uchun uzunlik yetarli bo'lishi kerak
  password: string;

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  salary: number;

  @Column({ type: 'int', nullable: true })
  payment_day: number;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date;

  @Column({ type: 'boolean', default: false })
  is_deleted: boolean;

  @Column({ type: 'enum', enum: Roles, default: Roles.ADMIN })
  role: Roles;

  @Column({ type: 'enum', enum: Status, default: Status.ACTIVE })
  status: Status;

  @Column({ type: 'int', nullable: true })
  tariff_home: number | null;

  @Column({ type: 'int', nullable: true })
  tariff_center: number | null;

  @Column({
    type: 'enum',
    enum: Where_deliver,
    default: Where_deliver.CENTER,
    nullable: true,
  })
  default_tariff: Where_deliver | null;
}
