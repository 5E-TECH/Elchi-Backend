import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * (GL2GgtEc #1) Bot cheklovlari hisoblagichi — Postgres'da, chunki
 * xotiradagi Map ko'p replikada ishlamaydi (BeePost xatosi).
 *
 * `bucket` — `in:<chat_id>` (kiruvchi 20/daqiqa) yoki `link:<from_id>`
 * (bog'lash kodi 5/daqiqa, oshsa 15 daqiqa blok — `blocked_until`).
 */
@Entity({ name: 'telegram_rate_limits' })
@Index('IDX_TG_RATE_LIMITS_UPDATED', ['updated_at'])
export class TelegramRateLimit {
  @PrimaryColumn({ type: 'varchar', length: 96 })
  bucket!: string;

  @Column({ type: 'timestamptz' })
  window_start!: Date;

  @Column({ type: 'integer', default: 0 })
  hits!: number;

  @Column({ type: 'timestamptz', nullable: true })
  blocked_until!: Date | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updated_at!: Date;
}
