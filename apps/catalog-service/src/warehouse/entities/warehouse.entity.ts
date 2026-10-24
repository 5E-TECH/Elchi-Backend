import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, type WarehouseStatus } from '@app/common';

/**
 * hY7uacJu: viloyat filiali ombori (migratsiya 1716000000143). Indeks va
 * CHECK'lar migratsiyada; `synchronize` o'chiq — dekoratorlar qayd uchun.
 */
@Entity({ name: 'warehouses' })
@Index('UQ_warehouses_branch_id', ['branch_id'], {
  unique: true,
  where: '"is_deleted" = false',
})
@Index('IDX_warehouses_status', ['status'])
export class Warehouse extends BaseEntity {
  @Column({ type: 'bigint' })
  branch_id!: string;

  @Column({ type: 'varchar', length: 160 })
  name!: string;

  /** Mas'ul xodim (filial menejeri) — faqat ko'rsatish; ruxsat filialdan. */
  @Column({ type: 'bigint', nullable: true })
  manager_user_id!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  address!: string | null;

  /** Mahsulotda alohida chegara bo'lmasa — shu (dona). */
  @Column({ type: 'int', default: 5 })
  low_stock_default!: number;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  note!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'ACTIVE' })
  status!: WarehouseStatus;

  @Column({ type: 'timestamptz', nullable: true })
  paused_at!: Date | null;

  @Column({ type: 'bigint', nullable: true })
  paused_by!: string | null;

  @Column({ type: 'bigint', nullable: true })
  created_by!: string | null;
}
