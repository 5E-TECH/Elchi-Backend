import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type PushPlatform = 'android' | 'ios' | 'desktop';

export const PUSH_PLATFORMS: readonly PushPlatform[] = [
  'android',
  'ios',
  'desktop',
];

/**
 * Bitta brauzer/qurilmaning Web Push obunasi (migratsiya 1716000000052).
 *
 * Yumshoq o'chirish YO'Q: obuna bekor qilinsa yoki provayder 404/410 qaytarsa
 * qator darhol o'chiriladi — o'lik endpointga yuborishning ma'nosi yo'q.
 * `endpoint` UNIQUE: qayta subscribe shu qatorni yangilaydi (id o'zgarmaydi).
 */
@Entity({ name: 'push_subscriptions' })
@Index('IDX_PUSH_SUBSCRIPTIONS_USER', ['user_id'])
@Index('IDX_PUSH_SUBSCRIPTIONS_USER_LAST_USED', ['user_id', 'last_used_at'])
export class PushSubscription {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  /** identity_schema user id. */
  @Column({ type: 'bigint' })
  user_id!: string;

  @Index('UQ_PUSH_SUBSCRIPTIONS_ENDPOINT', { unique: true })
  @Column({ type: 'text' })
  endpoint!: string;

  @Column({ type: 'text' })
  p256dh!: string;

  @Column({ type: 'text' })
  auth!: string;

  @Column({ type: 'varchar', length: 256, nullable: true })
  user_agent!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'desktop' })
  platform!: PushPlatform;

  @Column({ type: 'boolean', default: false })
  is_standalone!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  last_used_at!: Date | null;

  @Column({ type: 'text', nullable: true })
  last_error!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updated_at!: Date;
}
