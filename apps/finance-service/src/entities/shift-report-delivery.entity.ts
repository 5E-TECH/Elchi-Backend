import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

export type ShiftReportRecipientKind = 'superadmin' | 'courier' | 'market';
export type ShiftReportChannel = 'in_app' | 'telegram' | 'telegram_group';
export type ShiftReportDeliveryStatus =
  | 'queued'
  | 'sent'
  | 'failed'
  | 'skipped';

/**
 * gWI4gYkw — smena hisoboti kimga, qaysi kanal orqali ketgani («Hisobot
 * kimlarga yuborildi» bloki). UNIQUE (shift, round, recipient, channel).
 */
@Entity({ name: 'shift_report_deliveries' })
@Index(
  'UQ_SHIFT_REPORT_DELIVERY',
  ['shift_id', 'round', 'recipient_id', 'channel'],
  { unique: true },
)
@Index('IDX_SHIFT_REPORT_DELIVERY_SHIFT', ['shift_id'])
export class ShiftReportDelivery extends BaseEntity {
  @Column({ type: 'bigint' })
  shift_id!: string;

  @Column({ type: 'int', default: 1 })
  round!: number;

  @Column({ type: 'bigint' })
  recipient_id!: string;

  @Column({ type: 'varchar', length: 16 })
  recipient_kind!: ShiftReportRecipientKind;

  @Column({ type: 'varchar', length: 16 })
  channel!: ShiftReportChannel;

  @Column({ type: 'varchar', length: 16 })
  status!: ShiftReportDeliveryStatus;

  @Column({ type: 'varchar', length: 200, nullable: true })
  failed_reason!: string | null;

  /** `notification.dispatch` `client_request_id` (deterministik UUID). */
  @Column({ type: 'uuid', nullable: true })
  dispatch_id!: string | null;

  @Column({ type: 'varchar', length: 60 })
  notification_type!: string;

  @Column({ type: 'timestamptz', nullable: true })
  sent_at!: Date | null;
}
