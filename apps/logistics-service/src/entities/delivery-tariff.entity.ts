import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, numericTransformer } from '@app/common';

/**
 * DAqXPeSy — yetkazish tarifi VERSIYASI (`logistics_schema.delivery_tariffs`,
 * migratsiya 1716000000142). Faol tarif = shu `tariff_id` bo'yicha
 * `is_active` va `valid_from <= now()` qatorlar ichida eng so'nggi
 * `valid_from` (teng bo'lsa katta `id`). Narx o'zgarsa — YANGI qator, eski
 * qator o'chirilmaydi.
 */
@Entity({ name: 'delivery_tariffs' })
@Index('IDX_delivery_tariffs_current', ['tariff_id', 'valid_from', 'id'], {
  where: '"is_active" = true AND "is_deleted" = false',
})
export class DeliveryTariff extends BaseEntity {
  /** 'city' | 'center' | 'address' (`CHK_delivery_tariffs_tariff_id`). */
  @Column({ type: 'varchar', length: 16 })
  tariff_id!: string;

  /** Baza narx — birinchi kg shu narxga kiradi, so'm. */
  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    transformer: numericTransformer,
  })
  base_price!: number;

  /** Har qo'shimcha kg narxi, so'm. */
  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    transformer: numericTransformer,
  })
  extra_per_kg!: number;

  @Column({ type: 'int' })
  days_min!: number;

  @Column({ type: 'int' })
  days_max!: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  valid_from!: Date;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  /** Kim yaratdi — `identity_schema.admins.id` (FK yo'q, sxemalar alohida). */
  @Column({ type: 'bigint', nullable: true })
  created_by!: string | null;
}
