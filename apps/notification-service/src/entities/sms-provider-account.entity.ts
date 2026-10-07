import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { SmsSenderProfile } from '../sms/sms.port';

/**
 * SMS provayder akkaunti (8auPBa1O #2, rkz0yBxr #7).
 *
 * Login/parol FAQAT shifrlangan (`enc:gcm:...`, SMS_CREDENTIAL_SECRET) — SELECT
 * bilan ochiq matn ko'rinmaydi. `sender_profile`: 'default' (transaksion/reklama)
 * va 'otp' — OTP alohida akkaunt/alfa-nomdan ketadi, reklama bloki login
 * oqimini o'ldirmasin.
 */
@Entity({ name: 'sms_provider_accounts' })
@Index('UQ_SMS_PROVIDER_ACCOUNT', ['provider', 'sender_profile'], {
  unique: true,
})
export class SmsProviderAccount {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'varchar', length: 32 })
  provider!: string;

  @Column({ type: 'varchar', length: 16, default: 'default' })
  sender_profile!: SmsSenderProfile;

  @Column({ type: 'text' })
  login_enc!: string;

  @Column({ type: 'text' })
  password_enc!: string;

  /** Provayderda tasdiqlangan alfa-nom (masalan "ELCHI"). */
  @Column({ type: 'varchar', length: 32 })
  sender!: string;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  @Column({ type: 'bigint', nullable: true })
  updated_by!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updated_at!: Date;
}
