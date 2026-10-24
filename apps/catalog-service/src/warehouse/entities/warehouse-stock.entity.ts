import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/**
 * hY7uacJu: ombor × mahsulot qoldig'i. `on_hand ≥ 0`,
 * `0 ≤ reserved ≤ on_hand` — DB CHECK (migratsiya 1716000000143).
 * Qiymatlar FAQAT `WarehouseStockService` tranzaksiyasida, qator qulfi
 * ostida o'zgaradi va har o'zgarish `stock_movements` ga yoziladi.
 */
@Entity({ name: 'warehouse_stock' })
@Unique('UQ_warehouse_stock_warehouse_product', ['warehouse_id', 'product_id'])
@Index('IDX_warehouse_stock_market', ['market_id', 'warehouse_id'])
@Index('IDX_warehouse_stock_product', ['product_id'])
export class WarehouseStock {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ type: 'bigint' })
  warehouse_id!: string;

  @Column({ type: 'bigint' })
  product_id!: string;

  /** Mahsulot egasi (`products.user_id`) nusxasi. */
  @Column({ type: 'bigint' })
  market_id!: string;

  @Column({ type: 'int', default: 0 })
  on_hand!: number;

  @Column({ type: 'int', default: 0 })
  reserved!: number;

  /** NULL — ombor sukuti (`warehouses.low_stock_default`). */
  @Column({ type: 'int', nullable: true })
  low_stock_threshold!: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_movement_at!: Date | null;
}
