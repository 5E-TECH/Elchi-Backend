import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { StockMovementRefType, StockMovementType } from '@app/common';

/**
 * hY7uacJu: qoldiq harakatlari jurnali — FAQAT QO'SHILADI (UPDATE/DELETE
 * trigger bilan taqiqlangan, migratsiya 1716000000143). `qty` ishorasi tur
 * bo'yicha CHECK bilan qulflangan; `idempotency_key` UNIQUE.
 */
@Entity({ name: 'stock_movements' })
@Index('IDX_stock_movements_warehouse_created', [
  'warehouse_id',
  'createdAt',
  'id',
])
@Index('IDX_stock_movements_ref', ['ref_type', 'ref_id'])
@Index('IDX_stock_movements_product', ['product_id', 'warehouse_id'])
export class StockMovement {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'bigint' })
  warehouse_id!: string;

  @Column({ type: 'bigint' })
  product_id!: string;

  @Column({ type: 'bigint' })
  market_id!: string;

  @Column({ type: 'varchar', length: 16 })
  type!: StockMovementType;

  @Column({ type: 'int' })
  qty!: number;

  @Column({ type: 'int' })
  on_hand_after!: number;

  @Column({ type: 'int' })
  reserved_after!: number;

  @Column({ type: 'varchar', length: 16, nullable: true })
  ref_type!: StockMovementRefType | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  ref_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  actor_id!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  actor_role!: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  note!: string | null;

  @Column({ type: 'varchar', length: 255, unique: true })
  idempotency_key!: string;
}
