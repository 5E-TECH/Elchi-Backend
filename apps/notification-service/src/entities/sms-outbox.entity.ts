import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type {
  SmsDlrStatus,
  SmsMessageClass,
  SmsSenderProfile,
} from '../sms/sms.port';
import type { SmsEncoding } from '../sms/sms-segments.util';

/**
 * - pending    — navbatda (scheduled_at / next_retry_at kelishini kutadi);
 * - processing — scheduler hozir yubormoqda;
 * - sent       — provayder qabul qildi (DLR kutilmoqda);
 * - delivered  — DLR: yetkazildi;
 * - failed     — terminal xato (urinishlar tugadi yoki DLR rad etdi).
 */
export type SmsOutboxStatus =
  | 'pending'
  | 'processing'
  | 'sent'
  | 'delivered'
  | 'failed';

/**
 * Bitta SMS = bitta qator (3fRbyadQ #2, migratsiya 1716000000054).
 *
 * Qayta urinish ustunlari integration-service `sync_queue` bilan AYNAN bir xil
 * nomlangan: status, attempts, retry_count, max_attempts, last_error,
 * last_response, next_retry_at + indeks (status, next_retry_at).
 * `client_message_id` UNIQUE — takroriy yuborish DB darajasida to'siladi va
 * DLR shu (BIZNING) id bo'yicha moslanadi.
 */
@Entity({ name: 'sms_outbox' })
@Index('IDX_SMS_OUTBOX_RETRY', ['status', 'next_retry_at'])
@Index('IDX_SMS_OUTBOX_CREATED', ['created_at'])
export class SmsOutbox {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: SmsOutboxStatus;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ type: 'integer', default: 0 })
  retry_count!: number;

  @Column({ type: 'integer', default: 3 })
  max_attempts!: number;

  @Column({ type: 'text', nullable: true })
  last_error!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  last_response!: Record<string, unknown> | null;

  @Column({ type: 'timestamptz', nullable: true })
  next_retry_at!: Date | null;

  /** +998XXXXXXXXX */
  @Column({ type: 'varchar', length: 16 })
  to_phone!: string;

  @Column({ type: 'text' })
  text!: string;

  @Column({ type: 'varchar', length: 16 })
  message_class!: SmsMessageClass;

  @Column({ type: 'varchar', length: 64, nullable: true })
  template_code!: string | null;

  @Column({ type: 'integer' })
  parts!: number;

  @Column({ type: 'varchar', length: 8 })
  encoding!: SmsEncoding;

  @Column({ type: 'varchar', length: 32 })
  provider!: string;

  @Column({ type: 'varchar', length: 16, default: 'default' })
  sender_profile!: SmsSenderProfile;

  @Index('UQ_SMS_OUTBOX_CLIENT_MESSAGE_ID', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  client_message_id!: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  provider_message_id!: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  dlr_status!: SmsDlrStatus | null;

  @Column({ type: 'timestamptz', nullable: true })
  dlr_at!: Date | null;

  /** So'm. Tarif sozlanmagan bo'lsa NULL ("tarif sozlanmagan"), 0 emas. */
  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true })
  cost!: string | null;

  @Column({ type: 'bigint', nullable: true })
  notification_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  campaign_id!: string | null;

  /** Reklama tungi taqiqqa tushsa — ertangi taqiq tugash vaqtiga surilgan. */
  @Column({ type: 'timestamptz' })
  scheduled_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  sent_at!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updated_at!: Date;
}
