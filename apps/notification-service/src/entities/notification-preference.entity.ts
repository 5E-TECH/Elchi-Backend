import { Column, Entity, Index, Unique } from 'typeorm';
import { BaseEntity } from '@app/common';

/**
 * Foydalanuvchining bildirishnoma sozlamasi (mP1WGG1W, migratsiya
 * 1716000000075) — `notification_schema.notification_preferences`.
 *
 * - `scope` — kategoriya nomi (`order`, `marketing`, …) YOKI aniq tur
 *   (`order.sold`). Aniq tur kategoriyadan ustun.
 * - `channel` — kanal (`in_app`, `realtime`, `push`, `sms`, `email`) yoki
 *   `all` (shu scope'dagi hamma kanal). Aniq kanal `all` dan ustun.
 * - Yozuv yo'q — sukut: xodim xabarlari YOQIQ, `marketing` O'CHIQ
 *   (fail-closed). `user_can_mute=false` (critical) turlar HECH QACHON
 *   filtrlanmaydi.
 *
 * Soft-delete ustuni AYNAN `is_deleted` (BaseEntity) — filtr so'rovi ham
 * `is_deleted = false` ni oladi.
 */
@Entity({ name: 'notification_preferences' })
@Unique('UQ_NOTIF_PREF_USER_SCOPE_CHANNEL', ['user_id', 'scope', 'channel'])
@Index('IDX_NOTIF_PREF_USER', ['user_id'])
export class NotificationPreference extends BaseEntity {
  /** identity_schema user id. */
  @Column({ type: 'bigint' })
  user_id!: string;

  @Column({ type: 'varchar', length: 120 })
  scope!: string;

  @Column({ type: 'varchar', length: 16 })
  channel!: string;

  @Column({ type: 'boolean' })
  enabled!: boolean;
}
