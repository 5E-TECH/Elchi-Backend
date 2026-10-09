import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';
import { Group_type } from '@app/common';

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
   * Bot tokeni — MAXFIY (n0kLbx3d): `select: false`, API javoblarida hech
   * qachon qaytarilmaydi (faqat `has_token`). Kerakli o'qishlar uni ataylab
   * tanlaydi (`TG_MARKET_SELECT`).
   *
   * #3: DB'da SHIFRLANGAN (`enc:v1:…`, AES-256-GCM, tasodifiy IV) — shifrlash
   * servis qatlamida (`telegram-token.cipher.ts`), prefikssiz qiymat — eski
   * ochiq matn (start'dagi backfill shifrlaydi). Token bo'yicha WHERE qidiruv
   * QILINMAYDI. Ustun `character varying` (uzunliksiz) — shifr sig'adi,
   * migratsiya kerak emas.
   */
  @Column({ type: 'varchar', nullable: true, select: false })
  token!: string | null;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;
}
