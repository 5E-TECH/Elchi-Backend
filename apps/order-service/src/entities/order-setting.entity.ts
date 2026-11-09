import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

/**
 * Buyurtma servisining global sozlamalari (key/value, faqat superadmin
 * yozadi). Kalitlar — `ORDER_INTAKE_SETTING_KEYS` (`@app/common`).
 * Migratsiya 1716000000213.
 */
@Entity({ name: 'order_settings' })
@Index('UQ_ORDER_SETTINGS_KEY', ['key'], { unique: true })
export class OrderSetting extends BaseEntity {
  @Column({ type: 'varchar', length: 100 })
  key!: string;

  @Column({ type: 'jsonb' })
  value!: unknown;

  @Column({ type: 'bigint', nullable: true })
  updated_by!: string | null;
}
