import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type OtpPurpose = 'login' | 'phone_verify';
export const OTP_PURPOSES: readonly OtpPurpose[] = ['login', 'phone_verify'];

/**
 * Bir martalik tasdiq kodi (rkz0yBxr #1, migratsiya 1716000000056).
 * OCHIQ KOD SAQLANMAYDI — faqat HMAC hash.
 */
@Entity({ name: 'otp_codes', schema: 'identity_schema' })
@Index('IDX_OTP_CODES_PHONE_PURPOSE_CREATED', [
  'phone',
  'purpose',
  'created_at',
])
export class OtpCode {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  /** +998XXXXXXXXX */
  @Column({ type: 'varchar', length: 16 })
  phone!: string;

  @Column({ type: 'varchar', length: 128 })
  code_hash!: string;

  @Column({ type: 'varchar', length: 16 })
  purpose!: OtpPurpose;

  @Index('IDX_OTP_CODES_EXPIRES')
  @Column({ type: 'timestamptz' })
  expires_at!: Date;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ type: 'integer', default: 5 })
  max_attempts!: number;

  @Column({ type: 'timestamptz', nullable: true })
  consumed_at!: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ip!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  created_at!: Date;
}
