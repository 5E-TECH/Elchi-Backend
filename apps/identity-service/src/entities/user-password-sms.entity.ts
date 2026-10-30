import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { PasswordSmsStatus } from '@app/common';

export type PasswordSmsReason = 'create' | 'resend';

/**
 * (aidsxJ2H, migratsiya 1716000000194) Vaqtinchalik parol SMS'lari jurnali:
 * qayta yuborish chegarasi (60 s / kuniga 5) va yetkazish holati
 * (`client_message_id` → notification `sms_outbox`). PAROL YOZILMAYDI —
 * faqat kimga, kim so'radi, qachon va holat.
 */
@Entity({ name: 'user_password_sms', schema: 'identity_schema' })
@Index('IDX_USER_PASSWORD_SMS_USER_CREATED', ['user_id', 'created_at'])
export class UserPasswordSms {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'bigint' })
  user_id!: string;

  @Column({ type: 'varchar', length: 64, unique: true })
  client_message_id!: string;

  @Column({ type: 'varchar', length: 16 })
  reason!: PasswordSmsReason;

  @Column({ type: 'bigint', nullable: true })
  requested_by!: string | null;

  /** Oxirgi ma'lum holat (jonli holat notification'dan o'qilib yangilanadi). */
  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: PasswordSmsStatus;

  @Column({ type: 'varchar', length: 64, nullable: true })
  failure_reason!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updated_at!: Date;
}
