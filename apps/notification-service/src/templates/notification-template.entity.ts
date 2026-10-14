import { Column, Entity } from 'typeorm';
import { BaseEntity } from '@app/common';

export const TEMPLATE_LANGUAGES = ['uz', 'ru', 'en'] as const;
export type TemplateLanguage = (typeof TEMPLATE_LANGUAGES)[number];

/** `channel` qiymatlari; NULL — umumiy (inbox qatori matni). */
export const TEMPLATE_CHANNELS = [
  'realtime',
  'telegram',
  'sms',
  'email',
  'push',
] as const;
export type TemplateChannel = (typeof TEMPLATE_CHANNELS)[number];

/**
 * Bildirishnoma shabloni (C4R3YyvH) — migratsiya 1716000000086.
 * UNIQUE (code, lang, COALESCE(channel, '')) — ifoda indeksi migratsiyada.
 */
@Entity({ name: 'notification_templates' })
export class NotificationTemplate extends BaseEntity {
  /** = katalogdagi `type` (masalan `order.sold`). */
  @Column({ type: 'varchar', length: 120 })
  code!: string;

  @Column({ type: 'varchar', length: 2, default: 'uz' })
  lang!: TemplateLanguage;

  @Column({ type: 'varchar', length: 16, nullable: true })
  channel!: TemplateChannel | null;

  @Column({ type: 'varchar', length: 255 })
  title!: string;

  @Column({ type: 'text', nullable: true })
  body!: string | null;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  required_vars!: string[];

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  @Column({ type: 'bigint', nullable: true })
  updated_by!: string | null;
}
