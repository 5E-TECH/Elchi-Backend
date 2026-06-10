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
@Index('IDX_NOTIF_RECIPIENT_READ', ['recipient_id', 'is_read'])
@Index('IDX_NOTIF_RECIPIENT_CREATED', ['recipient_id', 'createdAt'])
@Index('IDX_NOTIF_TYPE', ['type'])
@Index('IDX_NOTIF_GROUP_KEY', ['group_key'])
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

  /** Deep-link the frontend navigates to on click (e.g. `/orders/123`). */
  @Column({ type: 'varchar', nullable: true })
  link!: string | null;

  /** Which channels this dispatch requested (audit/debug). */
  @Column({ type: 'jsonb', nullable: true })
  channels!: string[] | null;

  /** Per-channel delivery outcome, e.g. `{ realtime: 'sent', telegram: 'failed' }`. */
  @Column({ type: 'jsonb', nullable: true })
  delivery!: Record<string, unknown> | null;

  /** Optional dedupe/collapse key — repeated dispatches with the same key for the
   * same recipient are merged instead of duplicated (e.g. one row per order). */
  @Column({ type: 'varchar', nullable: true })
  group_key!: string | null;

  @Column({ type: 'boolean', default: false })
  is_read!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  read_at!: Date | null;
}
