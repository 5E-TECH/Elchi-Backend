import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * T7 (QPq2C1co) — umumiy kalit-qiymat sozlamalari (migratsiya 1716000000185).
 *
 * Hozirgi kalitlar (`contacts/contacts.constants.ts`):
 *  - `contacts.support_phones` — zaxira aloqa raqamlari (`+998XXXXXXXXX`,
 *    0–2 ta, jsonb massiv);
 *  - `contacts.default_market_responsible_id` — sukut market mas'uli
 *    (`"15"` | null).
 * `updated_by` — oxirgi o'zgartirgan xodim (`admins.id`, FK yo'q).
 */
@Entity({ name: 'app_settings', schema: 'identity_schema' })
export class AppSetting {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'varchar', length: 100, unique: true })
  key!: string;

  @Column({ type: 'jsonb', nullable: true })
  value!: unknown;

  @Column({ type: 'bigint', nullable: true })
  updated_by!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
