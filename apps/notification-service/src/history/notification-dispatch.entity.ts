import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

/** Dispatch yakuniy holati (7Vozou5x). `running` — hali tugamagan / noma'lum. */
export type DispatchHistoryStatus =
  | 'running'
  | 'sent'
  | 'partial'
  | 'inbox_only'
  | 'skipped'
  | 'failed';

export const DISPATCH_HISTORY_STATUSES: readonly DispatchHistoryStatus[] =
  Object.freeze([
    'running',
    'sent',
    'partial',
    'inbox_only',
    'skipped',
    'failed',
  ]);

/**
 * Yuborilgan xabarlar tarixi (7Vozou5x) — migratsiya 1716000000084.
 *
 * Bitta qo'lda dispatch (gateway `POST /notifications/dispatch`, aktor bor) =
 * bitta qator. Qabul qiluvchi bo'yicha natija — `notifications.dispatch_id`
 * orqali inbox qatorlarining `delivery` JSONB'ida (jonli: DLR keyin
 * `sms: failed` yozsa tarix ham shuni ko'rsatadi).
 *
 * ⚠️ activity_logs bilan ARALASHTIRILMAYDI: audit — bitta dispatch = bitta
 * audit qatori; tarix — o'z jadvali (matn, kanal kesimi, holat).
 */
@Entity({ name: 'notification_dispatches' })
@Index('IDX_NOTIF_DISPATCH_CREATED', ['createdAt'])
export class NotificationDispatch extends BaseEntity {
  @Index('UQ_NOTIF_DISPATCH_ID', { unique: true })
  @Column({ type: 'varchar', length: 100 })
  dispatch_id!: string;

  @Column({ type: 'varchar', length: 16, default: 'running' })
  status!: DispatchHistoryStatus;

  @Column({ type: 'bigint', nullable: true })
  created_by!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  created_by_role!: string | null;

  @Column({ type: 'varchar', length: 120 })
  type!: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  category!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  priority!: string | null;

  @Column({ type: 'varchar', length: 255 })
  title!: string;

  @Column({ type: 'text', nullable: true })
  body!: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  link!: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  channels!: string[];

  /** Nishon sharti (rollar/segment/recipient_ids soni) — telefon/ism EMAS. */
  @Column({ type: 'jsonb', nullable: true })
  audience!: Record<string, unknown> | null;

  /** Topilgan qabul qiluvchilar (sozlama bilan tushganlar ham). */
  @Column({ type: 'integer', default: 0 })
  recipients!: number;

  /** Inbox qatori yozilganlar. */
  @Column({ type: 'integer', default: 0 })
  dispatched!: number;

  @Column({ type: 'integer', default: 0 })
  skipped_by_preference!: number;

  /** Haqiqatan ketgan son (dispatch javobidagi `by_channel`). */
  @Column({ type: 'jsonb', nullable: true })
  by_channel!: Record<string, number> | null;

  /** Kanal × holat soni, masalan `{ sms: { queued: 3, not_eligible: 1 } }`. */
  @Column({ type: 'jsonb', nullable: true })
  channel_status!: Record<string, Record<string, number>> | null;

  @Column({ type: 'jsonb', nullable: true })
  no_provider!: string[] | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  message!: string | null;

  /** `failed` sababi (≤500 belgi, telefon maskada). */
  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  finished_at!: Date | null;
}
