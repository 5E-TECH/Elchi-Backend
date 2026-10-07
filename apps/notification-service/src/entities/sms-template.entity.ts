import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { SmsMessageClass } from '../sms/sms.port';

export type SmsLanguage = 'uz' | 'ru' | 'en';
export const SMS_LANGUAGES: readonly SmsLanguage[] = ['uz', 'ru', 'en'];

/**
 * SMS shablonlari reyestri (nkhURiKX #2). UNIQUE (code, lang).
 * Matn o'zgarsa `provider_template_id` bo'shatiladi — operator qayta tasdiqlashi
 * kerak (reklama tasdiqlanmagan shablondan ketsa akkaunt bloklanadi).
 */
@Entity({ name: 'sms_templates' })
@Index('UQ_SMS_TEMPLATE_CODE_LANG', ['code', 'lang'], { unique: true })
export class SmsTemplate {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  code!: string;

  @Column({ type: 'varchar', length: 16 })
  message_class!: SmsMessageClass;

  @Column({ type: 'varchar', length: 2, default: 'uz' })
  lang!: SmsLanguage;

  @Column({ type: 'text' })
  text!: string;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  required_vars!: string[];

  @Column({ type: 'varchar', length: 64, nullable: true })
  provider_template_id!: string | null;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updated_at!: Date;
}
