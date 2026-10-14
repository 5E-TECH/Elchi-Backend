import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * hEjjuJaT — super-kuryer ↔ viloyat (BeePost `courier_regions` analogi).
 *
 * Super-kuryer (`admins.is_super_courier = true`) bir nechta viloyat
 * pochtasida chiqadi; har viloyat uchun ixtiyoriy alohida tarif.
 * `tariff_home` / `tariff_center` NULL — kuryerning umumiy (yassi)
 * `admins.tariff_home` / `tariff_center` iga fallback.
 *
 * Qatorlar `PUT /couriers/:id/regions` da to'liq almashtiriladi (soft-delete
 * yo'q): buyurtmadagi tarif sotuvda `orders.courier_tariff` ga SNAPSHOT
 * qilinadi, shuning uchun bu yerdagi keyingi o'zgarish eski buyurtmalarga
 * ta'sir qilmaydi. `region_id` — logistics_schema.regions (sxemalararo FK yo'q).
 */
@Entity({ name: 'courier_regions', schema: 'identity_schema' })
@Index('UQ_COURIER_REGIONS_COURIER_REGION', ['courier_id', 'region_id'], {
  unique: true,
})
@Index('IDX_COURIER_REGIONS_REGION', ['region_id'])
export class CourierRegion {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'bigint' })
  courier_id!: string;

  @Column({ type: 'bigint' })
  region_id!: string;

  @Column({ type: 'int', nullable: true })
  tariff_home!: number | null;

  @Column({ type: 'int', nullable: true })
  tariff_center!: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
