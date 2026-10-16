import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** `user` — shaxsiy chatni akkauntga; `market_group` — guruhni marketga. */
export type TelegramLinkPurpose = 'user' | 'market_group';
export type TelegramLinkScope = 'private' | 'group';

/**
 * (6jXw0DDr / 4TfLyTrL / 9uNhwTZp) Bir martalik bog'lash kodi — PANELDAN
 * boshlanadi: `t.me/<bot>?start=<kod>` (shaxsiy) yoki `?startgroup=<kod>`
 * (guruh). Kodning o'zi saqlanmaydi — faqat SHA-256 (`token_hash`), TTL 10
 * daqiqa, `used_at` ATOMIK shartli UPDATE bilan band qilinadi (ikki
 * parallel `/start` dan faqat bittasi o'tadi).
 *
 * `group_token-<raqam>` (market id = sir) va uzoq yashovchi market tokeni
 * bilan matnli ulash olib tashlandi.
 */
@Entity({ name: 'telegram_link_tokens' })
@Index('IDX_TG_LINK_TOKENS_EXPIRES', ['expires_at'])
export class TelegramLinkToken {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  token_hash!: string;

  @Column({ type: 'varchar', length: 16 })
  purpose!: TelegramLinkPurpose;

  /** Kim ulanadi: foydalanuvchi roli (`courier`, `market`, …) yoki `market`. */
  @Column({ type: 'varchar', length: 24 })
  owner_type!: string;

  /** `user` — foydalanuvchi id; `market_group` — market id. */
  @Column({ type: 'bigint' })
  owner_id!: string;

  @Column({ type: 'varchar', length: 8 })
  chat_scope!: TelegramLinkScope;

  @Column({ type: 'varchar', length: 16, nullable: true })
  group_type!: string | null;

  @Column({ type: 'timestamptz' })
  expires_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  used_at!: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  used_chat_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  created_by!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  created_ip!: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at!: Date;

  @Column({ name: 'is_deleted', type: 'boolean', default: false })
  isDeleted!: boolean;
}
