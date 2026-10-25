import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';
import { NotificationCategory, NotificationPriority } from '@app/common';

/**
 * Per-recipient in-app notification (the inbox row).
 *
 * One row == one notification for ONE user. A dispatch that targets a role or
 * broadcasts fans out into many of these rows (one per resolved recipient), so
 * read-state (`is_read`/`read_at`) is naturally per-user.
 *
 * The persisted row IS the `in_app` channel. Other channels (realtime push,
 * telegram, email, sms) are delivery side-effects whose outcome is recorded in
 * `delivery`.
 */
@Entity({ name: 'notifications' })
// The hot path: "my unread, newest first" and "my inbox, newest first".
// (inbox-group-sort) `createdAt` — inbox saralash kaliti: group_key qatori
// yangilanganda u ham yangilanadi (oxirgi hodisa vaqti), qator tepaga chiqadi.
@Index('IDX_NOTIF_RECIPIENT_READ', ['recipient_id', 'is_read'])
@Index('IDX_NOTIF_RECIPIENT_CREATED', ['recipient_id', 'createdAt'])
@Index('IDX_NOTIF_TYPE', ['type'])
@Index('IDX_NOTIF_GROUP_KEY', ['group_key'])
// (A1HzKEby) Retention cron'i: `is_read + createdAt <` partiyalab o'chirish;
// `critical` hech qachon o'chirilmaydi — indeksga ham tushmaydi (mig. 108).
@Index('IDX_NOTIF_RETENTION', ['is_read', 'createdAt'], {
  where: `"priority" <> 'critical'`,
})
export class Notification extends BaseEntity {
  /** The user this notification belongs to (identity_schema.user id). */
  @Column({ type: 'bigint' })
  recipient_id!: string;

  /** The role the recipient held / was targeted by — handy for filtering & analytics. */
  @Column({ type: 'varchar', nullable: true })
  recipient_role!: string | null;

  /** Fine-grained event key, convention `{domain}.{event}` e.g. `order.sold`. */
  @Column({ type: 'varchar' })
  type!: string;

  @Column({
    type: 'enum',
    enum: NotificationCategory,
    default: NotificationCategory.SYSTEM,
  })
  category!: NotificationCategory;

  @Column({
    type: 'enum',
    enum: NotificationPriority,
    default: NotificationPriority.NORMAL,
  })
  priority!: NotificationPriority;

  @Column({ type: 'varchar' })
  title!: string;

  @Column({ type: 'text', nullable: true })
  body!: string | null;

  /** Arbitrary structured payload (ids, amounts, …) the frontend can act on. */
  @Column({ type: 'jsonb', nullable: true })
  data!: Record<string, unknown> | null;

  /** Deep-link the frontend navigates to on click (e.g. `/orders/edit/123`). */
  @Column({ type: 'varchar', nullable: true })
  link!: string | null;

  /** Which channels this dispatch requested (audit/debug). */
  @Column({ type: 'jsonb', nullable: true })
  channels!: string[] | null;

  /** Per-channel delivery outcome, e.g. `{ realtime: 'sent', telegram: 'failed' }`. */
  @Column({ type: 'jsonb', nullable: true })
  delivery!: Record<string, unknown> | null;

  /** Optional dedupe/collapse key — repeated dispatches with the same key for the
   * same recipient are merged instead of duplicated (e.g. one row per order).
   * Birlashtirilganda qator qayta o'qilmagan bo'ladi va `createdAt` yangilanadi
   * (inbox-group-sort), `data.count` — shu qatorga yig'ilgan hodisalar soni.
   * (A1HzKEby) Yangi qatorlarda DOIM bor: katalog shablonidan yoki (shablonsiz
   * tur) `{type}:{dispatch_id}`. Eski qatorlarda NULL bo'lishi mumkin. */
  @Column({ type: 'varchar', nullable: true })
  group_key!: string | null;

  /**
   * (7Vozou5x) Qaysi dispatch partiyasi yozdi/yangiladi (migratsiya
   * 1716000000084). group_key bilan birlashtirilgan qator — OXIRGI dispatch.
   * Eski qatorlarda NULL.
   */
  @Index('IDX_NOTIF_DISPATCH', { where: '"dispatch_id" IS NOT NULL' })
  @Column({ type: 'varchar', length: 100, nullable: true })
  dispatch_id!: string | null;

  @Column({ type: 'boolean', default: false })
  is_read!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  read_at!: Date | null;
}
