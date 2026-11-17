import { BaseEntity } from '@app/common';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * «AI kalit va modellar» jadvallari (`ai_schema`), migratsiya 228.
 *
 * ⚠️ MAXFIYLIK: `AiProviderKey.secret_enc` — shifrmatn; HECH QACHON javobga,
 * auditga (`logChange` ishlatilmaydi), logga chiqmaydi. `select: false` —
 * oddiy `find()` uni o'qimaydi; faqat `ai-key-reader.ts` aniq so'raydi.
 */
@Entity({ name: 'ai_provider_keys', schema: 'ai_schema' })
export class AiProviderKey {
  /** Shifrlashdan OLDIN yaratiladi (AAD). */
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'is_deleted', type: 'boolean', default: false })
  isDeleted!: boolean;

  @Column({ type: 'varchar', length: 16, default: 'anthropic' })
  provider!: 'anthropic';

  @Column({ type: 'varchar', length: 16 })
  status!: 'active' | 'previous' | 'retired';

  @Column({ type: 'varchar', length: 60, nullable: true })
  label!: string | null;

  @Column({ type: 'text', nullable: true, select: false })
  secret_enc!: string | null;

  @Column({ type: 'varchar', length: 8 })
  key_hint!: string;

  @Column({ type: 'varchar', length: 16 })
  fingerprint!: string;

  @Column({ type: 'varchar', length: 16, default: 'unverified' })
  verify_state!: string;

  @Column({ type: 'varchar', length: 8, default: 'verify' })
  verify_origin!: 'verify' | 'runtime';

  @Column({ type: 'varchar', length: 40, nullable: true })
  verify_error_code!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  verified_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  rejected_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_used_at!: Date | null;

  @Column({ type: 'varchar', length: 64 })
  created_by!: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  created_by_name!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  retired_at!: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  retired_by!: string | null;
}

/** `keys` | `models` | `model_catalog` | `env_key_check`. */
@Entity({ name: 'ai_runtime_settings', schema: 'ai_schema' })
export class AiRuntimeSetting extends BaseEntity {
  @Column({ type: 'varchar', length: 64, unique: true })
  key!: string;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  value!: Record<string, unknown>;

  @Column({ type: 'int', default: 1 })
  version!: number;

  @Column({ type: 'varchar', length: 64, nullable: true })
  updated_by!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  updated_by_name!: string | null;
}

@Entity({ name: 'ai_config_attempts', schema: 'ai_schema' })
export class AiConfigAttempt {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  requester_id!: string;

  @Column({ type: 'varchar', length: 16 })
  kind!: 'key' | 'catalog';

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at!: Date;
}
