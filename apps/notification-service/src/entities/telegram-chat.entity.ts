import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type TelegramChatType = 'private' | 'group' | 'channel';
export type TelegramChatOwnerType =
  | 'market'
  | 'market_operator'
  | 'courier'
  | 'branch'
  | 'user';

/**
 * (ysBqD9Nx #5) Umumlashtirilgan chat ↔ egasi bog'lanishi (migratsiya 126).
 * `telegram_markets` dan ko'chirilgan va trigger orqali sinxron
 * (`source_market_row_id`); `scope` — market guruhida `create` | `cancel`.
 * Guruh — faqat KO'RINISH joyi: huquq manbasi emas (callback'lar odam
 * bo'yicha tekshiriladi).
 */
@Entity({ name: 'telegram_chats' })
@Index('IDX_TELEGRAM_CHATS_CHAT', ['chat_id'])
export class TelegramChat {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  chat_id!: string;

  @Column({ type: 'varchar', length: 16 })
  chat_type!: TelegramChatType;

  @Column({ type: 'varchar', length: 24 })
  owner_type!: TelegramChatOwnerType;

  @Column({ type: 'bigint' })
  owner_id!: string;

  @Column({ type: 'varchar', length: 32, default: 'default' })
  scope!: string;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  linked_at!: Date;

  @Column({ type: 'bigint', nullable: true })
  linked_by!: string | null;

  @Column({ type: 'bigint', nullable: true })
  source_market_row_id!: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at!: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updated_at!: Date;
}
