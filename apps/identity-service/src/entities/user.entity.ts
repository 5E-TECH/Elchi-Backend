import { Entity, Column } from 'typeorm';
import {
  BaseEntity,
  Commission_type,
  numericTransformer,
  Roles,
  Status,
  Where_deliver,
} from '@app/common';

@Entity({ name: 'admins', schema: 'identity_schema' })
export class User extends BaseEntity {
  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 20, unique: true })
  phone_number: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  extra_number?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  address?: string | null;

  @Column({ type: 'varchar', length: 60, unique: true, nullable: true })
  username: string | null;

  @Column({ type: 'varchar', length: 255 })
  password: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  refresh_token: string | null;

  @Column({
    type: 'decimal',
    precision: 12,
    scale: 2,
    default: 0,
    transformer: {
      to: (value: number) => value,
      from: (value: string | null) => (value === null ? 0 : Number(value)),
    },
  })
  salary: number;

  @Column({ type: 'int', nullable: true })
  payment_day: number;

  @Column({ type: 'bigint', nullable: true })
  region_id?: string | null;

  @Column({ type: 'bigint', nullable: true })
  district_id?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  market_tg_token?: string | null;

  @Column({ type: 'bigint', nullable: true })
  market_id?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  telegram_id?: string | null;

  @Column({ type: 'bigint', nullable: true })
  avatar_id?: string | null;

  @Column({ type: 'enum', enum: Roles, default: Roles.ADMIN })
  role: Roles;

  @Column({ type: 'enum', enum: Status, default: Status.ACTIVE })
  status: Status;

  @Column({ type: 'int', nullable: true })
  tariff_home: number | null;

  @Column({ type: 'int', nullable: true })
  tariff_center: number | null;

  @Column({ type: 'boolean', default: false })
  add_order: boolean;

  @Column({
    type: 'enum',
    enum: Where_deliver,
    default: Where_deliver.CENTER,
    nullable: true,
  })
  default_tariff: Where_deliver | null;

  /**
   * Operator commission config. When an order created by this operator is
   * sold, finance-service records an OperatorEarning. NULL commission_type
   * (or zero value) means this user earns no per-order commission.
   *   PERCENT → earning = total_price * commission_value / 100
   *   FIXED   → earning = commission_value (flat, per sold order)
   */
  @Column({ type: 'enum', enum: Commission_type, nullable: true })
  commission_type: Commission_type | null;

  // Dual-purpose: a percentage when commission_type=PERCENT, a flat money
  // amount when FIXED — so it must hold money-sized values, hence numeric(14,2).
  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  commission_value: number | null;
}
