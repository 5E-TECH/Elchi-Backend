import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { StockReservationStatus } from '@app/common';

/**
 * hY7uacJu: buyurtma bandi (order-service RPC'lari). Bitta buyurtma ×
 * mahsulot uchun bitta FAOL (RESERVED/OUT) qator — partial UNIQUE
 * (migratsiya 1716000000143). release/out/return aynan shu qatordagi
 * miqdor bilan ishlaydi; takroriy chaqiruv holatdan no-op bo'ladi.
 */
@Entity({ name: 'stock_reservations' })
@Index(
  'UQ_stock_reservations_order_product_active',
  ['order_id', 'product_id'],
  {
    unique: true,
    where: `"status" IN ('RESERVED', 'OUT')`,
  },
)
@Index('IDX_stock_reservations_order', ['order_id'])
@Index('IDX_stock_reservations_warehouse_status', ['warehouse_id', 'status'])
export class StockReservation {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ type: 'bigint' })
  order_id!: string;

  @Column({ type: 'bigint' })
  warehouse_id!: string;

  @Column({ type: 'bigint' })
  product_id!: string;

  @Column({ type: 'bigint' })
  market_id!: string;

  @Column({ type: 'int' })
  qty!: number;

  @Column({ type: 'int', default: 0 })
  returned_qty!: number;

  @Column({ type: 'varchar', length: 16, default: 'RESERVED' })
  status!: StockReservationStatus;

  @Column({ type: 'timestamptz', nullable: true })
  released_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  out_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  returned_at!: Date | null;
}
