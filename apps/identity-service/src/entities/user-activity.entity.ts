import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * (pe71yf8L) Foydalanuvchi faolligi — har foydalanuvchiga BITTA qator,
 * o'chirilmaydi (migratsiya 1716000000253). `user_sessions` dan farqli:
 * sessiya qatorlari 90 kunda tozalanadi, bu yerda oxirgi kirish qoladi.
 *
 * - `last_login_at` — oxirgi login (parol / SMS kod; qurilma sessiyasi
 *   qayta ishlatilganda ham).
 * - `last_seen_at` — oxirgi faollik: login, refresh va gateway `/realtime`
 *   socketining ulanishi / uzilishi (`identity.user.activity.seen`).
 *
 * Yozish faqat `UserActivityService` orqali, `GREATEST` bilan — vaqt orqaga
 * ketmaydi. `admins` qatoriga tegilmaydi.
 */
@Entity({ name: 'user_activity', schema: 'identity_schema' })
export class UserActivity {
  @PrimaryColumn({ type: 'bigint' })
  user_id!: string;

  @Column({ type: 'timestamptz', nullable: true })
  last_login_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_seen_at!: Date | null;
}
