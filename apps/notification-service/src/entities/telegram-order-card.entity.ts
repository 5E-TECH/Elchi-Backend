import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * (h9newLsd #5 / ysBqD9Nx #4) Chatga yuborilgan buyurtma KARTASI — holat
 * o'zgarganda yangi xabar emas, shu xabar tahrirlanadi (BeePost
 * `create_bot_messages` / `syncStatusButton` naqshi). Bitta (buyurtma, chat)
 * uchun eng oxirgi karta.
 *  - `kind` — `courier` (shaxsiy chat, PII bilan) | `group` (market guruhi).
 */
@Entity({ name: 'telegram_order_cards' })
@Index('IDX_TG_ORDER_CARDS_UPDATED', ['updated_at'])
export class TelegramOrderCard {
  @PrimaryColumn({ type: 'bigint' })
  order_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 64 })
  chat_id!: string;

  /**
   * NULL — guruh kartasi «yuborilmoqda» (BOT-3 #4, migratsiya 1716000000191):
   * joy band qilingan, xabar hali outbox navbatida; yuborilgach outbox o'zi
   * yozadi.
   */
  @Column({ type: 'bigint', nullable: true })
  message_id!: string | null;

  @Column({ type: 'varchar', length: 16 })
  kind!: string;

  @Column({ type: 'bigint', nullable: true })
  actor_user_id!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  status!: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updated_at!: Date;
}
