import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { Commission_type, numericTransformer } from '@app/common';

/** A'zolik holati (migratsiya 1716000000255 `CHK_MARKET_OPERATOR_MARKET_STATUS`). */
export enum MarketOperatorMembershipStatus {
  /** Market taklif yubordi, operator hali qabul qilmagan. */
  PENDING = 'pending',
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  /** Marketdan chiqarilgan — tarix uchun qoladi (ochiq a'zolik emas). */
  REMOVED = 'removed',
}

/**
 * Bitta operator — bir nechta market: (operator, market) a'zoligi
 * (`identity_schema.market_operator_markets`, migratsiya 1716000000255).
 *
 * O'TISH DAVRI: hozircha `admins` qatoridan trigger orqali saqlanadi
 * (asosiy market = `admins.market_id`, `is_primary`). Ilova kodi bu
 * jadvalga YOZMAYDI — faqat `MarketOperatorMembershipService` o'qiydi.
 * Bitta (operator, market) — bitta ochiq (`status <> 'removed'`) qator.
 */
@Entity({ name: 'market_operator_markets', schema: 'identity_schema' })
export class MarketOperatorMembership {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'bigint' })
  operator_id!: string;

  @Column({ type: 'bigint' })
  market_id!: string;

  @Column({ type: 'varchar', length: 16 })
  status!: MarketOperatorMembershipStatus;

  @Column({ type: 'boolean', default: false })
  is_primary!: boolean;

  @Column({ type: 'varchar', length: 16, nullable: true })
  commission_type!: Commission_type | null;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  commission_value!: number | null;

  @Column({ type: 'boolean', default: false })
  can_view_warehouse_stock!: boolean;

  @Column({ type: 'bigint', nullable: true })
  invited_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  invited_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  accepted_at!: Date | null;

  @Column({ type: 'bigint', nullable: true })
  removed_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  removed_at!: Date | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at!: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updated_at!: Date;
}
