import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';
import { Group_type } from '@app/common';

/** (G085w5Qr) `telegram_markets.inactive_reason` qiymatlari. */
export type TelegramMarketInactiveReason =
  | 'kicked'
  | 'left'
  | 'blocked_on_send'
  | 'chat_not_found'
  | 'manual';

@Entity({ name: 'telegram_markets' })
@Index('IDX_TG_MARKET_ID', ['market_id'])
@Index('IDX_TG_GROUP_TYPE', ['group_type'])
@Index('IDX_TG_MARKET_GROUP', ['market_id', 'group_type'])
export class TelegramMarket extends BaseEntity {
  @Column({ type: 'bigint' })
  market_id!: string;

  @Column({ type: 'varchar' })
  group_id!: string;

  @Column({ type: 'enum', enum: Group_type })
  group_type!: Group_type;

  /**
   * (bOMYoOtV #4) Eski `token` ustuni IKKIGA bo'lindi (migratsiya
   * 1716000000120 eski qiymatlarni NULL qildi, ustun endi o'qilmaydi/yozilmaydi):
   *  - `connect_token_hash` — bir martalik ulash siri (SHA-256), ishlatilgach
   *    NULL. MAXFIY: `select: false`.
   *  - `bot_slug` — qaysi bot yuboradi (sir EMAS). NULL — env'dagi yagona bot
   *    (`TELEGRAM_BOT_SLUG`). Bot TOKENI bazada UMUMAN saqlanmaydi.
   */
  @Column({ type: 'varchar', length: 64, nullable: true, select: false })
  connect_token_hash!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  bot_slug!: string | null;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  /**
   * (G085w5Qr) Nofaol bo'lish sababi (migratsiya 1716000000150): bot
   * aniqlagan 'kicked' | 'left' | 'blocked_on_send' | 'chat_not_found' yoki
   * admin qo'lda o'chirgan 'manual'. Faollashtirilganda NULL.
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  inactive_reason!: TelegramMarketInactiveReason | null;

  /** (G085w5Qr) Qachon nofaol bo'ldi; faol qatorda NULL. */
  @Column({ type: 'timestamptz', nullable: true })
  inactive_at!: Date | null;
}
