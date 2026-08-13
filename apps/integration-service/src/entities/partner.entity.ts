import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

/**
 * Tashqi hamkor (birinchi navbatda Elchi Marketplace) — Elchi Partner API'dan
 * foydalanuvchi tizim. Hamkor har so'rovda `X-Api-Key` yuboradi; kalit bu yerda
 * HASH ko'rinishida saqlanadi (parol kabi). Chiquvchi (outbound) status
 * webhook'lari `webhook_secret` bilan HMAC-SHA256 imzolanadi.
 *
 * Batafsil kontrakt: docs/PARTNER_API.md.
 */
@Entity({ name: 'partners' })
@Index('IDX_PARTNER_API_KEY_HASH', ['api_key_hash'], { unique: true })
@Index('IDX_PARTNER_ACTIVE', ['is_active'])
export class Partner extends BaseEntity {
  @Column({ type: 'varchar' })
  name!: string;

  /** API kalitning hash'i (kalitning o'zi saqlanmaydi). Kirishda hash solishtiriladi. */
  @Column({ type: 'varchar', unique: true })
  api_key_hash!: string;

  /** Statuslarni qaytarish uchun hamkor webhook manzili (chiquvchi). */
  @Column({ type: 'varchar', nullable: true })
  webhook_url!: string | null;

  /** Chiquvchi webhook HMAC sekret. AES bilan shifrlangan holda saqlanadi. */
  @Column({ type: 'varchar', nullable: true })
  webhook_secret!: string | null;

  /** Rotatsiya oynasida qabul qilinadigan oldingi sekret. AES-shifrlangan. */
  @Column({ type: 'varchar', nullable: true })
  webhook_secret_previous!: string | null;

  /** Ixtiyoriy IP allowlist (bo'sh/null = cheklovsiz). */
  @Column({ type: 'jsonb', nullable: true })
  ip_allowlist!: string[] | null;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;
}
