import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type ConsentChannel = 'sms' | 'push';
export type ConsentSource = 'shartnoma' | 'veb-forma' | 'buyurtma' | 'operator';
export const CONSENT_SOURCES: readonly ConsentSource[] = [
  'shartnoma',
  'veb-forma',
  'buyurtma',
  'operator',
];

/**
 * Reklama roziligi (sVByLMnt #1). Darvoza FAIL-CLOSED: qator yo'q, bekor
 * qilingan (revoked_at), muddati o'tgan yoki raqam boshqa mijozga o'tgan
 * (customer_id mos emas) bo'lsa — reklama YUBORILMAYDI.
 */
@Entity({ name: 'customer_consent' })
@Index('IDX_CUSTOMER_CONSENT_PHONE_CHANNEL', ['phone', 'channel'])
export class CustomerConsent {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  /** +998XXXXXXXXX */
  @Column({ type: 'varchar', length: 16 })
  phone!: string;

  /** Rozilik bergan mijoz (identity id). Raqam boshqa odamga o'tsa rozilik amal qilmaydi. */
  @Column({ type: 'bigint', nullable: true })
  customer_id!: string | null;

  @Column({ type: 'varchar', length: 8, default: 'sms' })
  channel!: ConsentChannel;

  @Column({ type: 'boolean', default: true })
  granted!: boolean;

  @Column({ type: 'varchar', length: 16 })
  source!: ConsentSource;

  @Column({ type: 'timestamptz' })
  granted_at!: Date;

  /** IP / qurilma / operator id — dalil. */
  @Column({ type: 'jsonb', nullable: true })
  evidence!: Record<string, unknown> | null;

  @Column({ type: 'timestamptz', nullable: true })
  revoked_at!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updated_at!: Date;
}
